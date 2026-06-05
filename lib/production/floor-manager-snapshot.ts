// Production-manager view model for /floor-board — aggregates every
// metric a shift lead / plant manager needs in one server fetch.

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  machines,
  products,
  readBagMetrics,
  readBagState,
  readDailyThroughput,
  readStationLive,
  stations,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { computeShiftProgress } from "@/lib/production/floor-command";
import { deriveOperatorRows } from "@/lib/production/metrics";
import { lastNDays } from "@/lib/production/time";
import { buildFloorDataGaps } from "@/lib/floor-command/data-gaps";
import type {
  FloorManagerSnapshot,
  StageCycleBenchmarkRow,
  StationCommandRow,
  WipStageRow,
} from "@/lib/production/floor-manager-snapshot-types";
import { humanStage } from "@/lib/floor-command/floor-display";
import { buildCurrentBagDisplayLabel } from "@/lib/production/current-bag-display-label";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const PAUSE_LABOR_USD_PER_HOUR = 25;

function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";

export async function getFloorManagerSnapshot(
  tz: string,
): Promise<FloorManagerSnapshot> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);
  const shiftDayKey = shiftStartUtc.toISOString().slice(0, 10);
  const since7d = new Date(now.getTime() - SEVEN_DAYS_MS);
  const shiftStartIso = shiftStartUtc.toISOString();

  const [
    machinesRows,
    stationCommandRows,
    stationsRows,
    productsRows,
    plantRows,
    wipRow,
    inFlightRows,
    recentFinalizedRows,
    wipByStageRows,
    stageCycleRows,
    downtimeRows,
    flavorRows,
    runwayRow,
    laneRow,
    damageClusterRow,
    dataGaps,
    operatorRows,
  ] = await Promise.all([
    loadMachineProduction(shiftStartIso, since7d, shiftDayKey),
    loadStationCommandRows(now, shiftDayKey),
    loadStationScans(now),
    loadProductMaterialYield(shiftStartUtc),
    loadPlantShiftStats(shiftStartUtc),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(readBagState)
      .where(eq(readBagState.isFinalized, false)),
    loadInFlight(),
    loadRecentFinalized(12),
    loadWipByStage(),
    loadStageCycles(shiftStartUtc, since7d),
    loadDowntimeToday(shiftStartIso),
    loadFlavorToday(shiftDayKey),
    loadMaterialRunway(),
    loadLaneImbalance(),
    loadDamageCluster(),
    loadDataGaps(shiftDayKey),
    deriveOperatorRows(lastNDays(1)),
  ]);

  const pauseStats = await loadPauseCostToday(shiftStartIso);

  const plant = plantRows[0];
  const laneLabel = formatLaneImbalance(laneRow);

  return {
    shiftDayKey,
    plant: {
      bagsInFlow: wipRow[0]?.n ?? 0,
      bagsFinalizedShift: plant?.bags ?? 0,
      unitsYieldedShift: plant?.units ?? 0,
      avgCycleSecShift: plant?.avg_cycle ?? null,
      avgYieldPctShift: plant?.avg_yield ?? null,
      damageRatePctShift: plant?.damage_rate ?? null,
      pauseCostUsdToday: pauseStats.costUsd,
      pauseMinutesToday: Math.round(pauseStats.pausedSeconds / 60),
      materialRunwayDays: runwayRow,
      laneImbalanceLabel: laneLabel,
      damageClusterActive: damageClusterRow.isCluster,
    },
    stationCommandRows,
    machines: machinesRows,
    stations: stationsRows,
    products: productsRows,
    operators: operatorRows.slice(0, 12).map((r) => ({
      displayName: r.displayName,
      bagsFinalized: r.bagsFinalized,
      activeHours: Math.round((r.activeSeconds / 3600) * 10) / 10,
      unitsPerHour:
        r.bagsFinalized > 0 && r.activeSeconds > 0
          ? Math.round((r.bagsFinalized / r.activeSeconds) * 3600 * 10) / 10
          : null,
      damageEvents: r.damageEvents,
      reworkSent: r.reworkSent,
    })),
    downtimeToday: downtimeRows,
    inFlight: inFlightRows,
    recentFinalized: recentFinalizedRows,
    wipByStage: wipByStageRows,
    stageCycles: stageCycleRows,
    flavorToday: flavorRows,
    dataGaps,
  };
}

async function loadMachineProduction(
  shiftStartIso: string,
  since7d: Date,
  shiftDayKey: string,
) {
  const since7dIso = since7d.toISOString();
  const rows = (await db.execute(sql`
    WITH machine_bags AS (
      SELECT
        m.id AS machine_id,
        rbm.workflow_bag_id,
        rbm.total_seconds,
        rbm.active_seconds,
        rbm.units_yielded,
        rbm.finalized_at
      FROM machines m
      INNER JOIN read_bag_metrics rbm ON m.id = ANY(rbm.machine_ids)
      WHERE m.is_active = true
    ),
    machine_stats AS (
      SELECT
        machine_id,
        ROUND(AVG(total_seconds) FILTER (
          WHERE finalized_at >= ${since7dIso}::timestamptz
        ))::int AS avg_cycle_7d,
        ROUND(AVG(active_seconds) FILTER (
          WHERE finalized_at >= ${since7dIso}::timestamptz
        ))::int AS avg_active_7d,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_seconds)
          FILTER (WHERE finalized_at >= ${since7dIso}::timestamptz) AS p90_7d,
        ROUND(AVG(total_seconds) FILTER (
          WHERE finalized_at >= ${shiftStartIso}::timestamptz
        ))::int AS avg_cycle_shift,
        COUNT(*) FILTER (
          WHERE finalized_at >= ${shiftStartIso}::timestamptz
        )::int AS bags_shift,
        COALESCE(SUM(units_yielded) FILTER (
          WHERE finalized_at >= ${shiftStartIso}::timestamptz
        ), 0)::int AS units_shift
      FROM machine_bags
      GROUP BY machine_id
    ),
    machine_today AS (
      SELECT
        machine_id,
        COALESCE(SUM(bags_finalized), 0)::int AS finalized,
        COALESCE(SUM(units_produced), 0)::int AS units,
        COALESCE(SUM(bags_blistered), 0)::int AS blistered,
        COALESCE(SUM(bags_sealed), 0)::int AS sealed,
        COALESCE(SUM(bags_packaged), 0)::int AS packaged
      FROM read_daily_throughput
      WHERE day = ${shiftDayKey}::date
      GROUP BY machine_id
    ),
    machine_live AS (
      SELECT DISTINCT ON (s.machine_id)
        s.machine_id,
        wb.receipt_number,
        p.name AS product_name,
        rsl.current_employee_name AS operator_name,
        wb.started_at,
        rsl.last_event_type,
        rsl.last_event_at
      FROM stations s
      JOIN read_station_live rsl ON rsl.station_id = s.id
      LEFT JOIN workflow_bags wb ON wb.id = rsl.current_workflow_bag_id
      LEFT JOIN products p ON p.id = wb.product_id
      WHERE s.machine_id IS NOT NULL
        AND rsl.current_workflow_bag_id IS NOT NULL
      ORDER BY s.machine_id, rsl.last_event_at DESC NULLS LAST
    ),
    station_labels AS (
      SELECT
        machine_id,
        ARRAY_AGG(label ORDER BY label) AS labels
      FROM stations
      WHERE machine_id IS NOT NULL AND is_active = true
      GROUP BY machine_id
    )
    SELECT
      m.id AS machine_id,
      m.name,
      m.kind::text AS kind,
      COALESCE(sl.labels, ARRAY[]::text[]) AS station_labels,
      ml.receipt_number,
      ml.product_name,
      ml.operator_name,
      ml.started_at,
      ml.last_event_type,
      ml.last_event_at,
      ms.avg_cycle_7d,
      ms.avg_active_7d,
      ROUND(ms.p90_7d)::int AS p90_7d,
      ms.avg_cycle_shift,
      COALESCE(ms.bags_shift, 0) AS bags_shift,
      COALESCE(ms.units_shift, 0) AS units_shift,
      COALESCE(mt.finalized, 0) AS today_finalized,
      COALESCE(mt.units, 0) AS today_units,
      COALESCE(mt.blistered, 0) AS today_blistered,
      COALESCE(mt.sealed, 0) AS today_sealed,
      COALESCE(mt.packaged, 0) AS today_packaged
    FROM machines m
    LEFT JOIN machine_stats ms ON ms.machine_id = m.id
    LEFT JOIN machine_today mt ON mt.machine_id = m.id
    LEFT JOIN machine_live ml ON ml.machine_id = m.id
    LEFT JOIN station_labels sl ON sl.machine_id = m.id
    WHERE m.is_active = true
    ORDER BY m.name
  `)) as unknown as Array<{
    machine_id: string;
    name: string;
    kind: string;
    station_labels: string[] | null;
    receipt_number: string | null;
    product_name: string | null;
    operator_name: string | null;
    started_at: string | null;
    last_event_type: string | null;
    last_event_at: string | null;
    avg_cycle_7d: number | null;
    avg_active_7d: number | null;
    p90_7d: number | null;
    avg_cycle_shift: number | null;
    bags_shift: number;
    units_shift: number;
    today_finalized: number;
    today_units: number;
    today_blistered: number;
    today_sealed: number;
    today_packaged: number;
  }>;

  return rows.map((r) => {
    const bagsShift = Number(r.bags_shift) || 0;
    const unitsShift = Number(r.units_shift) || 0;
    // Rough shift units/hr: assume 8h shift elapsed fraction from shift start
    const hoursSinceShift = Math.max(
      0.25,
      (Date.now() - new Date(shiftStartIso).getTime()) / 3600000,
    );
    return {
      machineId: r.machine_id,
      name: r.name,
      kind: r.kind,
      stationLabels: r.station_labels ?? [],
      currentReceiptNumber: r.receipt_number,
      currentProductName: r.product_name,
      currentOperatorName: r.operator_name,
      currentBagStartedAt: iso(
        r.started_at ? new Date(r.started_at) : null,
      ),
      lastEventType: r.last_event_type,
      lastEventAt: iso(r.last_event_at ? new Date(r.last_event_at) : null),
      avgCycleSec7d: r.avg_cycle_7d != null ? Number(r.avg_cycle_7d) : null,
      avgActiveCycleSec7d:
        r.avg_active_7d != null ? Number(r.avg_active_7d) : null,
      p90CycleSec7d: r.p90_7d != null ? Number(r.p90_7d) : null,
      avgCycleSecShift:
        r.avg_cycle_shift != null ? Number(r.avg_cycle_shift) : null,
      bagsFinalizedShift: bagsShift,
      unitsProducedShift: unitsShift,
      unitsPerHourShift:
        bagsShift > 0
          ? Math.round((unitsShift / hoursSinceShift) * 10) / 10
          : null,
      todayFinalized: Number(r.today_finalized) || 0,
      todayUnits: Number(r.today_units) || 0,
      todayBlistered: Number(r.today_blistered) || 0,
      todaySealed: Number(r.today_sealed) || 0,
      todayPackaged: Number(r.today_packaged) || 0,
    };
  });
}

function queueKeyForStationKind(kind: string): string | null {
  switch (kind) {
    case "BLISTER":
    case "HANDPACK_BLISTER":
      return "BLISTER_QUEUE";
    case "SEALING":
      return "SEALING_QUEUE";
    case "PACKAGING":
      return "PACKAGING_QUEUE";
    case "BOTTLE_HANDPACK":
      return "BOTTLE_FILL_QUEUE";
    case "BOTTLE_CAP_SEAL":
      return "BOTTLE_STICKER_QUEUE";
    case "BOTTLE_STICKER":
      return "BOTTLE_INDUCTION_QUEUE";
    default:
      return null;
  }
}

async function loadStationCommandRows(
  now: Date,
  shiftDayKey: string,
): Promise<StationCommandRow[]> {
  const [stationRows, rollRows, queueRows] = await Promise.all([
    db.execute(sql`
      WITH machine_today AS (
        SELECT
          machine_id,
          COALESCE(SUM(bags_finalized), 0)::int AS finalized,
          COALESCE(SUM(units_produced), 0)::int AS units,
          COALESCE(SUM(bags_blistered), 0)::int AS blistered,
          COALESCE(SUM(bags_sealed), 0)::int AS sealed,
          COALESCE(SUM(bags_packaged), 0)::int AS packaged
        FROM read_daily_throughput
        WHERE day = ${shiftDayKey}::date
        GROUP BY machine_id
      )
      SELECT
        s.id::text AS station_id,
        s.label AS station_label,
        s.kind::text AS station_kind,
        s.machine_id::text AS machine_id,
        m.name AS machine_name,
        m.kind::text AS machine_kind,
        m.cards_per_turn,
        m.target_bags_per_hour,
        rsl.current_workflow_bag_id::text AS workflow_bag_id,
        rsl.current_employee_name AS operator_name,
        rsl.last_event_type,
        rsl.last_event_at,
        rsl.busy_for_seconds,
        rbs.stage,
        COALESCE(rbs.is_paused, false) AS is_paused,
        COALESCE(rbs.is_on_hold, false) AS is_on_hold,
        COALESCE(rbs.rework_pending, false) AS rework_pending,
        rbs.current_operator_code,
        wb.receipt_number,
        wb.started_at,
        wb.bag_number AS workflow_bag_number,
        p.name AS product_name,
        qc.label AS card_label,
        ib.internal_receipt_number,
        ib.bag_number AS inventory_bag_number,
        tt.name AS tablet_type_name,
        po.po_number,
        sos.employee_name_snapshot AS active_operator_name,
        sos.accountability_source AS active_operator_source,
        COALESCE(mt.finalized, 0) AS today_finalized,
        COALESCE(mt.units, 0) AS today_units,
        COALESCE(mt.blistered, 0) AS today_blistered,
        COALESCE(mt.sealed, 0) AS today_sealed,
        COALESCE(mt.packaged, 0) AS today_packaged,
        (
          SELECT ROUND(AVG(rbm.total_seconds))::int
          FROM read_bag_metrics rbm
          WHERE s.machine_id IS NOT NULL
            AND s.machine_id = ANY(rbm.machine_ids)
            AND rbm.finalized_at >= ${shiftDayKey}::date
        ) AS avg_cycle_shift,
        (
          SELECT ROUND(AVG(rbm.total_seconds))::int
          FROM read_bag_metrics rbm
          WHERE s.machine_id IS NOT NULL
            AND s.machine_id = ANY(rbm.machine_ids)
            AND rbm.finalized_at >= now() - INTERVAL '7 days'
        ) AS avg_cycle_7d
      FROM stations s
      LEFT JOIN machines m ON m.id = s.machine_id
      LEFT JOIN read_station_live rsl ON rsl.station_id = s.id
      LEFT JOIN workflow_bags wb ON wb.id = rsl.current_workflow_bag_id
      LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = rsl.current_workflow_bag_id
      LEFT JOIN products p ON p.id = wb.product_id
      LEFT JOIN LATERAL (
        SELECT label
        FROM qr_cards
        WHERE assigned_workflow_bag_id = wb.id
        ORDER BY label
        LIMIT 1
      ) qc ON true
      LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
      LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
      LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
      LEFT JOIN receives rec ON rec.id = sb.receive_id
      LEFT JOIN purchase_orders po ON po.id = rec.po_id
      LEFT JOIN station_operator_sessions sos
        ON sos.station_id = s.id
       AND sos.closed_at IS NULL
      LEFT JOIN machine_today mt ON mt.machine_id = s.machine_id
      WHERE s.is_active = true
      ORDER BY s.label
    `),
    db.execute(sql`
      SELECT
        rru.machine_id::text AS machine_id,
        rru.packaging_lot_id::text AS packaging_lot_id,
        rru.roll_number,
        rru.material_role,
        rru.material_kind,
        pm.name AS material_name,
        rru.mounted_at,
        rru.starting_weight_grams,
        rru.projected_remaining_grams,
        rru.projected_blisters_remaining,
        rru.confidence
      FROM read_roll_usage rru
      LEFT JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
      LEFT JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
      WHERE rru.machine_id IS NOT NULL
        AND rru.mounted_at IS NOT NULL
        AND rru.unmounted_at IS NULL
      ORDER BY rru.material_role, rru.mounted_at DESC
    `),
    db.execute(sql`
      SELECT
        stage_key,
        wip,
        oldest_age_seconds,
        queue_status
      FROM read_queue_state
    `),
  ]);

  type StationRow = {
    station_id: string;
    station_label: string;
    station_kind: string;
    machine_id: string | null;
    machine_name: string | null;
    machine_kind: string | null;
    cards_per_turn: number | null;
    target_bags_per_hour: number | null;
    workflow_bag_id: string | null;
    operator_name: string | null;
    last_event_type: string | null;
    last_event_at: string | Date | null;
    busy_for_seconds: number | null;
    stage: string | null;
    is_paused: boolean;
    is_on_hold: boolean;
    rework_pending: boolean;
    current_operator_code: string | null;
    receipt_number: string | null;
    started_at: string | Date | null;
    workflow_bag_number: number | null;
    product_name: string | null;
    card_label: string | null;
    internal_receipt_number: string | null;
    inventory_bag_number: number | null;
    tablet_type_name: string | null;
    po_number: string | null;
    active_operator_name: string | null;
    active_operator_source: string | null;
    today_finalized: number;
    today_units: number;
    today_blistered: number;
    today_sealed: number;
    today_packaged: number;
    avg_cycle_shift: number | null;
    avg_cycle_7d: number | null;
  };

  type RollRow = {
    machine_id: string | null;
    packaging_lot_id: string;
    roll_number: string | null;
    material_role: string | null;
    material_kind: string | null;
    material_name: string | null;
    mounted_at: string | Date | null;
    starting_weight_grams: number | null;
    projected_remaining_grams: number | null;
    projected_blisters_remaining: number | null;
    confidence: string;
  };

  type QueueRow = {
    stage_key: string;
    wip: number;
    oldest_age_seconds: number | null;
    queue_status: string;
  };

  const rollsByMachine = new Map<string, StationCommandRow["activeRolls"]>();
  for (const roll of rollRows as unknown as RollRow[]) {
    if (!roll.machine_id) continue;
    const list = rollsByMachine.get(roll.machine_id) ?? [];
    list.push({
      packagingLotId: roll.packaging_lot_id,
      rollNumber: roll.roll_number,
      materialRole: roll.material_role,
      materialKind: roll.material_kind,
      materialName: roll.material_name,
      mountedAt: iso(roll.mounted_at ? new Date(roll.mounted_at) : null),
      startingWeightGrams:
        roll.starting_weight_grams != null
          ? Number(roll.starting_weight_grams)
          : null,
      projectedRemainingGrams:
        roll.projected_remaining_grams != null
          ? Number(roll.projected_remaining_grams)
          : null,
      projectedBlistersRemaining:
        roll.projected_blisters_remaining != null
          ? Number(roll.projected_blisters_remaining)
          : null,
      confidence: roll.confidence,
    });
    rollsByMachine.set(roll.machine_id, list);
  }

  const queueByKey = new Map(
    (queueRows as unknown as QueueRow[]).map((row) => [row.stage_key, row]),
  );

  return (stationRows as unknown as StationRow[]).map((row) => {
    const startedAt = row.started_at ? new Date(row.started_at) : null;
    const lastAt = row.last_event_at ? new Date(row.last_event_at) : null;
    const idleMinutes =
      lastAt && !row.workflow_bag_id
        ? Math.floor((now.getTime() - lastAt.getTime()) / 60000)
        : null;
    const queue = queueByKey.get(queueKeyForStationKind(row.station_kind) ?? "");
    const label = row.workflow_bag_id
      ? buildCurrentBagDisplayLabel({
          cardLabel: row.card_label,
          poNumber: row.po_number,
          tabletTypeName: row.tablet_type_name,
          productName: row.product_name,
          inventoryBagNumber: row.inventory_bag_number,
          workflowBagNumber: row.workflow_bag_number,
        })
      : null;

    return {
      stationId: row.station_id,
      stationLabel: row.station_label,
      stationKind: row.station_kind,
      machineId: row.machine_id,
      machineName: row.machine_name,
      machineKind: row.machine_kind,
      cardsPerTurn:
        row.cards_per_turn != null ? Number(row.cards_per_turn) : null,
      targetBagsPerHour:
        row.target_bags_per_hour != null
          ? Number(row.target_bags_per_hour)
          : null,
      workflowBagId: row.workflow_bag_id,
      bagLabel: label?.primary ?? null,
      bagLabelSecondary: label?.secondary ?? null,
      receiptNumber: row.receipt_number ?? row.internal_receipt_number,
      productName: row.product_name,
      poNumber: row.po_number,
      cardLabel: row.card_label,
      stage: row.stage,
      startedAt: iso(startedAt),
      elapsedSeconds:
        startedAt != null
          ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000))
          : null,
      operatorName: row.operator_name,
      operatorCode: row.current_operator_code,
      activeOperatorName: row.active_operator_name,
      activeOperatorSource: row.active_operator_source,
      isPaused: row.is_paused,
      isOnHold: row.is_on_hold,
      reworkPending: row.rework_pending,
      lastEventType: row.last_event_type,
      lastEventAt: iso(lastAt),
      busyForSeconds:
        row.busy_for_seconds != null ? Number(row.busy_for_seconds) : null,
      idleMinutes,
      queueWip: queue ? Number(queue.wip) || 0 : null,
      queueOldestMinutes:
        queue?.oldest_age_seconds != null
          ? Math.floor(Number(queue.oldest_age_seconds) / 60)
          : null,
      queueStatus: queue?.queue_status ?? null,
      activeRolls: row.machine_id
        ? (rollsByMachine.get(row.machine_id) ?? [])
        : [],
      todayFinalized: Number(row.today_finalized) || 0,
      todayUnits: Number(row.today_units) || 0,
      todayBlistered: Number(row.today_blistered) || 0,
      todaySealed: Number(row.today_sealed) || 0,
      todayPackaged: Number(row.today_packaged) || 0,
      avgCycleSecShift:
        row.avg_cycle_shift != null ? Number(row.avg_cycle_shift) : null,
      avgCycleSec7d: row.avg_cycle_7d != null ? Number(row.avg_cycle_7d) : null,
    };
  });
}

async function loadStationScans(now: Date) {
  const rows = (await db.execute(sql`
    SELECT
      s.id AS station_id,
      s.label,
      s.kind::text AS kind,
      s.machine_id,
      m.name AS machine_name,
      rsl.current_workflow_bag_id AS bag_id,
      wb.receipt_number,
      p.name AS product_name,
      rsl.current_employee_name AS operator_name,
      rbs.stage,
      COALESCE(rbs.is_paused, false) AS is_paused,
      COALESCE(rbs.is_on_hold, false) AS is_on_hold,
      COALESCE(rbs.rework_pending, false) AS rework_pending,
      rsl.last_event_type,
      rsl.last_event_at,
      rsl.busy_for_seconds
    FROM stations s
    LEFT JOIN machines m ON m.id = s.machine_id
    LEFT JOIN read_station_live rsl ON rsl.station_id = s.id
    LEFT JOIN workflow_bags wb ON wb.id = rsl.current_workflow_bag_id
    LEFT JOIN products p ON p.id = wb.product_id
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = rsl.current_workflow_bag_id
    WHERE s.is_active = true
    ORDER BY s.label
  `)) as unknown as Array<{
    station_id: string;
    label: string;
    kind: string;
    machine_id: string | null;
    machine_name: string | null;
    bag_id: string | null;
    receipt_number: string | null;
    product_name: string | null;
    operator_name: string | null;
    stage: string | null;
    is_paused: boolean;
    is_on_hold: boolean;
    rework_pending: boolean;
    last_event_type: string | null;
    last_event_at: string | null;
    busy_for_seconds: number | null;
  }>;

  return rows.map((r) => {
    const lastAt = r.last_event_at ? new Date(r.last_event_at) : null;
    const idleMinutes =
      lastAt && !r.bag_id
        ? Math.floor((now.getTime() - lastAt.getTime()) / 60000)
        : null;
    return {
      stationId: r.station_id,
      label: r.label,
      kind: r.kind,
      machineId: r.machine_id,
      machineName: r.machine_name,
      receiptNumber: r.receipt_number,
      productName: r.product_name,
      operatorName: r.operator_name,
      workflowBagId: r.bag_id,
      stage: r.stage,
      isPaused: r.is_paused,
      isOnHold: r.is_on_hold,
      reworkPending: r.rework_pending,
      lastEventType: r.last_event_type,
      lastEventAt: iso(lastAt),
      busyForSeconds: r.busy_for_seconds,
      idleMinutes,
    };
  });
}

async function loadProductMaterialYield(shiftStartUtc: Date) {
  const rows = await db
    .select({
      productId: readBagMetrics.productId,
      productName: products.name,
      bags: sql<number>`COUNT(*)::int`,
      inputPills: sql<number>`COALESCE(SUM(${readBagMetrics.inputPillCount}), 0)::int`,
      units: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
      displays: sql<number>`COALESCE(SUM(${readBagMetrics.displaysMade}), 0)::int`,
      cases: sql<number>`COALESCE(SUM(${readBagMetrics.masterCases}), 0)::int`,
      damaged: sql<number>`COALESCE(SUM(${readBagMetrics.damagedPackaging}), 0)::int`,
      ripped: sql<number>`COALESCE(SUM(${readBagMetrics.rippedCards}), 0)::int`,
      avgCycle: sql<number>`ROUND(AVG(${readBagMetrics.totalSeconds}))::int`,
      avgActive: sql<number>`ROUND(AVG(${readBagMetrics.activeSeconds}))::int`,
      avgYield: sql<number>`ROUND(AVG(${readBagMetrics.yieldPct})::numeric, 2)`,
    })
    .from(readBagMetrics)
    .leftJoin(products, eq(products.id, readBagMetrics.productId))
    .where(gte(readBagMetrics.finalizedAt, shiftStartUtc))
    .groupBy(readBagMetrics.productId, products.name)
    .orderBy(sql`SUM(${readBagMetrics.unitsYielded}) DESC`);

  return rows
    .filter((r) => r.productId)
    .map((r) => {
      const input = Number(r.inputPills) || 0;
      const units = Number(r.units) || 0;
      const damaged = Number(r.damaged) || 0;
      const ripped = Number(r.ripped) || 0;
      const denom = units + damaged + ripped;
      return {
        productId: r.productId!,
        productName: r.productName ?? "—",
        bagsFinalized: Number(r.bags) || 0,
        inputPills: input,
        unitsYielded: units,
        displaysMade: Number(r.displays) || 0,
        casesMade: Number(r.cases) || 0,
        damagedUnits: damaged,
        rippedCards: ripped,
        yieldPct:
          input > 0 ? Math.round((units / input) * 1000) / 10 : null,
        damageRatePct:
          denom > 0
            ? Math.round(((damaged + ripped) / denom) * 1000) / 10
            : null,
        avgCycleSec: r.avgCycle != null ? Number(r.avgCycle) : null,
        avgActiveCycleSec: r.avgActive != null ? Number(r.avgActive) : null,
      };
    });
}

async function loadPlantShiftStats(shiftStartUtc: Date) {
  return db
    .select({
      bags: sql<number>`COUNT(*)::int`,
      units: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
      avg_cycle: sql<number>`ROUND(AVG(${readBagMetrics.totalSeconds}) FILTER (
        WHERE ${readBagMetrics.totalSeconds} > 0
          AND ${readBagMetrics.totalSeconds} < 28800
      ))::int`,
      avg_yield: sql<number>`ROUND(AVG(${readBagMetrics.yieldPct})::numeric, 2)`,
      damage_rate: sql<number>`ROUND(
        (COALESCE(SUM(${readBagMetrics.damagedPackaging}), 0)
          + COALESCE(SUM(${readBagMetrics.rippedCards}), 0))::numeric
        / NULLIF(
          COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)
          + COALESCE(SUM(${readBagMetrics.damagedPackaging}), 0)
          + COALESCE(SUM(${readBagMetrics.rippedCards}), 0),
          0
        ) * 100,
        2
      )`,
    })
    .from(readBagMetrics)
    .where(gte(readBagMetrics.finalizedAt, shiftStartUtc));
}

async function loadInFlight() {
  const rows = await db
    .select({
      workflowBagId: workflowBags.id,
      receiptNumber: workflowBags.receiptNumber,
      productName: products.name,
      stage: readBagState.stage,
      startedAt: workflowBags.startedAt,
      isPaused: readBagState.isPaused,
      isOnHold: readBagState.isOnHold,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(isNull(workflowBags.finalizedAt))
    .orderBy(workflowBags.startedAt)
    .limit(24);

  const now = Date.now();
  return rows.map((r) => ({
    workflowBagId: r.workflowBagId,
    receiptNumber: r.receiptNumber,
    productName: r.productName,
    stage: r.stage,
    elapsedMinutes: Math.floor(
      (now - (r.startedAt as Date).getTime()) / 60000,
    ),
    isPaused: r.isPaused ?? false,
    isOnHold: r.isOnHold ?? false,
  }));
}

async function loadRecentFinalized(limit: number) {
  const rows = await db
    .select({
      receiptNumber: workflowBags.receiptNumber,
      productName: products.name,
      finalizedAt: readBagMetrics.finalizedAt,
      totalSeconds: readBagMetrics.totalSeconds,
      unitsYielded: readBagMetrics.unitsYielded,
    })
    .from(readBagMetrics)
    .innerJoin(workflowBags, eq(workflowBags.id, readBagMetrics.workflowBagId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .where(isNotNull(readBagMetrics.finalizedAt))
    .orderBy(desc(readBagMetrics.finalizedAt))
    .limit(limit);

  const now = Date.now();
  return rows.map((r) => {
    const at = r.finalizedAt as Date;
    const minutesAgo = Math.floor((now - at.getTime()) / 60000);
    return {
      receiptNumber: r.receiptNumber,
      productName: r.productName,
      finalizedAt: iso(at) ?? "",
      minutesAgo,
      totalCycleSec: r.totalSeconds ?? 0,
      unitsYielded: r.unitsYielded ?? 0,
    };
  });
}

async function loadWipByStage(): Promise<WipStageRow[]> {
  const rows = (await db.execute(sql`
    SELECT
      COALESCE(rbs.stage::text, 'UNKNOWN') AS stage,
      COUNT(*)::int AS cnt,
      MIN(EXTRACT(EPOCH FROM (NOW() - wb.started_at)) / 60)::int AS oldest_min
    FROM read_bag_state rbs
    INNER JOIN workflow_bags wb ON wb.id = rbs.workflow_bag_id
    WHERE rbs.is_finalized = false
    GROUP BY rbs.stage
    ORDER BY oldest_min DESC
  `)) as unknown as Array<{
    stage: string;
    cnt: number;
    oldest_min: number;
  }>;

  return rows.map((r) => ({
    stage: r.stage,
    label: humanStage(r.stage),
    count: Number(r.cnt) || 0,
    oldestMinutes: Number(r.oldest_min) || 0,
  }));
}

async function loadStageCycles(
  shiftStartUtc: Date,
  since7d: Date,
): Promise<StageCycleBenchmarkRow[]> {
  const agg = async (since: Date) => {
    const [row] = await db
      .select({
        blister: sql<number>`ROUND(AVG(${readBagMetrics.blisterSeconds}))::int`,
        sealing: sql<number>`ROUND(AVG(${readBagMetrics.sealingSeconds}))::int`,
        packaging: sql<number>`ROUND(AVG(${readBagMetrics.packagingSeconds}))::int`,
        bags: sql<number>`COUNT(*)::int`,
      })
      .from(readBagMetrics)
      .where(gte(readBagMetrics.finalizedAt, since));
    return row;
  };

  const [shift, seven] = await Promise.all([agg(shiftStartUtc), agg(since7d)]);

  const stages: Array<{
    stage: string;
    label: string;
    shiftKey: "blister" | "sealing" | "packaging";
    sevenKey: "blister" | "sealing" | "packaging";
  }> = [
    { stage: "blister", label: "Blister room", shiftKey: "blister", sevenKey: "blister" },
    { stage: "sealing", label: "Sealing", shiftKey: "sealing", sevenKey: "sealing" },
    { stage: "packaging", label: "Packaging", shiftKey: "packaging", sevenKey: "packaging" },
  ];

  return stages.map(({ stage, label, shiftKey, sevenKey }) => ({
    stage,
    label,
    avgSecShift: shift?.[shiftKey] != null ? Number(shift[shiftKey]) : null,
    avgSec7d: seven?.[sevenKey] != null ? Number(seven[sevenKey]) : null,
    bagsShift: shift?.bags ?? 0,
  }));
}

async function loadDowntimeToday(shiftStartIso: string) {
  const rows = (await db.execute(sql`
    WITH paired AS (
      SELECT
        COALESCE(p.payload->>'reason', 'other') AS reason,
        p.occurred_at AS paused_at,
        (
          SELECT MIN(r.occurred_at) FROM workflow_events r
          WHERE r.workflow_bag_id = p.workflow_bag_id
            AND r.event_type = 'BAG_RESUMED'
            AND r.occurred_at > p.occurred_at
        ) AS resumed_at
      FROM workflow_events p
      WHERE p.event_type = 'BAG_PAUSED'
        AND p.occurred_at >= ${shiftStartIso}::timestamptz
    )
    SELECT
      reason,
      COUNT(*)::int AS occurrences,
      COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS total_seconds
    FROM paired
    WHERE resumed_at IS NOT NULL
    GROUP BY reason
    ORDER BY total_seconds DESC
    LIMIT 8
  `)) as unknown as Array<{
    reason: string;
    occurrences: number;
    total_seconds: number;
  }>;

  return rows.map((r) => ({
    reason: r.reason,
    occurrences: Number(r.occurrences) || 0,
    totalMinutes: Math.round((Number(r.total_seconds) || 0) / 60),
  }));
}

async function loadFlavorToday(shiftDayKey: string) {
  const rows = await db
    .select({
      productName: products.name,
      units: sql<number>`COALESCE(SUM(${readDailyThroughput.unitsProduced}), 0)::int`,
      bags: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}), 0)::int`,
    })
    .from(readDailyThroughput)
    .leftJoin(products, eq(products.id, readDailyThroughput.productId))
    .where(eq(readDailyThroughput.day, sql`${shiftDayKey}::date`))
    .groupBy(products.name)
    .orderBy(sql`SUM(${readDailyThroughput.unitsProduced}) DESC`)
    .limit(8);

  return rows.map((r) => ({
    productName: r.productName ?? "—",
    units: Number(r.units) || 0,
    bags: Number(r.bags) || 0,
  }));
}

async function loadMaterialRunway(): Promise<number | null> {
  try {
    const rows = (await db.execute(sql`
      WITH burn7 AS (
        SELECT packaging_material_id, AVG(qty_consumed)::float AS daily_burn
        FROM read_material_burn
        WHERE day >= (CURRENT_DATE - INTERVAL '7 days')
        GROUP BY packaging_material_id
        HAVING AVG(qty_consumed) > 0
      ),
      onhand AS (
        SELECT pl.packaging_material_id, SUM(pl.qty_on_hand)::float AS qty
        FROM packaging_lots pl
        WHERE pl.qty_on_hand > 0
        GROUP BY pl.packaging_material_id
      )
      SELECT MIN(o.qty / NULLIF(b.daily_burn, 0)) AS runway_days
      FROM onhand o
      JOIN burn7 b USING (packaging_material_id)
    `)) as unknown as Array<{ runway_days: number | null }>;
    const v = rows[0]?.runway_days;
    return v != null ? Number(v) : null;
  } catch {
    return null;
  }
}

async function loadLaneImbalance() {
  const since = new Date(Date.now() - 24 * ONE_DAY_MS);
  const [counts] = await db
    .select({
      cardBlistered: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BLISTER_COMPLETE')::int`,
      cardPackaged: sql<number>`COUNT(*) FILTER (WHERE event_type::text IN ('PACKAGING_SNAPSHOT','PACKAGING_COMPLETE'))::int`,
      bottleHandpacked: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BOTTLE_HANDPACK_COMPLETE')::int`,
      bottleStickered: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BOTTLE_STICKER_COMPLETE')::int`,
    })
    .from(workflowEvents)
    .where(gte(workflowEvents.occurredAt, since));
  return counts ?? null;
}

function formatLaneImbalance(
  counts: {
    cardBlistered: number;
    cardPackaged: number;
    bottleHandpacked: number;
    bottleStickered: number;
  } | null,
): string | null {
  if (!counts) return null;
  const cb = counts.cardBlistered ?? 0;
  const cp = counts.cardPackaged ?? 0;
  const bh = counts.bottleHandpacked ?? 0;
  const bs = counts.bottleStickered ?? 0;
  if (cp > 0 && cb / cp > 1.25) {
    return `Card lane: blister ${(cb / cp).toFixed(2)}× ahead of packaging`;
  }
  if (cp > 0 && cb / cp < 0.8) {
    return `Card lane: packaging ahead of blister`;
  }
  if (bs > 0 && bh / bs > 1.25) {
    return `Bottle lane: fill ${(bh / bs).toFixed(2)}× ahead of sticker`;
  }
  return null;
}

async function loadDamageCluster() {
  try {
    const rows = (await db.execute(sql`
      WITH per_hour AS (
        SELECT date_trunc('hour', occurred_at) AS hr, COUNT(*)::int AS dmg
        FROM workflow_events
        WHERE event_type = 'PACKAGING_DAMAGE_RETURN'
          AND occurred_at >= now() - INTERVAL '7 days'
        GROUP BY 1
      ),
      stats AS (
        SELECT AVG(dmg)::float AS mean_d, COALESCE(STDDEV(dmg), 0)::float AS sd_d,
               COUNT(*)::int AS n_hrs
        FROM per_hour
      ),
      this_hour AS (
        SELECT COUNT(*)::int AS dmg FROM workflow_events
        WHERE event_type = 'PACKAGING_DAMAGE_RETURN'
          AND occurred_at >= date_trunc('hour', now())
      )
      SELECT th.dmg, s.mean_d, s.sd_d, s.n_hrs
      FROM this_hour th, stats s
    `)) as unknown as Array<{
      dmg: number;
      mean_d: number | null;
      sd_d: number | null;
      n_hrs: number;
    }>;
    const r = rows[0];
    if (!r || !r.n_hrs || r.n_hrs < 6) {
      return { isCluster: false };
    }
    const mean = Number(r.mean_d) || 0;
    const sd = Number(r.sd_d) || 0;
    const cur = Number(r.dmg) || 0;
    return { isCluster: cur > mean + 2 * sd && cur >= 2 };
  } catch {
    return { isCluster: false };
  }
}

async function loadDataGaps(shiftDayKey: string) {
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM production_calendars) AS production_calendars,
      (SELECT COUNT(*)::int FROM station_standards WHERE is_active = true) AS station_standards,
      (SELECT COUNT(*)::int FROM labor_rates) AS labor_rates,
      (SELECT COUNT(*)::int FROM due_targets WHERE completed_at IS NULL) AS due_targets,
      (SELECT COUNT(*)::int FROM products WHERE daily_unit_goal IS NOT NULL) AS products_with_daily_goals,
      (SELECT COUNT(*)::int FROM machines WHERE is_active = true AND target_bags_per_hour IS NOT NULL) AS active_machines_with_targets,
      (SELECT COUNT(*)::int FROM stations WHERE is_active = true) AS active_stations,
      (
        SELECT COUNT(*)::int
        FROM read_station_live rsl
        INNER JOIN stations s ON s.id = rsl.station_id
        WHERE s.is_active = true
      ) AS station_live_rows,
      (SELECT COUNT(*)::int FROM read_queue_state) AS queue_rows,
      (
        SELECT COUNT(*)::int
        FROM workflow_bags wb
        LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
        WHERE wb.finalized_at IS NULL
          AND rbs.workflow_bag_id IS NULL
      ) AS in_flight_without_state,
      (SELECT COALESCE(SUM(units_produced), 0)::int FROM read_daily_throughput) AS read_daily_units,
      (SELECT COALESCE(SUM(units_yielded), 0)::int FROM read_bag_metrics) AS bag_metric_units,
      (
        SELECT COUNT(*)::int
        FROM read_material_burn
        WHERE day >= CURRENT_DATE - INTERVAL '7 days'
      ) AS material_burn_rows_7d,
      (
        SELECT COUNT(*)::int
        FROM read_operator_daily
        WHERE day = ${shiftDayKey}::date
      ) AS read_operator_daily_rows,
      (
        SELECT COUNT(*)::int
        FROM workflow_events
        WHERE event_type::text = 'PACKAGING_DAMAGE_RETURN'
          AND occurred_at >= now() - INTERVAL '7 days'
      ) AS damage_events_7d,
      (
        SELECT COUNT(*)::int
        FROM workflow_events
        WHERE event_type::text LIKE '%REWORK%'
          AND occurred_at >= now() - INTERVAL '7 days'
      ) AS rework_events_7d,
      (
        SELECT COUNT(*)::int
        FROM workflow_events
        WHERE event_type::text = 'SCRAP_RECORDED'
          AND occurred_at >= now() - INTERVAL '7 days'
      ) AS scrap_events_7d,
      (
        SELECT COUNT(*)::int
        FROM workflow_events
        WHERE event_type::text = 'SUBMISSION_CORRECTED'
          AND occurred_at >= now() - INTERVAL '7 days'
      ) AS correction_events_7d
  `)) as unknown as Array<{
    production_calendars: number;
    station_standards: number;
    labor_rates: number;
    due_targets: number;
    products_with_daily_goals: number;
    active_machines_with_targets: number;
    active_stations: number;
    station_live_rows: number;
    queue_rows: number;
    in_flight_without_state: number;
    read_daily_units: number;
    bag_metric_units: number;
    material_burn_rows_7d: number;
    read_operator_daily_rows: number;
    damage_events_7d: number;
    rework_events_7d: number;
    scrap_events_7d: number;
    correction_events_7d: number;
  }>;

  return buildFloorDataGaps({
    productionCalendars: Number(row?.production_calendars ?? 0),
    stationStandards: Number(row?.station_standards ?? 0),
    laborRates: Number(row?.labor_rates ?? 0),
    dueTargets: Number(row?.due_targets ?? 0),
    productsWithDailyGoals: Number(row?.products_with_daily_goals ?? 0),
    activeMachinesWithTargets: Number(row?.active_machines_with_targets ?? 0),
    activeStations: Number(row?.active_stations ?? 0),
    stationLiveRows: Number(row?.station_live_rows ?? 0),
    queueRows: Number(row?.queue_rows ?? 0),
    inFlightWithoutState: Number(row?.in_flight_without_state ?? 0),
    readDailyUnits: Number(row?.read_daily_units ?? 0),
    bagMetricUnits: Number(row?.bag_metric_units ?? 0),
    materialBurnRows7d: Number(row?.material_burn_rows_7d ?? 0),
    readOperatorDailyRows: Number(row?.read_operator_daily_rows ?? 0),
    damageEvents7d: Number(row?.damage_events_7d ?? 0),
    reworkEvents7d: Number(row?.rework_events_7d ?? 0),
    scrapEvents7d: Number(row?.scrap_events_7d ?? 0),
    correctionEvents7d: Number(row?.correction_events_7d ?? 0),
  });
}

async function loadPauseCostToday(shiftStartIso: string) {
  const rows = (await db.execute(sql`
    WITH paired AS (
      SELECT
        p.occurred_at AS paused_at,
        (
          SELECT MIN(r.occurred_at) FROM workflow_events r
          WHERE r.workflow_bag_id = p.workflow_bag_id
            AND r.event_type = 'BAG_RESUMED'
            AND r.occurred_at > p.occurred_at
        ) AS resumed_at
      FROM workflow_events p
      WHERE p.event_type = 'BAG_PAUSED'
        AND p.occurred_at >= ${shiftStartIso}::timestamptz
    )
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS paused_seconds
    FROM paired
    WHERE resumed_at IS NOT NULL
  `)) as unknown as Array<{ paused_seconds: number }>;
  const seconds = Number(rows[0]?.paused_seconds ?? 0);
  return {
    pausedSeconds: seconds,
    costUsd: Math.round((seconds / 3600) * PAUSE_LABOR_USD_PER_HOUR),
  };
}
