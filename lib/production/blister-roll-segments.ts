import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  materialInventoryEvents,
  stations,
  workflowBags,
} from "@/lib/db/schema";
import {
  type AccountabilityForEvent,
  withAccountabilityPayload,
} from "@/lib/production/station-operator-session";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type ActiveRollRow = {
  packaging_lot_id: string;
  packaging_material_id: string;
  material_kind: string;
  role: "PVC" | "FOIL";
};

type SegmentReason =
  | "BAG_COMPLETE"
  | "ROLL_CHANGE"
  | "PAUSE_SNAPSHOT"
  | "SHIFT_END_SNAPSHOT";

export async function recordBlisterCounterRollSegment(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    counterSegmentCount: number;
    segmentReason: SegmentReason;
    source: string;
    sourceAction: string;
    occurredAt?: Date;
    notes?: string | null;
    formClientEventId?: string | null;
    accountability: AccountabilityForEvent;
  },
): Promise<{ segmentGroupId: string | null; segmentsRecorded: number }> {
  const counterSegment = Math.trunc(args.counterSegmentCount);
  if (!Number.isFinite(counterSegment) || counterSegment <= 0) {
    return { segmentGroupId: null, segmentsRecorded: 0 };
  }

  const [stationRow] = await tx
    .select({ machineId: stations.machineId })
    .from(stations)
    .where(eq(stations.id, args.stationId));
  const machineId = stationRow?.machineId ?? null;
  if (!machineId) return { segmentGroupId: null, segmentsRecorded: 0 };

  const [bagRow] = await tx
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId));
  const productId = bagRow?.productId ?? null;

  const activeRolls = await tx.execute<ActiveRollRow>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.event_type,
        ev.machine_id,
        ev.payload
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED','ROLL_DEPLETED')
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT
      lot.id::text                    AS packaging_lot_id,
      lot.packaging_material_id::text AS packaging_material_id,
      pm.kind::text                   AS material_kind,
      COALESCE(
        (le.payload->>'roll_role'),
        CASE pm.kind::text
          WHEN 'PVC_ROLL'     THEN 'PVC'
          WHEN 'FOIL_ROLL'    THEN 'FOIL'
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
  if (rolls.length === 0) return { segmentGroupId: null, segmentsRecorded: 0 };

  type CountRow = { n: number; total: number };
  const bagPriorRows = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND workflow_bag_id = ${args.workflowBagId}
  `)) as unknown as CountRow[];
  const bagSegmentSequence = (bagPriorRows[0]?.n ?? 0) + 1;
  const activeBagTotalAfterSegment =
    (bagPriorRows[0]?.total ?? 0) + counterSegment;
  const segmentGroupId = randomUUID();
  let segmentsRecorded = 0;

  for (const roll of rolls) {
    const rollPriorRows = (await tx.execute<CountRow>(sql`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
      FROM material_inventory_events
      WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
        AND packaging_lot_id = ${roll.packaging_lot_id}
    `)) as unknown as CountRow[];
    const rollSegmentSequence = (rollPriorRows[0]?.n ?? 0) + 1;
    const rollTotalAfterSegment =
      (rollPriorRows[0]?.total ?? 0) + counterSegment;

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
      ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
      payload: withAccountabilityPayload(
        {
          roll_role: roll.role,
          material_lot_id: roll.packaging_lot_id,
          counter_segment_count: counterSegment,
          segment_reason: args.segmentReason,
          bag_segment_sequence: bagSegmentSequence,
          roll_segment_sequence: rollSegmentSequence,
          active_bag_total_after_segment: activeBagTotalAfterSegment,
          roll_total_after_segment: rollTotalAfterSegment,
          product_id: productId,
          machine_id: machineId,
          workflow_bag_id: args.workflowBagId,
          confidence: "HIGH",
          notes: args.notes ?? null,
          segment_group_id: segmentGroupId,
          source_action: args.sourceAction,
          form_client_event_id: args.formClientEventId ?? null,
        },
        args.accountability,
      ),
      source: args.source,
    });
    segmentsRecorded += 1;
  }

  return { segmentGroupId, segmentsRecorded };
}
