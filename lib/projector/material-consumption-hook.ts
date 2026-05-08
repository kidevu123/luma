// Phase VALIDATION-2C — Roll segment ledger emission on BLISTER_COMPLETE.
//
// When a BLISTER_COMPLETE event fires:
//   1. Find the active mounted PVC + foil rolls for the station's
//      machine.
//   2. Read the counter SEGMENT from payload.count_total (the field
//      the existing fireStageEventAction writes for BLISTER_COMPLETE).
//      The operator resets the physical machine counter between
//      segments; the value they enter at BLISTER_COMPLETE is the
//      count for that final segment of the bag (NOT a bag total or a
//      lifetime counter). The payload key is named `count_total` for
//      historical reasons — keep it stable to avoid orphaning legacy
//      events.
//   3. For each active roll role (PVC and FOIL), emit one
//      ROLL_COUNTER_SEGMENT_RECORDED event with:
//        • workflow_bag_id, machine_id, station_id
//        • roll_role
//        • material_lot_id (the active roll's lot)
//        • counter_segment_count
//        • segment_reason = 'BAG_COMPLETE'
//        • bag_segment_sequence = nth segment for this bag so far
//        • roll_segment_sequence = nth segment for this roll so far
//        • active_bag_total_after_segment = SUM(bag's segments)
//        • roll_total_after_segment = SUM(roll's segments)
//        • confidence (HIGH if counter > 0, MISSING otherwise)
//
// What this hook DOES NOT do:
//   • Emit MATERIAL_CONSUMED_ESTIMATED. Counter segments are not
//     weight consumption. Weight is derived later from segments ×
//     configured/learned grams-per-blister, OR from net weight ÷
//     total roll yield once the roll is depleted.
//   • Reset counters or maintain segment numbering on the operator
//     side. The operator resets the physical machine counter; we
//     just record the value they entered.
//
// Honest skip rules (same as before):
//   • No count_total or counter <= 0 → skip emission silently
//   • No active roll for the role → skip that role's emission
//   • Standard / weight inputs are no longer required for emission

import { sql, eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  materialInventoryEvents,
  workflowBags,
  stations,
} from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type ActiveRollRow = {
  packaging_lot_id: string;
  packaging_material_id: string;
  material_kind: string;
  role: "PVC" | "FOIL";
};

export async function emitMaterialConsumedFromBlister(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
    upstreamClientEventId?: string | null;
  },
): Promise<void> {
  // Resolve machine + product context.
  const [stationRow] = await tx
    .select({ machineId: stations.machineId })
    .from(stations)
    .where(eq(stations.id, args.stationId));
  const machineId = stationRow?.machineId ?? null;
  if (!machineId) return;
  const [bagRow] = await tx
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId));
  const productId = bagRow?.productId ?? null;

  // Counter segment from the event payload. The fireStageEventAction
  // writes this under `count_total`; we accept `machine_count` as an
  // alias for forward-compatibility but `count_total` wins if both are
  // present.
  const rawCount = args.payload?.["count_total"] ?? args.payload?.["machine_count"];
  const counterSegment =
    typeof rawCount === "number"
      ? Math.trunc(rawCount)
      : typeof rawCount === "string" && rawCount !== ""
        ? Math.trunc(Number(rawCount))
        : null;
  if (counterSegment == null || !Number.isFinite(counterSegment) || counterSegment <= 0) {
    return; // no counter — skip silently
  }

  // Active mounted rolls for this machine via "latest event per lot" pattern.
  const activeRolls = await tx.execute<ActiveRollRow>(sql`
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
    SELECT
      lot.id::text                    AS packaging_lot_id,
      lot.packaging_material_id::text AS packaging_material_id,
      pm.kind::text                   AS material_kind,
      COALESCE(
        (le.payload->>'roll_role'),
        CASE pm.kind::text
          WHEN 'PVC_ROLL'    THEN 'PVC'
          WHEN 'FOIL_ROLL'   THEN 'FOIL'
          WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END
      ) AS role
    FROM packaging_lots lot
    JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
    JOIN latest_event le ON le.packaging_lot_id = lot.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND le.machine_id = ${machineId}
      AND lot.status = 'IN_USE'
      AND pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
  `);
  const rolls = (activeRolls as unknown as ActiveRollRow[]).filter(
    (r) => r.role === "PVC" || r.role === "FOIL",
  );
  if (rolls.length === 0) return;

  // Compute bag and per-roll sequence + running totals BEFORE this segment.
  type CountRow = { n: number; total: number };
  const bagPriorRows = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND workflow_bag_id = ${args.workflowBagId}
  `)) as unknown as CountRow[];
  const bagPriorCount = bagPriorRows[0]?.n ?? 0;
  const bagPriorTotal = bagPriorRows[0]?.total ?? 0;
  const bagSegmentSequence = bagPriorCount + 1;
  const activeBagTotalAfterSegment = bagPriorTotal + counterSegment;

  // For each roll, emit a segment event.
  for (const roll of rolls) {
    const rollPriorRows = (await tx.execute<CountRow>(sql`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
      FROM material_inventory_events
      WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
        AND packaging_lot_id = ${roll.packaging_lot_id}
    `)) as unknown as CountRow[];
    const rollPriorCount = rollPriorRows[0]?.n ?? 0;
    const rollPriorTotal = rollPriorRows[0]?.total ?? 0;
    const rollSegmentSequence = rollPriorCount + 1;
    const rollTotalAfterSegment = rollPriorTotal + counterSegment;

    await tx.insert(materialInventoryEvents).values({
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      packagingMaterialId: roll.packaging_material_id,
      packagingLotId: roll.packaging_lot_id,
      ...(productId ? { productId } : {}),
      workflowBagId: args.workflowBagId,
      machineId,
      stationId: args.stationId,
      quantityUnits: counterSegment,
      unitOfMeasure: "blisters",
      occurredAt: args.occurredAt,
      payload: {
        roll_role: roll.role,
        material_lot_id: roll.packaging_lot_id,
        counter_segment_count: counterSegment,
        segment_reason: "BAG_COMPLETE",
        bag_segment_sequence: bagSegmentSequence,
        roll_segment_sequence: rollSegmentSequence,
        active_bag_total_after_segment: activeBagTotalAfterSegment,
        roll_total_after_segment: rollTotalAfterSegment,
        product_id: productId,
        machine_id: machineId,
        workflow_bag_id: args.workflowBagId,
        confidence: "HIGH",
      },
      source: "projector.blister_complete_hook",
      ...(args.upstreamClientEventId
        ? { clientEventId: `${args.upstreamClientEventId}-${roll.role.toLowerCase()}` }
        : {}),
    });
  }
}
