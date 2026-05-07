"use server";

// Phase H.x4 — Floor server actions for PVC/foil roll lifecycle.
//
// Three actions:
//   • mountRollAction   — bind a roll lot to a machine
//   • unmountRollAction — release the roll, optionally with a final
//                         weigh-back
//   • weighRollAction   — record a current weight without unmounting
//
// Authorization: scan_token (URL-bound, station-owned). Same pattern
// as fireStageEventAction etc. The action validates that the form's
// stationId matches the token's station before doing anything.
//
// Validation: every input is parsed through zod. State-machine
// invariants live in pure helpers in lib/production/active-rolls.ts
// so they can be unit-tested without a DB.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  stations,
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import { nextLotStatusForUnmount } from "@/lib/production/active-rolls";

// Same UUID-v4-ish pattern used in actions.ts. The floor PWA passes
// a clientEventId so a network retry doesn't double-fire. We persist
// it on the material_inventory_events row for idempotency.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLL_KINDS = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"] as const;

type StationRow = typeof stations.$inferSelect;
type LotRow = {
  id: string;
  status: string;
  roll_number: string | null;
  net_weight_grams: number | null;
  current_weight_grams_estimate: number | null;
  packaging_material_id: string;
  kind: string;
};

async function authStation(token: string, stationIdFromForm: string): Promise<StationRow> {
  if (!UUID_RE.test(token)) throw new Error("Invalid station token.");
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) throw new Error("Station mismatch.");
  return station;
}

async function loadRollLot(lotId: string): Promise<LotRow | null> {
  const rows = await db.execute<LotRow>(sql`
    SELECT lot.id::text                   AS id,
           lot.status::text                AS status,
           lot.roll_number                 AS roll_number,
           lot.net_weight_grams            AS net_weight_grams,
           lot.current_weight_grams_estimate AS current_weight_grams_estimate,
           lot.packaging_material_id::text AS packaging_material_id,
           pm.kind::text                   AS kind
      FROM packaging_lots lot
      JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
     WHERE lot.id = ${lotId}
     LIMIT 1
  `);
  const list = rows as unknown as LotRow[];
  return list[0] ?? null;
}

async function findLotByRollNumberOrId(input: {
  packagingLotId?: string;
  rollNumber?: string;
}): Promise<LotRow | null> {
  if (input.packagingLotId) return loadRollLot(input.packagingLotId);
  if (input.rollNumber) {
    // Most-recent active lot with this roll number. Roll numbers are
    // expected to be unique among active rolls (admin form enforces
    // uniqueness on receive); pick the latest just in case.
    const rows = await db.execute<LotRow>(sql`
      SELECT lot.id::text                   AS id,
             lot.status::text                AS status,
             lot.roll_number                 AS roll_number,
             lot.net_weight_grams            AS net_weight_grams,
             lot.current_weight_grams_estimate AS current_weight_grams_estimate,
             lot.packaging_material_id::text AS packaging_material_id,
             pm.kind::text                   AS kind
        FROM packaging_lots lot
        JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
       WHERE lot.roll_number = ${input.rollNumber}
       ORDER BY lot.received_at DESC
       LIMIT 1
    `);
    const list = rows as unknown as LotRow[];
    return list[0] ?? null;
  }
  return null;
}

// ── mountRollAction ───────────────────────────────────────────────

const mountSchema = z
  .object({
    token: z.string().regex(UUID_RE, "Invalid token."),
    stationId: z.string().uuid(),
    packagingLotId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).max(80).optional(),
    role: z.enum(["PVC", "FOIL"]),
    workflowBagId: z.string().uuid().optional().nullable().or(z.literal("")),
    startingWeightGrams: z.coerce.number().int().min(1).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    clientEventId: z.string().regex(UUID_RE, "Invalid client event id.").optional(),
  })
  .refine((d) => d.packagingLotId != null || (d.rollNumber != null && d.rollNumber !== ""), {
    message: "Roll number or lot id is required.",
    path: ["packagingLotId"],
  });

export async function mountRollAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string; lotId?: string; rollNumber?: string }> {
  const parsed = mountSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    packagingLotId: formData.get("packagingLotId") || undefined,
    rollNumber: formData.get("rollNumber") || undefined,
    role: formData.get("role"),
    workflowBagId: formData.get("workflowBagId") || undefined,
    startingWeightGrams: formData.get("startingWeightGrams") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    const station = await authStation(d.token, d.stationId);
    if (!station.machineId) return { error: "Station is not bound to a machine." };

    const lot = await findLotByRollNumberOrId({
      ...(d.packagingLotId != null ? { packagingLotId: d.packagingLotId } : {}),
      ...(d.rollNumber != null ? { rollNumber: d.rollNumber } : {}),
    });
    if (!lot) return { error: "Roll lot not found." };
    if (!ROLL_KINDS.includes(lot.kind as (typeof ROLL_KINDS)[number])) {
      return { error: "This material is not a roll." };
    }
    if (lot.status === "HELD" || lot.status === "SCRAPPED") {
      return { error: `Roll is ${lot.status.toLowerCase()} — cannot mount.` };
    }
    if (lot.status === "DEPLETED") {
      return { error: "Roll is depleted — cannot mount." };
    }
    if (lot.status === "IN_USE") {
      return { error: "Roll is already mounted — unmount it first." };
    }
    // Reject second active roll of the same role on this machine.
    // The check uses the latest event per lot pattern so a recently
    // unmounted-but-not-yet-rebuilt lot isn't double-counted.
    const existing = await db.execute<{ packaging_lot_id: string; roll_number: string | null; role: string | null }>(sql`
      WITH latest_event AS (
        SELECT DISTINCT ON (ev.packaging_lot_id)
          ev.packaging_lot_id,
          ev.event_type,
          ev.machine_id,
          ev.payload
        FROM material_inventory_events ev
        WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED')
        ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
      )
      SELECT le.packaging_lot_id::text,
             pl.roll_number,
             (le.payload->>'roll_role') AS role
        FROM latest_event le
        JOIN packaging_lots pl ON pl.id = le.packaging_lot_id
        JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
       WHERE le.event_type = 'ROLL_MOUNTED'
         AND le.machine_id = ${station.machineId}
         AND (le.payload->>'roll_role') = ${d.role}
         AND pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    `);
    const conflictList = existing as unknown as Array<{
      packaging_lot_id: string;
      roll_number: string | null;
      role: string | null;
    }>;
    if (conflictList.length > 0) {
      const r = conflictList[0]!;
      return {
        error: `A ${d.role} roll (${r.roll_number ?? r.packaging_lot_id}) is already mounted on this machine. Unmount it first.`,
      };
    }

    const startingWeight = d.startingWeightGrams ?? lot.net_weight_grams;
    const workflowBagId = d.workflowBagId && d.workflowBagId !== "" ? d.workflowBagId : null;

    await db.transaction(async (tx) => {
      await tx.insert(materialInventoryEvents).values({
        eventType: "ROLL_MOUNTED",
        packagingMaterialId: lot.packaging_material_id,
        packagingLotId: lot.id,
        machineId: station.machineId,
        stationId: station.id,
        ...(workflowBagId ? { workflowBagId } : {}),
        ...(startingWeight != null ? { quantityGrams: startingWeight } : {}),
        unitOfMeasure: "g",
        payload: {
          roll_role: d.role,
          starting_weight_grams: startingWeight,
          previous_status: lot.status,
          notes: d.notes ?? null,
        },
        source: "floor.mount_roll",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });
      await tx
        .update(packagingLots)
        .set({ status: "IN_USE" })
        .where(eq(packagingLots.id, lot.id));
      await rebuildMaterialLotState(tx);
      await rebuildRollUsage(tx);
      try {
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "ROLL_MOUNTED",
            targetType: "packaging_lot",
            targetId: lot.id,
            after: { role: d.role, machine_id: station.machineId },
          },
          tx,
        );
      } catch {
        // audit FK-dependent on user — ignore in floor anonymous case
      }
    });

    revalidatePath(`/floor/${d.token}/rolls`);
    return { ok: true, lotId: lot.id, rollNumber: lot.roll_number ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Mount failed." };
  }
}

// ── unmountRollAction ─────────────────────────────────────────────

const unmountSchema = z
  .object({
    token: z.string().regex(UUID_RE, "Invalid token."),
    stationId: z.string().uuid(),
    packagingLotId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).max(80).optional(),
    endingWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    clientEventId: z.string().regex(UUID_RE, "Invalid client event id.").optional(),
  })
  .refine((d) => d.packagingLotId != null || (d.rollNumber != null && d.rollNumber !== ""), {
    message: "Roll number or lot id is required.",
    path: ["packagingLotId"],
  });

export async function unmountRollAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string; status?: string }> {
  const parsed = unmountSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    packagingLotId: formData.get("packagingLotId") || undefined,
    rollNumber: formData.get("rollNumber") || undefined,
    endingWeightGrams: formData.get("endingWeightGrams") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    const station = await authStation(d.token, d.stationId);
    if (!station.machineId) return { error: "Station is not bound to a machine." };

    const lot = await findLotByRollNumberOrId({
      ...(d.packagingLotId != null ? { packagingLotId: d.packagingLotId } : {}),
      ...(d.rollNumber != null ? { rollNumber: d.rollNumber } : {}),
    });
    if (!lot) return { error: "Roll lot not found." };
    if (!ROLL_KINDS.includes(lot.kind as (typeof ROLL_KINDS)[number])) {
      return { error: "This material is not a roll." };
    }
    if (lot.status !== "IN_USE") {
      return { error: `Roll is not currently mounted (status=${lot.status}).` };
    }
    // Verify this machine actually holds the lot. If a roll was
    // mounted on machine A and the operator scans it from machine B,
    // refuse — the operator must scan from the right station.
    const lastMount = await db.execute<{ machine_id: string | null }>(sql`
      SELECT machine_id::text AS machine_id
        FROM material_inventory_events
       WHERE packaging_lot_id = ${lot.id}
         AND event_type = 'ROLL_MOUNTED'
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1
    `);
    const lastMachine = (lastMount as unknown as Array<{ machine_id: string | null }>)[0]
      ?.machine_id;
    if (lastMachine && lastMachine !== station.machineId) {
      return { error: "This roll is mounted on a different machine. Unmount from there." };
    }

    const nextStatus = nextLotStatusForUnmount({
      endingWeightGrams: d.endingWeightGrams ?? null,
    });

    await db.transaction(async (tx) => {
      // Optional weigh-back first so deriveRollUsage etc. see it.
      if (d.endingWeightGrams != null) {
        await tx.insert(materialInventoryEvents).values({
          eventType: "ROLL_WEIGHED",
          packagingMaterialId: lot.packaging_material_id,
          packagingLotId: lot.id,
          machineId: station.machineId,
          stationId: station.id,
          quantityGrams: d.endingWeightGrams,
          unitOfMeasure: "g",
          payload: {
            previous_weight_estimate: lot.current_weight_grams_estimate,
            current_weight: d.endingWeightGrams,
            weight_unit: "g",
            confidence: "HIGH",
            source: "unmount.weigh_back",
          },
          source: "floor.unmount_roll",
          ...(d.clientEventId ? { clientEventId: `${d.clientEventId}-w` } : {}),
        });
      }
      await tx.insert(materialInventoryEvents).values({
        eventType: "ROLL_UNMOUNTED",
        packagingMaterialId: lot.packaging_material_id,
        packagingLotId: lot.id,
        machineId: station.machineId,
        stationId: station.id,
        ...(d.endingWeightGrams != null ? { quantityGrams: d.endingWeightGrams } : {}),
        unitOfMeasure: "g",
        payload: {
          ending_weight_grams: d.endingWeightGrams ?? null,
          weight_unit: "g",
          confidence: d.endingWeightGrams != null ? "HIGH" : "MEDIUM",
          notes: d.notes ?? null,
        },
        source: "floor.unmount_roll",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });
      await tx
        .update(packagingLots)
        .set(
          d.endingWeightGrams != null
            ? { status: nextStatus, currentWeightGramsEstimate: d.endingWeightGrams }
            : { status: nextStatus },
        )
        .where(eq(packagingLots.id, lot.id));
      await rebuildMaterialLotState(tx);
      await rebuildRollUsage(tx);
      try {
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "ROLL_UNMOUNTED",
            targetType: "packaging_lot",
            targetId: lot.id,
            after: {
              ending_weight_grams: d.endingWeightGrams ?? null,
              new_status: nextStatus,
            },
          },
          tx,
        );
      } catch {
        // anon floor — best effort
      }
    });

    revalidatePath(`/floor/${d.token}/rolls`);
    return { ok: true, status: nextStatus };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unmount failed." };
  }
}

// ── weighRollAction ───────────────────────────────────────────────

const weighSchema = z
  .object({
    token: z.string().regex(UUID_RE, "Invalid token."),
    stationId: z.string().uuid(),
    packagingLotId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).max(80).optional(),
    currentWeightGrams: z.coerce.number().int().min(1, "Weight must be > 0"),
    notes: z.string().max(500).optional().nullable(),
    clientEventId: z.string().regex(UUID_RE, "Invalid client event id.").optional(),
  })
  .refine((d) => d.packagingLotId != null || (d.rollNumber != null && d.rollNumber !== ""), {
    message: "Roll number or lot id is required.",
    path: ["packagingLotId"],
  });

export async function weighRollAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string; varianceGrams?: number | null }> {
  const parsed = weighSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    packagingLotId: formData.get("packagingLotId") || undefined,
    rollNumber: formData.get("rollNumber") || undefined,
    currentWeightGrams: formData.get("currentWeightGrams"),
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    const station = await authStation(d.token, d.stationId);
    if (!station.machineId) return { error: "Station is not bound to a machine." };

    const lot = await findLotByRollNumberOrId({
      ...(d.packagingLotId != null ? { packagingLotId: d.packagingLotId } : {}),
      ...(d.rollNumber != null ? { rollNumber: d.rollNumber } : {}),
    });
    if (!lot) return { error: "Roll lot not found." };
    if (!ROLL_KINDS.includes(lot.kind as (typeof ROLL_KINDS)[number])) {
      return { error: "This material is not a roll." };
    }

    const previousEstimate = lot.current_weight_grams_estimate;
    const variance = previousEstimate != null ? d.currentWeightGrams - previousEstimate : null;

    await db.transaction(async (tx) => {
      await tx.insert(materialInventoryEvents).values({
        eventType: "ROLL_WEIGHED",
        packagingMaterialId: lot.packaging_material_id,
        packagingLotId: lot.id,
        machineId: station.machineId,
        stationId: station.id,
        quantityGrams: d.currentWeightGrams,
        unitOfMeasure: "g",
        payload: {
          previous_weight_estimate: previousEstimate,
          current_weight: d.currentWeightGrams,
          weight_unit: "g",
          variance_from_estimate: variance,
          confidence: "HIGH",
          notes: d.notes ?? null,
        },
        source: "floor.weigh_roll",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });
      await tx
        .update(packagingLots)
        .set({ currentWeightGramsEstimate: d.currentWeightGrams })
        .where(eq(packagingLots.id, lot.id));
      await rebuildRollUsage(tx);
      try {
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "ROLL_WEIGHED",
            targetType: "packaging_lot",
            targetId: lot.id,
            after: {
              current_weight_grams: d.currentWeightGrams,
              variance_grams: variance,
            },
          },
          tx,
        );
      } catch {
        // anon floor — best effort
      }
    });

    revalidatePath(`/floor/${d.token}/rolls`);
    return { ok: true, varianceGrams: variance };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Weigh failed." };
  }
}
