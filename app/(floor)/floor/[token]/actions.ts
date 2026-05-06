"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  qrCards,
  stations,
  workflowBags,
  inventoryBags,
  batches,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";

// Floor JSON paths are anonymous (no Authentik). Authorization is via
// the station's scan_token in the URL. Card scan creates a workflow
// bag + CARD_ASSIGNED event in one transaction. Every workflow_event
// goes through projectEvent() so read_station_live + read_bag_state
// are correct the moment the action returns.

const scanSchema = z.object({
  stationId: z.string().uuid(),
  cardId: z.string().uuid(),
});

export async function scanCardAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = scanSchema.safeParse({
    stationId: formData.get("stationId"),
    cardId: formData.get("cardId"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { stationId, cardId } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [station] = await tx
        .select()
        .from(stations)
        .where(eq(stations.id, stationId));
      if (!station) throw new Error("Station not found.");
      const [card] = await tx.select().from(qrCards).where(eq(qrCards.id, cardId));
      if (!card) throw new Error("Card not found.");
      if (card.status !== "IDLE") {
        throw new Error(`Card already ${card.status.toLowerCase()}.`);
      }
      const [bag] = await tx
        .insert(workflowBags)
        .values({})
        .returning();
      if (!bag) throw new Error("Could not create workflow bag.");
      await tx
        .update(qrCards)
        .set({ status: "ASSIGNED", assignedWorkflowBagId: bag.id })
        .where(eq(qrCards.id, cardId));
      await projectEvent(tx, {
        workflowBagId: bag.id,
        stationId: station.id,
        eventType: "CARD_ASSIGNED",
        payload: { qr_card_id: cardId, station_kind: station.kind },
      });
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "floor.card_assigned",
          targetType: "WorkflowBag",
          targetId: bag.id,
          after: { card_id: cardId, station_id: stationId },
        },
        tx,
      );
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Scan failed." };
  }

  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

const eventSchema = z.object({
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  eventType: z.enum([
    "BLISTER_COMPLETE",
    "SEALING_COMPLETE",
    "PACKAGING_SNAPSHOT",
    "BOTTLE_HANDPACK_COMPLETE",
    "BOTTLE_CAP_SEAL_COMPLETE",
    "BOTTLE_STICKER_COMPLETE",
  ]),
  countTotal: z.coerce.number().int().min(0).max(100000).optional(),
});

export async function fireStageEventAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = eventSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    eventType: formData.get("eventType"),
    countTotal: formData.get("countTotal") || 0,
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { workflowBagId, stationId, eventType, countTotal } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType,
        payload: countTotal ? { count_total: countTotal } : {},
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Event failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── Pause / Resume ─────────────────────────────────────────────────────────
//
// Real workflow nuance: PVC roll runs out, shift ends, operator
// gets pulled away. The bag stays "claimed" by the station but
// time stops counting toward cycle. Resume picks it back up.

const pauseSchema = z.object({
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  reason: z.enum(["pvc_swap", "shift_end", "machine_jam", "qa_check", "other"]),
  operatorCode: z.string().max(40).optional(),
  notes: z.string().max(400).optional(),
});

export async function pauseBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = pauseSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    reason: formData.get("reason") || "other",
    operatorCode: formData.get("operatorCode") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_PAUSED",
        payload: {
          reason: parsed.data.reason,
          ...(parsed.data.operatorCode
            ? { operator_code: parsed.data.operatorCode }
            : {}),
          ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
        },
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Pause failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

const resumeSchema = z.object({
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  operatorCode: z.string().max(40).optional(),
});

export async function resumeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = resumeSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    operatorCode: formData.get("operatorCode") || undefined,
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_RESUMED",
        payload: parsed.data.operatorCode
          ? { operator_code: parsed.data.operatorCode }
          : {},
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Resume failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── Operator handoff ───────────────────────────────────────────────────────

const operatorSchema = z.object({
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  operatorCode: z.string().min(1).max(40),
});

export async function setOperatorAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = operatorSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    operatorCode: formData.get("operatorCode"),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "OPERATOR_CHANGE",
        payload: { operator_code: parsed.data.operatorCode },
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── Vendor barcode verification (optional pre-claim check) ────────────────
//
// Operator types or scans the manufacturer's existing barcode/lot.
// We look it up against inventory_bags and confirm the underlying
// batch is RELEASED. Gates a wrong-batch claim from making it past
// blister.

const verifySchema = z.object({
  vendorBarcode: z.string().min(1).max(120),
});

export async function verifyVendorBarcodeAction(
  formData: FormData,
): Promise<
  | {
      ok: true;
      inventoryBagId: string;
      tabletName?: string;
      batchNumber?: string;
      batchStatus: "RELEASED" | "QUARANTINE" | "ON_HOLD" | "RECALLED" | "EXPIRED" | "DEPLETED";
      blocked: boolean;
      reason?: string;
    }
  | { error: string }
> {
  const parsed = verifySchema.safeParse({
    vendorBarcode: formData.get("vendorBarcode"),
  });
  if (!parsed.success) return { error: "Invalid barcode." };
  const code = parsed.data.vendorBarcode.trim();
  // Try per-bag barcode first (set if receiving-side captures
  // unique barcodes), otherwise fall back to matching the lot
  // number on the batch — works out of the box because vendor lot
  // numbers are already captured per receive box.
  let hit = (
    await db
      .select({
        inventoryBagId: inventoryBags.id,
        bagStatus: inventoryBags.status,
        batchId: inventoryBags.batchId,
      })
      .from(inventoryBags)
      .where(eq(inventoryBags.vendorBarcode, code))
      .limit(1)
  )[0];
  if (!hit) {
    // Lot-number fallback. Multiple bags may share a lot, so we
    // grab the first AVAILABLE one and surface batch info — a
    // good-enough verification that the batch is RELEASED.
    const lotMatch = await db
      .select({
        inventoryBagId: inventoryBags.id,
        bagStatus: inventoryBags.status,
        batchId: inventoryBags.batchId,
      })
      .from(inventoryBags)
      .innerJoin(batches, eq(inventoryBags.batchId, batches.id))
      .where(
        and(
          eq(batches.vendorLotNumber, code),
          eq(inventoryBags.status, "AVAILABLE"),
        ),
      )
      .limit(1);
    hit = lotMatch[0];
  }
  if (!hit) return { error: "No inventory bag matches that barcode/lot." };
  if (hit.bagStatus !== "AVAILABLE") {
    return {
      ok: true,
      inventoryBagId: hit.inventoryBagId,
      batchStatus: "QUARANTINE",
      blocked: true,
      reason: `Bag status is ${hit.bagStatus}, not AVAILABLE.`,
    };
  }
  let batchStatus:
    | "RELEASED"
    | "QUARANTINE"
    | "ON_HOLD"
    | "RECALLED"
    | "EXPIRED"
    | "DEPLETED" = "QUARANTINE";
  let batchNumber: string | undefined;
  if (hit.batchId) {
    const [b] = await db
      .select({ status: batches.status, batchNumber: batches.batchNumber })
      .from(batches)
      .where(eq(batches.id, hit.batchId))
      .limit(1);
    if (b) {
      batchStatus = b.status;
      batchNumber = b.batchNumber;
    }
  }
  const blocked = batchStatus !== "RELEASED";
  return {
    ok: true,
    inventoryBagId: hit.inventoryBagId,
    ...(batchNumber ? { batchNumber } : {}),
    batchStatus,
    blocked,
    ...(blocked
      ? { reason: `Batch ${batchNumber ?? ""} is ${batchStatus}, not RELEASED.` }
      : {}),
  };
}

// ── Packaging complete (rich payload) ──────────────────────────────────────

const packagingCompleteSchema = z.object({
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  masterCases: z.coerce.number().int().min(0).max(100000),
  displaysMade: z.coerce.number().int().min(0).max(100000),
  looseCards: z.coerce.number().int().min(0).max(100000),
  damagedPackaging: z.coerce.number().int().min(0).max(100000),
  rippedCards: z.coerce.number().int().min(0).max(100000),
  operatorCode: z.string().max(40).optional(),
});

export async function packagingCompleteAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = packagingCompleteSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    masterCases: formData.get("masterCases") || 0,
    displaysMade: formData.get("displaysMade") || 0,
    looseCards: formData.get("looseCards") || 0,
    damagedPackaging: formData.get("damagedPackaging") || 0,
    rippedCards: formData.get("rippedCards") || 0,
    operatorCode: formData.get("operatorCode") || undefined,
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          master_cases: parsed.data.masterCases,
          displays_made: parsed.data.displaysMade,
          loose_cards: parsed.data.looseCards,
          damaged_packaging: parsed.data.damagedPackaging,
          ripped_cards: parsed.data.rippedCards,
          ...(parsed.data.operatorCode
            ? { operator_code: parsed.data.operatorCode }
            : {}),
        },
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

export async function finalizeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const workflowBagId = String(formData.get("workflowBagId") ?? "");
  if (!z.string().uuid().safeParse(workflowBagId).success) return { error: "Invalid bag." };
  try {
    await db.transaction(async (tx) => {
      // projectEvent will:
      //   - insert workflow_events row (partial unique index enforces
      //     at-most-once-finalize)
      //   - update read_bag_state to FINALIZED
      //   - clear read_station_live for this bag
      //   - set workflow_bags.finalized_at
      //   - release qr_cards back to IDLE
      await projectEvent(tx, {
        workflowBagId,
        eventType: "BAG_FINALIZED",
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Finalize failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}
