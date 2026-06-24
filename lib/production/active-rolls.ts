// Phase H.x4 — Active-roll query helper.
//
// Resolves which PVC/foil rolls are currently mounted on a given
// machine. Authoritative source: packaging_lots.status = 'IN_USE'
// AND the most recent material_inventory_event for the lot is a
// ROLL_MOUNTED with the matching machine_id.
//
// The status flag alone is not sufficient — a lot can be IN_USE on
// machine A even if the operator forgot to unmount it. We resolve
// the most recent mount event per lot to make sure we report the
// correct machine. This logic is read-only; the server actions in
// app/(floor)/floor/[token]/roll-actions.ts are responsible for
// keeping status consistent.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inferRollRole } from "@/lib/production/roll-role";

export type ActiveRoll = {
  packagingLotId: string;
  packagingMaterialId: string;
  rollNumber: string | null;
  materialKind: string;
  materialName: string;
  /** "PVC" | "FOIL" inferred from material kind; payload override
   *  preferred if present so future product configurations can
   *  surface a different role label without renaming the kind. */
  role: "PVC" | "FOIL";
  machineId: string;
  stationId: string | null;
  mountedAt: string;
  startingWeightGrams: number | null;
  currentWeightEstimateGrams: number | null;
  lastWeighedAt: string | null;
  workflowBagId: string | null;
  /** HIGH if the lot has a recorded weigh-back since mount,
   *  MEDIUM if mounted with a known starting weight,
   *  LOW if mounted without a starting weight. */
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

/** Query the rolls actively mounted on a machine. Empty array =
 *  no rolls mounted (which the UI must surface honestly, not as a
 *  fake "everything is fine"). */
export async function getActiveRollsForMachine(
  machineId: string,
): Promise<ActiveRoll[]> {
  if (!machineId) return [];
  // The CTE pattern picks the latest material_inventory_events
  // row per lot via DISTINCT ON, then filters to those whose latest
  // event is ROLL_MOUNTED on the requested machine.
  const rows = await db.execute<{
    packaging_lot_id: string;
    packaging_material_id: string;
    roll_number: string | null;
    material_kind: string;
    material_name: string;
    machine_id: string;
    station_id: string | null;
    mounted_at: string;
    starting_weight_grams: number | null;
    current_weight_estimate_grams: number | null;
    last_weighed_at: string | null;
    workflow_bag_id: string | null;
    payload_role: string | null;
  }>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.event_type,
        ev.occurred_at,
        ev.machine_id,
        ev.station_id,
        ev.workflow_bag_id,
        ev.quantity_grams,
        ev.payload
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED')
        AND ev.packaging_lot_id IS NOT NULL
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    ),
    last_mount AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.occurred_at AS mounted_at,
        ev.machine_id,
        ev.station_id,
        ev.quantity_grams AS mount_starting_weight,
        ev.payload AS mount_payload,
        ev.workflow_bag_id
      FROM material_inventory_events ev
      WHERE ev.event_type = 'ROLL_MOUNTED'
        AND ev.packaging_lot_id IS NOT NULL
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    ),
    last_weigh AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.occurred_at AS last_weighed_at,
        ev.quantity_grams AS last_weigh_grams
      FROM material_inventory_events ev
      WHERE ev.event_type = 'ROLL_WEIGHED'
        AND ev.packaging_lot_id IS NOT NULL
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT
      lot.id::text                    AS packaging_lot_id,
      lot.packaging_material_id::text AS packaging_material_id,
      lot.roll_number                 AS roll_number,
      pm.kind::text                   AS material_kind,
      pm.name                         AS material_name,
      lm.machine_id::text             AS machine_id,
      lm.station_id::text             AS station_id,
      lm.mounted_at::text             AS mounted_at,
      COALESCE(lm.mount_starting_weight, lot.net_weight_grams) AS starting_weight_grams,
      COALESCE(lw.last_weigh_grams, lot.current_weight_grams_estimate) AS current_weight_estimate_grams,
      lw.last_weighed_at::text        AS last_weighed_at,
      lm.workflow_bag_id::text        AS workflow_bag_id,
      (lm.mount_payload->>'roll_role') AS payload_role
    FROM packaging_lots lot
    JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
    JOIN latest_event le ON le.packaging_lot_id = lot.id
    JOIN last_mount lm ON lm.packaging_lot_id = lot.id
    LEFT JOIN last_weigh lw ON lw.packaging_lot_id = lot.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND lm.machine_id = ${machineId}
      AND pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
      AND lot.status = 'IN_USE'
  `);

  type Row = {
    packaging_lot_id: string;
    packaging_material_id: string;
    roll_number: string | null;
    material_kind: string;
    material_name: string;
    machine_id: string;
    station_id: string | null;
    mounted_at: string;
    starting_weight_grams: number | null;
    current_weight_estimate_grams: number | null;
    last_weighed_at: string | null;
    workflow_bag_id: string | null;
    payload_role: string | null;
  };
  const list = rows as unknown as Row[];

  return list.map((r) => {
    const role = inferRollRole(r.material_kind, r.payload_role);
    const confidence: ActiveRoll["confidence"] =
      r.last_weighed_at != null
        ? "HIGH"
        : r.starting_weight_grams != null
          ? "MEDIUM"
          : "LOW";
    return {
      packagingLotId: r.packaging_lot_id,
      packagingMaterialId: r.packaging_material_id,
      rollNumber: r.roll_number,
      materialKind: r.material_kind,
      materialName: r.material_name,
      role,
      machineId: r.machine_id,
      stationId: r.station_id,
      mountedAt: r.mounted_at,
      startingWeightGrams: r.starting_weight_grams,
      currentWeightEstimateGrams: r.current_weight_estimate_grams,
      lastWeighedAt: r.last_weighed_at,
      workflowBagId: r.workflow_bag_id,
      confidence,
    };
  });
}

/** Pure helper used by the unmount action to decide the next lot
 *  status given an ending weight. Caller is responsible for handling
 *  null (no ending weight given) — the spec says: keep IN_USE→AVAILABLE
 *  without changing the weight, mark MEDIUM/LOW confidence. */
export function nextLotStatusForUnmount(input: {
  endingWeightGrams: number | null;
  depletedThresholdGrams?: number;
}): "AVAILABLE" | "DEPLETED" {
  const threshold = input.depletedThresholdGrams ?? 0;
  if (input.endingWeightGrams != null && input.endingWeightGrams <= threshold) {
    return "DEPLETED";
  }
  return "AVAILABLE";
}
