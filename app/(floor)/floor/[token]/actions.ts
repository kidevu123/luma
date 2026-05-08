"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  qrCards,
  stations,
  workflowBags,
  inventoryBags,
  batches,
  readBagState,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";

// Floor PWA actions are anonymous (no admin login). Authorization is
// the station's scan_token, which lives in the URL. Every action MUST
// take the token, look up the station, and then refuse if the
// stationId in the form doesn't match the URL's station — otherwise
// any anonymous client could POST events to any station by hand.

type StationRow = typeof stations.$inferSelect;

/** Resolve and lock a station by its URL scan token. Returns null
 *  if no match — caller should reject the request. */
async function resolveStation(token: string): Promise<StationRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return null;
  }
  const [row] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  return row ?? null;
}

/** Compose the per-action wrapper: validate token + stationId
 *  matches, return the resolved station so the action can use it. */
async function authStation(
  token: string,
  stationIdFromForm: string,
): Promise<StationRow> {
  const station = await resolveStation(token);
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) {
    // Token doesn't own the station the form is targeting — block.
    throw new Error("Station mismatch.");
  }
  return station;
}

// UUID v4-ish pattern for the floor-side idempotency token. Optional
// on the action (legacy clients won't send it), but when present we
// pass it through to projectEvent so a network retry hits the partial
// unique index instead of double-firing the stage.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clientEventIdField = z
  .string()
  .regex(UUID_RE, "Invalid client event id.")
  .optional();

function pickClientEventId(formData: FormData): string | undefined {
  const raw = formData.get("clientEventId");
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return UUID_RE.test(raw) ? raw : undefined;
}

// Allowed event types per station kind. SEALING can't fire blister,
// PACKAGING can't fire bottle stages, etc. COMBINED is permissive
// (still card flow only).
const ALLOWED_EVENTS_BY_KIND: Record<string, string[]> = {
  BLISTER: ["BLISTER_COMPLETE"],
  SEALING: ["SEALING_COMPLETE"],
  PACKAGING: ["PACKAGING_SNAPSHOT", "PACKAGING_COMPLETE"],
  BOTTLE_HANDPACK: ["BOTTLE_HANDPACK_COMPLETE"],
  BOTTLE_CAP_SEAL: ["BOTTLE_CAP_SEAL_COMPLETE"],
  BOTTLE_STICKER: ["BOTTLE_STICKER_COMPLETE"],
  COMBINED: [
    "BLISTER_COMPLETE",
    "SEALING_COMPLETE",
    "PACKAGING_SNAPSHOT",
    "PACKAGING_COMPLETE",
  ],
};

// ── scan card ──────────────────────────────────────────────────────────────

const scanSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  cardId: z.string().uuid(),
});

export async function scanCardAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = scanSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    cardId: formData.get("cardId"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { token, stationId, cardId } = parsed.data;

  try {
    const station = await authStation(token, stationId);
    await db.transaction(async (tx) => {
      // FOR UPDATE prevents the IDLE→ASSIGNED race where two
      // concurrent scanners both pass the IDLE check.
      await tx.execute(
        sql`SELECT 1 FROM qr_cards WHERE id = ${cardId} FOR UPDATE`,
      );
      const [card] = await tx
        .select()
        .from(qrCards)
        .where(eq(qrCards.id, cardId));
      if (!card) throw new Error("Card not found.");
      if (card.status !== "IDLE") {
        throw new Error(`Card already ${card.status.toLowerCase()}.`);
      }
      const [bag] = await tx.insert(workflowBags).values({}).returning();
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

  revalidatePath(`/floor/${token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── stage events ───────────────────────────────────────────────────────────

const eventSchema = z.object({
  token: z.string(),
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
  clientEventId: clientEventIdField,
});

import { checkStageProgression } from "@/lib/production/stage-progression";

export async function fireStageEventAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = eventSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    eventType: formData.get("eventType"),
    countTotal: formData.get("countTotal") || 0,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { token, workflowBagId, stationId, eventType, countTotal, clientEventId } =
    parsed.data;

  try {
    const station = await authStation(token, stationId);
    // Wrong-stage guard: each station kind maps to a fixed set of
    // allowed events. Stops a SEALING station from firing
    // BLISTER_COMPLETE if someone hand-crafts FormData.
    const allowed = ALLOWED_EVENTS_BY_KIND[station.kind] ?? [];
    if (!allowed.includes(eventType)) {
      return {
        error: `Station kind ${station.kind} can't fire ${eventType}.`,
      };
    }
    // Refuse if the bag is currently paused — operator must Resume
    // first. Stops phantom completes on a paused bag.
    const [state] = await db
      .select({
        isPaused: readBagState.isPaused,
        isFinalized: readBagState.isFinalized,
        stage: readBagState.stage,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    // Stage-progression guard: this is what stops a duplicate
    // BLISTER_COMPLETE landing on the same bag from a stale-looking
    // screen. The bag must be at the predecessor stage. Same helper
    // is consumed by the floor UI so server + client stay in sync.
    const progression = checkStageProgression({
      eventType,
      currentStage: state?.stage ?? null,
      isPaused: state?.isPaused ?? false,
      isFinalized: state?.isFinalized ?? false,
    });
    if (!progression.allowed) {
      return { error: progression.reason };
    }

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType,
        payload: countTotal ? { count_total: countTotal } : {},
        ...(clientEventId ? { clientEventId } : {}),
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Event failed." };
  }
  revalidatePath(`/floor/${token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── pause / resume ─────────────────────────────────────────────────────────

const pauseSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  reason: z.enum(["pvc_swap", "shift_end", "machine_jam", "qa_check", "other"]),
  operatorCode: z.string().max(40).optional(),
  notes: z.string().max(400).optional(),
  clientEventId: clientEventIdField,
});

export async function pauseBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = pauseSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    reason: formData.get("reason") || "other",
    operatorCode: formData.get("operatorCode") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
    // Refuse double-pause — second BAG_PAUSED corrupts the
    // pause-time accumulation in the projector.
    const [state] = await db
      .select({ isPaused: readBagState.isPaused, isFinalized: readBagState.isFinalized })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (state?.isFinalized) return { error: "Bag is already finalized." };
    if (state?.isPaused) return { error: "Bag is already paused." };

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
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Pause failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

const resumeSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  operatorCode: z.string().max(40).optional(),
  clientEventId: clientEventIdField,
});

export async function resumeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = resumeSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    operatorCode: formData.get("operatorCode") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
    const [state] = await db
      .select({ isPaused: readBagState.isPaused })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (!state?.isPaused) return { error: "Bag isn't paused." };

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_RESUMED",
        payload: parsed.data.operatorCode
          ? { operator_code: parsed.data.operatorCode }
          : {},
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Resume failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── operator handoff ───────────────────────────────────────────────────────

const operatorSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  operatorCode: z.string().min(1).max(40),
});

export async function setOperatorAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = operatorSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    operatorCode: formData.get("operatorCode"),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
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
  revalidatePath(`/floor/${parsed.data.token}`);
  return { ok: true };
}

// ── vendor barcode verify (read-only lookup) ──────────────────────────────

const verifySchema = z.object({
  token: z.string(),
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
      batchStatus:
        | "RELEASED"
        | "QUARANTINE"
        | "ON_HOLD"
        | "RECALLED"
        | "EXPIRED"
        | "DEPLETED";
      blocked: boolean;
      reason?: string;
    }
  | { error: string }
> {
  const parsed = verifySchema.safeParse({
    token: formData.get("token"),
    vendorBarcode: formData.get("vendorBarcode"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const station = await resolveStation(parsed.data.token);
  if (!station) return { error: "Invalid station." };
  const code = parsed.data.vendorBarcode.trim();
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

// ── packaging close-out ────────────────────────────────────────────────────

const packagingCompleteSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  masterCases: z.coerce.number().int().min(0).max(100000),
  displaysMade: z.coerce.number().int().min(0).max(100000),
  looseCards: z.coerce.number().int().min(0).max(100000),
  damagedPackaging: z.coerce.number().int().min(0).max(100000),
  rippedCards: z.coerce.number().int().min(0).max(100000),
  operatorCode: z.string().max(40).optional(),
  clientEventId: clientEventIdField,
});

export async function packagingCompleteAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = packagingCompleteSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    masterCases: formData.get("masterCases") || 0,
    displaysMade: formData.get("displaysMade") || 0,
    looseCards: formData.get("looseCards") || 0,
    damagedPackaging: formData.get("damagedPackaging") || 0,
    rippedCards: formData.get("rippedCards") || 0,
    operatorCode: formData.get("operatorCode") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    if (station.kind !== "PACKAGING" && station.kind !== "COMBINED") {
      return {
        error: `Station kind ${station.kind} can't fire PACKAGING_COMPLETE.`,
      };
    }
    // Reject all-zeros — operator probably tapped Save by accident.
    if (
      parsed.data.masterCases +
        parsed.data.displaysMade +
        parsed.data.looseCards +
        parsed.data.damagedPackaging +
        parsed.data.rippedCards ===
      0
    ) {
      return { error: "Enter at least one count before saving." };
    }
    // Stage-progression guard — same rule as fireStageEventAction.
    const [pkgState] = await db
      .select({
        isPaused: readBagState.isPaused,
        isFinalized: readBagState.isFinalized,
        stage: readBagState.stage,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    const pkgProg = checkStageProgression({
      eventType: "PACKAGING_COMPLETE",
      currentStage: pkgState?.stage ?? null,
      isPaused: pkgState?.isPaused ?? false,
      isFinalized: pkgState?.isFinalized ?? false,
    });
    if (!pkgProg.allowed) return { error: pkgProg.reason };
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
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── finalize ───────────────────────────────────────────────────────────────

const finalizeSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  clientEventId: clientEventIdField,
});

export async function finalizeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = finalizeSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success) return { error: "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
    const [state] = await db
      .select({ isFinalized: readBagState.isFinalized })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (state?.isFinalized) return { error: "Bag is already finalized." };

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_FINALIZED",
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Finalize failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}
