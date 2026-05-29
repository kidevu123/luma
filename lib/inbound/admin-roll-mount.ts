// ROLL-INTAKE-UX-LEGACY-1 — mount a newly received roll from admin intake.
// Mirrors floor mountRollAction invariants without requiring a station token.

import { eq, sql } from "drizzle-orm";
import { packagingLots, materialInventoryEvents } from "@/lib/db/schema";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import {
  withAccountabilityPayload,
  type AccountabilityForEvent,
} from "@/lib/production/station-operator-session";
import { rollRoleForMaterialKind } from "@/lib/inbound/roll-receive-batch";
import type { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function assertNoConflictingMountedRoll(
  tx: Tx,
  machineId: string,
  materialKind: string,
): Promise<string | null> {
  const role = rollRoleForMaterialKind(materialKind);
  const existing = await tx.execute<{
    packaging_lot_id: string;
    roll_number: string | null;
  }>(sql`
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
             pl.roll_number
        FROM latest_event le
        JOIN packaging_lots pl ON pl.id = le.packaging_lot_id
        JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
       WHERE le.event_type = 'ROLL_MOUNTED'
         AND le.machine_id = ${machineId}
         AND (le.payload->>'roll_role') = ${role}
         AND pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    `);
  const conflict = (existing as unknown as Array<{
    packaging_lot_id: string;
    roll_number: string | null;
  }>)[0];
  if (conflict) {
    return `A ${role} roll (${conflict.roll_number ?? conflict.packaging_lot_id}) is already mounted on this machine. Unmount it first.`;
  }
  return null;
}

export async function adminMountRollLot(
  tx: Tx,
  args: {
    lotId: string;
    packagingMaterialId: string;
    materialKind: string;
    netWeightGrams: number;
    previousStatus: string;
    machineId: string;
    stationId: string;
    actorUserId: string;
    accountability: AccountabilityForEvent;
    notes?: string | null;
  },
): Promise<void> {
  const role = rollRoleForMaterialKind(args.materialKind);
  await tx.insert(materialInventoryEvents).values({
    eventType: "ROLL_MOUNTED",
    packagingMaterialId: args.packagingMaterialId,
    packagingLotId: args.lotId,
    machineId: args.machineId,
    stationId: args.stationId,
    actorUserId: args.actorUserId,
    quantityGrams: args.netWeightGrams,
    unitOfMeasure: "g",
    payload: withAccountabilityPayload(
      {
        roll_role: role,
        starting_weight_grams: args.netWeightGrams,
        previous_status: args.previousStatus,
        notes: args.notes ?? null,
        mounted_via: "admin.receive_roll_batch",
      },
      args.accountability,
    ),
    source: "admin.receive_roll_batch",
  });
  await tx
    .update(packagingLots)
    .set({ status: "IN_USE" })
    .where(eq(packagingLots.id, args.lotId));
  await rebuildMaterialLotState(tx);
  await rebuildRollUsage(tx);
}
