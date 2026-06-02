/** RECOVERY-DRY-RUN-HARNESS-1 — read-only DB loader for recovery dry-run. */

import { sql, eq, and, inArray } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  finishedLots,
  materialInventoryEvents,
  packagingLots,
  packagingMaterials,
  stations,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import type {
  MaterialChangeRecoveryContext,
  MaterialChangeRecoveryExistingSegment,
  MaterialChangeRecoveryRole,
  MaterialChangeRecoveryRollState,
  MaterialChangeRecoveryWorkflowBagState,
} from "@/lib/production/material-change-recovery";

type DbClient = typeof Db;

export type LoadRecoveryContextArgs = {
  workflowBagId: string;
  stationId: string;
  oldRollLotId: string;
  newRollLotId: string;
  boundaryWorkflowEventId?: string | null;
  eventBoundaryTimestamp?: string | Date | null;
};

export type LoadedRecoveryContext = {
  context: MaterialChangeRecoveryContext;
  eventBoundaryTimestamp: Date;
  boundaryResolvedFromEvent: boolean;
};

type RollLotRow = {
  lotId: string;
  rollNumber: string | null;
  status: string;
  materialKind: string;
  role: MaterialChangeRecoveryRole | null;
};

type ActiveRollRow = {
  packagingLotId: string;
  role: MaterialChangeRecoveryRole;
};

export function materialKindToRollRole(kind: string): MaterialChangeRecoveryRole | null {
  if (kind === "PVC_ROLL") return "PVC";
  if (kind === "FOIL_ROLL" || kind === "BLISTER_FOIL") return "FOIL";
  return null;
}

export function inferLineageState(args: {
  inventoryBagId: string | null;
  hasCorrection: boolean;
}): "HIGH" | "LOW" | "MISSING" {
  if (!args.inventoryBagId) return "MISSING";
  if (args.hasCorrection) return "LOW";
  return "HIGH";
}

export function buildRecoveryRollState(args: {
  lot: RollLotRow;
  segmentTotal: number;
  activeAtBoundary: boolean;
  stationId: string | null;
  machineId: string | null;
}): MaterialChangeRecoveryRollState | null {
  if (!args.lot.role) return null;
  return {
    lotId: args.lot.lotId,
    rollNumber: args.lot.rollNumber,
    role: args.lot.role,
    status: args.lot.status,
    activeAtBoundary: args.activeAtBoundary,
    stationId: args.stationId,
    machineId: args.machineId,
    segmentTotal: args.segmentTotal,
  };
}

export function mapExistingSegmentRow(row: {
  workflowBagId: string;
  packagingLotId: string;
  role: MaterialChangeRecoveryRole | null;
  segmentCount: number | null;
  segmentReason: string | null;
  oldLotId: string | null;
  newLotId: string | null;
  occurredAt: Date | null;
}): MaterialChangeRecoveryExistingSegment | null {
  if (!row.role || row.segmentCount == null) return null;
  return {
    workflowBagId: row.workflowBagId,
    packagingLotId: row.packagingLotId,
    role: row.role,
    segmentCount: row.segmentCount,
    segmentReason: row.segmentReason,
    oldLotId: row.oldLotId,
    newLotId: row.newLotId,
    occurredAt: row.occurredAt,
  };
}

export function assembleRecoveryContext(args: {
  workflowBag?: MaterialChangeRecoveryWorkflowBagState | null;
  station?: { id: string; machineId: string | null } | null;
  rolls: MaterialChangeRecoveryRollState[];
  activeRollsAtBoundary: MaterialChangeRecoveryRollState[];
  existingSegments: MaterialChangeRecoveryExistingSegment[];
  boundaryWorkflowEventId?: string | null;
}): MaterialChangeRecoveryContext {
  return {
    ...(args.workflowBag != null ? { workflowBag: args.workflowBag } : {}),
    ...(args.station != null ? { station: args.station } : {}),
    rolls: args.rolls,
    activeRollsAtBoundary: args.activeRollsAtBoundary,
    existingSegments: args.existingSegments,
    ...(args.boundaryWorkflowEventId
      ? { boundaryWorkflowEventId: args.boundaryWorkflowEventId }
      : {}),
  };
}

async function loadRollLot(
  db: DbClient,
  lotId: string,
): Promise<RollLotRow | null> {
  const [row] = await db
    .select({
      lotId: packagingLots.id,
      rollNumber: packagingLots.rollNumber,
      status: packagingLots.status,
      materialKind: packagingMaterials.kind,
    })
    .from(packagingLots)
    .innerJoin(
      packagingMaterials,
      eq(packagingLots.packagingMaterialId, packagingMaterials.id),
    )
    .where(eq(packagingLots.id, lotId))
    .limit(1);
  if (!row) return null;
  return {
    lotId: row.lotId,
    rollNumber: row.rollNumber,
    status: row.status,
    materialKind: row.materialKind,
    role: materialKindToRollRole(row.materialKind),
  };
}

async function loadSegmentTotal(db: DbClient, lotId: string): Promise<number> {
  type SumRow = { total: number };
  const rows = (await db.execute<SumRow>(sql`
    SELECT COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND packaging_lot_id = ${lotId}
  `)) as unknown as SumRow[];
  return rows[0]?.total ?? 0;
}

async function loadActiveRollsOnMachine(
  db: DbClient,
  machineId: string,
): Promise<ActiveRollRow[]> {
  const rows = await db.execute<ActiveRollRow>(sql`
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
  return (rows as unknown as ActiveRollRow[]).filter(
    (row) => row.role === "PVC" || row.role === "FOIL",
  );
}

async function loadExistingSegmentsForBag(
  db: DbClient,
  workflowBagId: string,
): Promise<MaterialChangeRecoveryExistingSegment[]> {
  const rows = await db
    .select({
      workflowBagId: materialInventoryEvents.workflowBagId,
      packagingLotId: materialInventoryEvents.packagingLotId,
      segmentCount: sql<number | null>`(payload->>'counter_segment_count')::int`,
      segmentReason: sql<string | null>`payload->>'segment_reason'`,
      oldLotId: sql<string | null>`payload->>'old_lot_id'`,
      newLotId: sql<string | null>`payload->>'new_lot_id'`,
      materialKind: packagingMaterials.kind,
      occurredAt: materialInventoryEvents.occurredAt,
    })
    .from(materialInventoryEvents)
    .innerJoin(
      packagingLots,
      eq(materialInventoryEvents.packagingLotId, packagingLots.id),
    )
    .innerJoin(
      packagingMaterials,
      eq(packagingLots.packagingMaterialId, packagingMaterials.id),
    )
    .where(
      and(
        eq(materialInventoryEvents.eventType, "ROLL_COUNTER_SEGMENT_RECORDED"),
        eq(materialInventoryEvents.workflowBagId, workflowBagId),
      ),
    )
    .orderBy(
      sql`${materialInventoryEvents.occurredAt} DESC`,
      sql`${materialInventoryEvents.id} DESC`,
    );

  return rows.flatMap((row) => {
    if (!row.workflowBagId || !row.packagingLotId) return [];
    const mapped = mapExistingSegmentRow({
      workflowBagId: row.workflowBagId,
      packagingLotId: row.packagingLotId,
      role: materialKindToRollRole(row.materialKind),
      segmentCount: row.segmentCount,
      segmentReason: row.segmentReason,
      oldLotId: row.oldLotId,
      newLotId: row.newLotId,
      occurredAt: row.occurredAt,
    });
    return mapped ? [mapped] : [];
  });
}

export async function loadMaterialChangeRecoveryContext(
  db: DbClient,
  args: LoadRecoveryContextArgs,
): Promise<LoadedRecoveryContext> {
  const [bagRow] = await db
    .select({
      id: workflowBags.id,
      finalizedAt: workflowBags.finalizedAt,
      inventoryBagId: workflowBags.inventoryBagId,
    })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId))
    .limit(1);

  const finishedLotRows = await db
    .select({ id: finishedLots.id })
    .from(finishedLots)
    .where(eq(finishedLots.workflowBagId, args.workflowBagId));

  const [stationRow] = await db
    .select({
      id: stations.id,
      machineId: stations.machineId,
    })
    .from(stations)
    .where(eq(stations.id, args.stationId))
    .limit(1);

  let boundaryResolvedFromEvent = false;
  let eventBoundaryTimestamp: Date | null = null;
  if (args.boundaryWorkflowEventId) {
    const [boundaryEvent] = await db
      .select({
        id: workflowEvents.id,
        occurredAt: workflowEvents.occurredAt,
        workflowBagId: workflowEvents.workflowBagId,
      })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, args.boundaryWorkflowEventId))
      .limit(1);
    if (boundaryEvent?.occurredAt) {
      eventBoundaryTimestamp = boundaryEvent.occurredAt;
      boundaryResolvedFromEvent = true;
    }
  }
  if (!eventBoundaryTimestamp && args.eventBoundaryTimestamp) {
    eventBoundaryTimestamp = new Date(args.eventBoundaryTimestamp);
  }
  if (!eventBoundaryTimestamp || Number.isNaN(eventBoundaryTimestamp.getTime())) {
    throw new Error(
      "Event boundary timestamp is required. Provide --boundary-event-id or --event-boundary-timestamp.",
    );
  }

  const machineId = stationRow?.machineId ?? null;
  const activeOnMachine = machineId
    ? await loadActiveRollsOnMachine(db, machineId)
    : [];
  const activeLotIds = new Set(activeOnMachine.map((row) => row.packagingLotId));

  const lotIds = Array.from(
    new Set([
      args.oldRollLotId,
      args.newRollLotId,
      ...activeOnMachine.map((row) => row.packagingLotId),
    ]),
  );

  const lotRows: RollLotRow[] = [];
  for (const lotId of lotIds) {
    const lot = await loadRollLot(db, lotId);
    if (lot) lotRows.push(lot);
  }

  const segmentTotals = new Map<string, number>();
  for (const lotId of lotIds) {
    segmentTotals.set(lotId, await loadSegmentTotal(db, lotId));
  }

  const rolls = lotRows.flatMap((lot) => {
    const mapped = buildRecoveryRollState({
      lot,
      segmentTotal: segmentTotals.get(lot.lotId) ?? 0,
      activeAtBoundary: activeLotIds.has(lot.lotId),
      stationId: stationRow?.id ?? null,
      machineId,
    });
    return mapped ? [mapped] : [];
  });

  const activeRollsAtBoundary = rolls.filter((roll) => roll.activeAtBoundary);
  const existingSegments = await loadExistingSegmentsForBag(db, args.workflowBagId);

  const workflowBag: MaterialChangeRecoveryWorkflowBagState | null = bagRow
    ? {
        id: bagRow.id,
        finalizedAt: bagRow.finalizedAt,
        finishedLotIds: finishedLotRows.map((row) => row.id),
        isLegacy: bagRow.inventoryBagId == null,
        lineageState: inferLineageState({
          inventoryBagId: bagRow.inventoryBagId,
          hasCorrection: false,
        }),
      }
    : null;

  const context = assembleRecoveryContext({
    ...(workflowBag ? { workflowBag } : {}),
    ...(stationRow
      ? { station: { id: stationRow.id, machineId: stationRow.machineId } }
      : {}),
    rolls,
    activeRollsAtBoundary,
    existingSegments,
    boundaryWorkflowEventId: args.boundaryWorkflowEventId ?? null,
  });

  return {
    context,
    eventBoundaryTimestamp,
    boundaryResolvedFromEvent,
  };
}

export async function loadRollLotsByIds(
  db: DbClient,
  lotIds: string[],
): Promise<RollLotRow[]> {
  if (lotIds.length === 0) return [];
  const rows = await db
    .select({
      lotId: packagingLots.id,
      rollNumber: packagingLots.rollNumber,
      status: packagingLots.status,
      materialKind: packagingMaterials.kind,
    })
    .from(packagingLots)
    .innerJoin(
      packagingMaterials,
      eq(packagingLots.packagingMaterialId, packagingMaterials.id),
    )
    .where(inArray(packagingLots.id, lotIds));
  return rows.map((row) => ({
    lotId: row.lotId,
    rollNumber: row.rollNumber,
    status: row.status,
    materialKind: row.materialKind,
    role: materialKindToRollRole(row.materialKind),
  }));
}
