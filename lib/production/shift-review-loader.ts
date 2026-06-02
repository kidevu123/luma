/** SHIFT-REVIEW-1 — read-only DB loader for post-shift review. */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  finishedLots,
  inventoryBags,
  materialInventoryEvents,
  packagingLots,
  products,
  readBagState,
  stations,
  tabletTypes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import {
  buildShiftReview,
  type ShiftReviewBagInput,
  type ShiftReviewPauseInput,
  type ShiftReviewResult,
  type ShiftReviewSegmentInput,
} from "@/lib/production/shift-review";

type DbClient = typeof Db;

const BLISTER_STATION_KINDS = ["BLISTER", "COMBINED"] as const;

export type LoadShiftReviewArgs = {
  from: Date;
  to: Date;
  label: string;
  stationId?: string | null;
  bagQuery?: string | null;
  flaggedOnly?: boolean;
};

type SegmentRow = {
  workflowBagId: string;
  segmentReason: string;
  counterSegmentCount: number;
  packagingLotId: string;
  rollRole: "PVC" | "FOIL" | null;
  segmentGroupId: string | null;
  oldLotId: string | null;
  newLotId: string | null;
  changedRole: string | null;
  occurredAt: Date;
  stationId: string | null;
};

type PauseRow = {
  workflowBagId: string;
  reason: string;
  counterSnapshotCount: number | null;
  counterSnapshotReason: string | null;
  occurredAt: Date;
  stationId: string | null;
};

type CloseOutRow = {
  workflowBagId: string;
  countTotal: number;
  occurredAt: Date;
  stationId: string | null;
};

type BagMetaRow = {
  workflowBagId: string;
  receiptNumber: string | null;
  bagNumber: string | null;
  productName: string | null;
  tabletTypeName: string | null;
  productKind: string | null;
  stage: string | null;
  isFinalized: boolean;
  isPaused: boolean;
  inventoryBagId: string | null;
  hasFinishedLot: boolean;
};

function mapSegmentPayload(row: {
  workflowBagId: string | null;
  packagingLotId: string | null;
  stationId: string | null;
  quantityUnits: number | null;
  occurredAt: Date;
  payload: Record<string, unknown> | null;
}): SegmentRow | null {
  if (!row.workflowBagId || !row.packagingLotId) return null;
  const payload = row.payload ?? {};
  const segmentReason =
    typeof payload["segment_reason"] === "string" ? payload["segment_reason"] : null;
  const counterSegmentCount =
    typeof payload["counter_segment_count"] === "number"
      ? payload["counter_segment_count"]
      : row.quantityUnits;
  if (!segmentReason || counterSegmentCount == null) return null;
  const rollRoleRaw = payload["roll_role"];
  const rollRole =
    rollRoleRaw === "PVC" || rollRoleRaw === "FOIL" ? rollRoleRaw : null;
  return {
    workflowBagId: row.workflowBagId,
    segmentReason,
    counterSegmentCount,
    packagingLotId: row.packagingLotId,
    rollRole,
    segmentGroupId:
      typeof payload["segment_group_id"] === "string" ? payload["segment_group_id"] : null,
    oldLotId: typeof payload["old_lot_id"] === "string" ? payload["old_lot_id"] : null,
    newLotId: typeof payload["new_lot_id"] === "string" ? payload["new_lot_id"] : null,
    changedRole:
      typeof payload["changed_role"] === "string" ? payload["changed_role"] : null,
    occurredAt: row.occurredAt,
    stationId: row.stationId,
  };
}

async function loadBlisterStationIds(
  db: DbClient,
  stationId?: string | null,
): Promise<Array<{ id: string; name: string; kind: string; machineId: string | null }>> {
  const conditions = [inArray(stations.kind, [...BLISTER_STATION_KINDS])];
  if (stationId) {
    conditions.push(eq(stations.id, stationId));
  }
  return db
    .select({
      id: stations.id,
      name: stations.label,
      kind: stations.kind,
      machineId: stations.machineId,
    })
    .from(stations)
    .where(and(...conditions));
}

async function loadActiveRollLotIdsForMachine(
  db: DbClient,
  machineId: string,
): Promise<string[]> {
  const rows = await db.execute<{ packaging_lot_id: string }>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.event_type
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED','ROLL_DEPLETED')
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT lot.id::text AS packaging_lot_id
    FROM latest_event le
    JOIN packaging_lots lot ON lot.id = le.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND pm.kind IN ('PVC_ROLL', 'FOIL_ROLL', 'BLISTER_FOIL')
      AND EXISTS (
        SELECT 1 FROM material_inventory_events mount
        WHERE mount.packaging_lot_id = lot.id
          AND mount.event_type = 'ROLL_MOUNTED'
          AND mount.machine_id = ${machineId}::uuid
      )
  `);
  return rows.map((row) => row.packaging_lot_id);
}

export async function loadShiftReview(
  db: DbClient,
  args: LoadShiftReviewArgs,
): Promise<ShiftReviewResult> {
  const blisterStations = await loadBlisterStationIds(db, args.stationId);
  const stationIds = blisterStations.map((station) => station.id);
  const stationById = new Map(blisterStations.map((station) => [station.id, station]));

  if (stationIds.length === 0) {
    return buildShiftReview({
      window: { from: args.from, to: args.to, label: args.label },
      bags: [],
      stationCount: 0,
    });
  }

  const segmentRows = await db
    .select({
      workflowBagId: materialInventoryEvents.workflowBagId,
      packagingLotId: materialInventoryEvents.packagingLotId,
      stationId: materialInventoryEvents.stationId,
      quantityUnits: materialInventoryEvents.quantityUnits,
      occurredAt: materialInventoryEvents.occurredAt,
      payload: materialInventoryEvents.payload,
    })
    .from(materialInventoryEvents)
    .where(
      and(
        eq(materialInventoryEvents.eventType, "ROLL_COUNTER_SEGMENT_RECORDED"),
        inArray(materialInventoryEvents.stationId, stationIds),
        gte(materialInventoryEvents.occurredAt, args.from),
        lte(materialInventoryEvents.occurredAt, args.to),
      ),
    );

  const pauseRows = await db
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      payload: workflowEvents.payload,
      occurredAt: workflowEvents.occurredAt,
      stationId: workflowEvents.stationId,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.eventType, "BAG_PAUSED"),
        inArray(workflowEvents.stationId, stationIds),
        gte(workflowEvents.occurredAt, args.from),
        lte(workflowEvents.occurredAt, args.to),
      ),
    );

  const closeOutRows = await db
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      payload: workflowEvents.payload,
      occurredAt: workflowEvents.occurredAt,
      stationId: workflowEvents.stationId,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.eventType, "BLISTER_COMPLETE"),
        inArray(workflowEvents.stationId, stationIds),
        gte(workflowEvents.occurredAt, args.from),
        lte(workflowEvents.occurredAt, args.to),
      ),
    );

  const blisterActivityRows = await db
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      stationId: workflowEvents.stationId,
    })
    .from(workflowEvents)
    .where(
      and(
        inArray(workflowEvents.eventType, [
          "BAG_PAUSED",
          "BAG_RESUMED",
          "BLISTER_COMPLETE",
        ]),
        inArray(workflowEvents.stationId, stationIds),
        gte(workflowEvents.occurredAt, args.from),
        lte(workflowEvents.occurredAt, args.to),
      ),
    );

  const segments: SegmentRow[] = [];
  for (const row of segmentRows) {
    const mapped = mapSegmentPayload({
      ...row,
      payload: (row.payload ?? null) as Record<string, unknown> | null,
    });
    if (mapped) segments.push(mapped);
  }

  const pauses: PauseRow[] = [];
  for (const row of pauseRows) {
    if (!row.workflowBagId) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const reason = typeof payload["reason"] === "string" ? payload["reason"] : "other";
    const counterSnapshotCount =
      typeof payload["counter_snapshot_count"] === "number"
        ? payload["counter_snapshot_count"]
        : null;
    const counterSnapshotReason =
      typeof payload["counter_snapshot_reason"] === "string"
        ? payload["counter_snapshot_reason"]
        : null;
    pauses.push({
      workflowBagId: row.workflowBagId,
      reason,
      counterSnapshotCount,
      counterSnapshotReason,
      occurredAt: row.occurredAt,
      stationId: row.stationId,
    });
  }

  const closeOuts: CloseOutRow[] = [];
  for (const row of closeOutRows) {
    if (!row.workflowBagId) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const countTotal =
      typeof payload["count_total"] === "number" ? payload["count_total"] : 0;
    closeOuts.push({
      workflowBagId: row.workflowBagId,
      countTotal,
      occurredAt: row.occurredAt,
      stationId: row.stationId,
    });
  }

  const bagIdSet = new Set<string>();
  for (const row of segments) bagIdSet.add(row.workflowBagId);
  for (const row of pauses) bagIdSet.add(row.workflowBagId);
  for (const row of closeOuts) bagIdSet.add(row.workflowBagId);
  for (const row of blisterActivityRows) {
    if (row.workflowBagId) bagIdSet.add(row.workflowBagId);
  }

  let bagIds = [...bagIdSet];
  if (args.bagQuery) {
    const q = args.bagQuery.trim().toLowerCase();
    const metaRows = await db
      .select({
        id: workflowBags.id,
        receiptNumber: workflowBags.receiptNumber,
        bagNumber: workflowBags.bagNumber,
        productName: products.name,
        tabletTypeName: tabletTypes.name,
      })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
      .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
      .where(inArray(workflowBags.id, bagIds.length > 0 ? bagIds : ["00000000-0000-0000-0000-000000000000"]));
    bagIds = metaRows
      .filter((row) => {
        const haystack = [
          row.id,
          row.receiptNumber,
          row.bagNumber,
          row.productName,
          row.tabletTypeName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .map((row) => row.id);
  }

  if (bagIds.length === 0) {
    return buildShiftReview({
      window: { from: args.from, to: args.to, label: args.label },
      bags: [],
      stationCount: stationIds.length,
    });
  }

  const bagMetaRows = await db
    .select({
      workflowBagId: workflowBags.id,
      receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
      bagNumber: workflowBags.bagNumber,
      productName: products.name,
      tabletTypeName: tabletTypes.name,
      productKind: products.kind,
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      isPaused: readBagState.isPaused,
      inventoryBagId: workflowBags.inventoryBagId,
    })
    .from(workflowBags)
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .where(inArray(workflowBags.id, bagIds));

  const finishedLotRows = await db
    .select({ workflowBagId: finishedLots.workflowBagId })
    .from(finishedLots)
    .where(inArray(finishedLots.workflowBagId, bagIds));

  const finishedLotBagIds = new Set(
    finishedLotRows
      .map((row) => row.workflowBagId)
      .filter((id): id is string => id != null),
  );

  const machineRollCache = new Map<string, string[]>();
  async function rollsForStation(stationId: string | null): Promise<string[]> {
    if (!stationId) return [];
    const station = stationById.get(stationId);
    if (!station?.machineId) return [];
    const cached = machineRollCache.get(station.machineId);
    if (cached) return cached;
    const rolls = await loadActiveRollLotIdsForMachine(db, station.machineId);
    machineRollCache.set(station.machineId, rolls);
    return rolls;
  }

  const bags: ShiftReviewBagInput[] = [];
  for (const meta of bagMetaRows) {
    const bagSegments = segments.filter(
      (segment) => segment.workflowBagId === meta.workflowBagId,
    );
    const bagPauses = pauses.filter(
      (pause) => pause.workflowBagId === meta.workflowBagId,
    );
    const bagCloseOuts = closeOuts.filter(
      (closeOut) => closeOut.workflowBagId === meta.workflowBagId,
    );
    const bagStationIds = new Set<string>();
    for (const row of [...bagSegments, ...bagPauses, ...bagCloseOuts]) {
      if (row.stationId) bagStationIds.add(row.stationId);
    }
    const stationNames = [...bagStationIds]
      .map((id) => stationById.get(id)?.name ?? id.slice(0, 8))
      .sort();
    const stationKinds = [...bagStationIds]
      .map((id) => stationById.get(id)?.kind ?? "BLISTER")
      .sort();

    const primaryStationId = [...bagStationIds][0] ?? stationIds[0] ?? null;
    const activeRollLotIds = primaryStationId
      ? await rollsForStation(primaryStationId)
      : [];

    const hasBlisterWorkflowActivity = blisterActivityRows.some(
      (row) => row.workflowBagId === meta.workflowBagId,
    );

    bags.push({
      workflowBagId: meta.workflowBagId,
      receiptNumber: meta.receiptNumber,
      bagNumber: meta.bagNumber,
      productName: meta.productName,
      tabletTypeName: meta.tabletTypeName,
      productKind: meta.productKind,
      stage: meta.stage,
      isFinalized: meta.isFinalized ?? false,
      isPaused: meta.isPaused ?? false,
      hasFinishedLot: finishedLotBagIds.has(meta.workflowBagId),
      inventoryBagId: meta.inventoryBagId,
      stationIds: [...bagStationIds],
      stationNames,
      stationKinds,
      segments: bagSegments.map(
        (segment): ShiftReviewSegmentInput => ({
          segmentReason: segment.segmentReason,
          counterSegmentCount: segment.counterSegmentCount,
          packagingLotId: segment.packagingLotId,
          rollRole: segment.rollRole,
          segmentGroupId: segment.segmentGroupId,
          oldLotId: segment.oldLotId,
          newLotId: segment.newLotId,
          changedRole: segment.changedRole,
          occurredAt: segment.occurredAt,
        }),
      ),
      pauseEvents: bagPauses.map(
        (pause): ShiftReviewPauseInput => ({
          reason: pause.reason,
          counterSnapshotCount: pause.counterSnapshotCount,
          counterSnapshotReason: pause.counterSnapshotReason,
          occurredAt: pause.occurredAt,
        }),
      ),
      blisterCloseOutCounts: bagCloseOuts.map((closeOut) => closeOut.countTotal),
      activeRollLotIds,
      hasBlisterWorkflowActivity,
    });
  }

  let result = buildShiftReview({
    window: { from: args.from, to: args.to, label: args.label },
    bags,
    stationCount: stationIds.length,
  });

  if (args.flaggedOnly) {
    result = {
      ...result,
      bags: result.bags.filter((bag) => bag.hasFlags),
      summary: {
        ...result.summary,
        bagsTouched: result.bags.filter((bag) => bag.hasFlags).length,
      },
    };
  }

  return result;
}
