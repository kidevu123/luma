import { sql, eq, and, gt } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { materialInventoryEvents, stations, workflowEvents } from "@/lib/db/schema";
import {
  type CounterSnapshotContext,
  type RecentSegmentRow,
  type ValidateBlisterCounterSnapshotInput,
  firstCounterSnapshotBlocker,
  validateBlisterCounterSnapshot,
} from "@/lib/production/counter-snapshot-guard";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type ActiveRollRow = {
  packaging_lot_id: string;
  role: "PVC" | "FOIL";
};

export type CounterSnapshotGuardContext = Pick<
  ValidateBlisterCounterSnapshotInput,
  "activeRollLotIds" | "recentSegments"
>;

async function loadActiveBlisterRollLotIds(
  tx: Tx,
  stationId: string,
): Promise<string[]> {
  const [stationRow] = await tx
    .select({ machineId: stations.machineId })
    .from(stations)
    .where(eq(stations.id, stationId));
  const machineId = stationRow?.machineId ?? null;
  if (!machineId) return [];

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
      lot.id::text AS packaging_lot_id,
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

  return (activeRolls as unknown as ActiveRollRow[])
    .filter((row) => row.role === "PVC" || row.role === "FOIL")
    .map((row) => row.packaging_lot_id);
}

async function loadLastBagResumedAt(
  tx: Tx,
  workflowBagId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ occurredAt: workflowEvents.occurredAt })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        eq(workflowEvents.eventType, "BAG_RESUMED"),
      ),
    )
    .orderBy(sql`${workflowEvents.occurredAt} DESC`, sql`${workflowEvents.id} DESC`)
    .limit(1);
  return row?.occurredAt ?? null;
}

async function loadRecentBagSegments(
  tx: Tx,
  workflowBagId: string,
  since: Date | null,
): Promise<RecentSegmentRow[]> {
  const timeFilter = since
    ? gt(materialInventoryEvents.occurredAt, since)
    : undefined;

  const rows = await tx
    .select({
      segmentReason: sql<string>`payload->>'segment_reason'`,
      counterSegmentCount: sql<number>`(payload->>'counter_segment_count')::int`,
      packagingLotId: materialInventoryEvents.packagingLotId,
      segmentGroupId: sql<string | null>`payload->>'segment_group_id'`,
      oldLotId: sql<string | null>`payload->>'old_lot_id'`,
      newLotId: sql<string | null>`payload->>'new_lot_id'`,
      changedRole: sql<string | null>`payload->>'changed_role'`,
    })
    .from(materialInventoryEvents)
    .where(
      and(
        eq(materialInventoryEvents.eventType, "ROLL_COUNTER_SEGMENT_RECORDED"),
        eq(materialInventoryEvents.workflowBagId, workflowBagId),
        timeFilter,
      ),
    )
    .orderBy(
      sql`${materialInventoryEvents.occurredAt} DESC`,
      sql`${materialInventoryEvents.id} DESC`,
    );

  return rows.flatMap((row) => {
    if (!row.packagingLotId) return [];
    return [
      {
        segmentReason: row.segmentReason ?? "",
        counterSegmentCount: row.counterSegmentCount ?? 0,
        packagingLotId: row.packagingLotId,
        segmentGroupId: row.segmentGroupId,
        oldLotId: row.oldLotId,
        newLotId: row.newLotId,
        changedRole: row.changedRole,
      },
    ];
  });
}

export async function loadCounterSnapshotGuardContext(
  tx: Tx,
  args: { workflowBagId: string; stationId: string },
): Promise<CounterSnapshotGuardContext> {
  const lastBagResumedAt = await loadLastBagResumedAt(tx, args.workflowBagId);
  const [activeRollLotIds, recentSegments] = await Promise.all([
    loadActiveBlisterRollLotIds(tx, args.stationId),
    loadRecentBagSegments(tx, args.workflowBagId, lastBagResumedAt),
  ]);
  return { activeRollLotIds, recentSegments };
}

export async function assertCounterSnapshotAllowed(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    context: CounterSnapshotContext;
    submittedCount: number | null | undefined;
    allowZero: boolean;
    requirePositive: boolean;
    rollChange?: ValidateBlisterCounterSnapshotInput["rollChange"];
  },
): Promise<void> {
  const guardContext = await loadCounterSnapshotGuardContext(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
  });
  const result = validateBlisterCounterSnapshot({
    context: args.context,
    submittedCount: args.submittedCount,
    allowZero: args.allowZero,
    requirePositive: args.requirePositive,
    activeRollLotIds: guardContext.activeRollLotIds,
    recentSegments: guardContext.recentSegments,
    ...(args.rollChange ? { rollChange: args.rollChange } : {}),
  });
  const blocker = firstCounterSnapshotBlocker(result);
  if (blocker) {
    throw new Error(blocker);
  }
}
