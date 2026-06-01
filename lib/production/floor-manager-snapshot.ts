// Production-manager view model for /floor-board — aggregates every
// metric a shift lead / plant manager needs in one server fetch.

import { and, eq, gte, isNull, sql } from "drizzle-orm";
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
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";

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
    stationsRows,
    productsRows,
    plantRows,
    wipRow,
    inFlightRows,
    downtimeRows,
    flavorRows,
    runwayRow,
    laneRow,
    damageClusterRow,
    operatorRows,
  ] = await Promise.all([
    loadMachineProduction(shiftStartIso, since7d, shiftDayKey),
    loadStationScans(now),
    loadProductMaterialYield(shiftStartUtc),
    loadPlantShiftStats(shiftStartUtc),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(readBagState)
      .where(eq(readBagState.isFinalized, false)),
    loadInFlight(),
    loadDowntimeToday(shiftStartIso),
    loadFlavorToday(shiftDayKey),
    loadMaterialRunway(),
    loadLaneImbalance(),
    loadDamageCluster(),
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
    flavorToday: flavorRows,
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

async function loadStationScans(now: Date) {
  const rows = (await db.execute(sql`
    SELECT
      s.id AS station_id,
      s.label,
      s.kind::text AS kind,
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
      avg_cycle: sql<number>`ROUND(AVG(${readBagMetrics.totalSeconds}))::int`,
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
  const since = new Date(Date.now() - 14 * ONE_DAY_MS);
  const rows = await db
    .select({
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
    .where(
      and(isNull(workflowBags.finalizedAt), gte(workflowBags.startedAt, since)),
    )
    .orderBy(workflowBags.startedAt)
    .limit(15);

  const now = Date.now();
  return rows.map((r) => ({
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
