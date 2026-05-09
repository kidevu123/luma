// Floor-board loaders. Heavy SQL lives here so the page file stays
// focused on layout. Each loader logs to stderr on failure so a bug
// shows up in `docker logs luma-app-1` instead of crashing the page
// silently. Wrapped in trace() in page.tsx; this layer adds a guard
// so a fault in one loader doesn't poison the others.
//
// Per CLAUDE.md (luma):
//   - never bare `${date}` in raw SQL — use `${d.toISOString()}::timestamptz`
//     or Drizzle helpers.
//   - never `ANY(::enum[])` — use `IN (${sql.join(...)})` with `::text` cast.
//   - log + rethrow; the page's trace() will surface the right label.

import { db } from "@/lib/db";
import { sql, eq, and, gte, lt, isNull, isNotNull, desc } from "drizzle-orm";
import {
  workflowEvents,
  workflowBags,
  readBagState,
  readDailyThroughput,
  readBagMetrics,
  inventoryBags,
  products,
  machines,
  stations,
  qrCards,
  legacyCompressors,
} from "@/lib/db/schema";

const ONE_MIN = 60_000;
const ONE_HOUR = 60 * ONE_MIN;
const ONE_DAY = 24 * ONE_HOUR;

// ─── KPI strip loaders ───────────────────────────────────────────────────

/** Cycle-time stats over last 7 days of finalized bags. p50 and p90
 *  in seconds. Null when no signal. */
export async function getCycleStats(): Promise<{
  p50: number | null;
  p90: number | null;
  avg: number | null;
  count: number;
}> {
  console.error("[floor-board] getCycleStats start");
  try {
    const since = new Date(Date.now() - 7 * ONE_DAY);
    const rows = await db
      .select({ totalSeconds: readBagMetrics.totalSeconds })
      .from(readBagMetrics)
      .where(gte(readBagMetrics.finalizedAt, since));
    if (rows.length === 0) return { p50: null, p90: null, avg: null, count: 0 };
    const arr = rows.map((r) => r.totalSeconds).sort((a, b) => a - b);
    const idx50 = Math.floor(arr.length * 0.5);
    const idx90 = Math.min(arr.length - 1, Math.floor(arr.length * 0.9));
    const sum = arr.reduce((s, n) => s + n, 0);
    return {
      p50: arr[idx50] ?? null,
      p90: arr[idx90] ?? null,
      avg: arr.length > 0 ? sum / arr.length : null,
      count: arr.length,
    };
  } catch (err) {
    console.error("[floor-board] getCycleStats failed:", err);
    throw err;
  }
}

/** Today's hourly throughput. Returns the avg-per-hour-so-far +
 *  current-hour count so we can chip "12 / 9 avg" on the KPI strip. */
export async function getHourlyPace(): Promise<{
  thisHour: number;
  avgPerHour: number;
  hoursElapsed: number;
}> {
  console.error("[floor-board] getHourlyPace start");
  try {
    // "This hour" = events that fired in the last 60 minutes that are
    // production-stage events (a packaging/sealing/blister/bottle
    // complete). Total today = production-stage events since local
    // midnight (ET). Avg/hour = total / hoursElapsed.
    const rows = (await db.execute(sql`
      WITH bounds AS (
        SELECT
          (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') AS day_start,
          (now() - INTERVAL '60 minutes') AS hour_ago
      )
      SELECT
        (SELECT EXTRACT(EPOCH FROM (now() - day_start)) / 3600 FROM bounds)::float AS hours_elapsed,
        COUNT(*) FILTER (
          WHERE we.event_type::text IN (
            'BLISTER_COMPLETE','SEALING_COMPLETE',
            'PACKAGING_COMPLETE','PACKAGING_SNAPSHOT',
            'BOTTLE_HANDPACK_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE',
            'BOTTLE_STICKER_COMPLETE','BAG_FINALIZED'
          )
            AND we.occurred_at >= (SELECT day_start FROM bounds)
        )::int AS today_count,
        COUNT(*) FILTER (
          WHERE we.event_type::text IN (
            'BLISTER_COMPLETE','SEALING_COMPLETE',
            'PACKAGING_COMPLETE','PACKAGING_SNAPSHOT',
            'BOTTLE_HANDPACK_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE',
            'BOTTLE_STICKER_COMPLETE','BAG_FINALIZED'
          )
            AND we.occurred_at >= (SELECT hour_ago FROM bounds)
        )::int AS hour_count
      FROM workflow_events we
    `)) as unknown as Array<{
      hours_elapsed: number;
      today_count: number;
      hour_count: number;
    }>;
    const r = rows[0];
    if (!r) return { thisHour: 0, avgPerHour: 0, hoursElapsed: 0 };
    const hoursElapsed = Math.max(0.5, Number(r.hours_elapsed) || 0);
    const avgPerHour = Number(r.today_count) / hoursElapsed;
    return {
      thisHour: Number(r.hour_count) || 0,
      avgPerHour,
      hoursElapsed,
    };
  } catch (err) {
    console.error("[floor-board] getHourlyPace failed:", err);
    throw err;
  }
}

/** Idle-station counts NOW. "Idle" = no event in last 5 minutes. */
export async function getStationIdleNow(): Promise<{
  total: number;
  idle: number;
}> {
  console.error("[floor-board] getStationIdleNow start");
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * ONE_MIN);
    const [row] = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        idle: sql<number>`COUNT(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_events we
            WHERE we.station_id = ${stations.id}
              AND we.occurred_at >= ${fiveMinAgo.toISOString()}::timestamptz
          )
        )::int`,
      })
      .from(stations)
      .where(eq(stations.isActive, true));
    return {
      total: row?.total ?? 0,
      idle: row?.idle ?? 0,
    };
  } catch (err) {
    console.error("[floor-board] getStationIdleNow failed:", err);
    throw err;
  }
}

/** Idle QR cards. Same shape as `qrCards.status = IDLE` in the existing
 *  loader — surfaced separately here so KPI strip can reuse cleanly. */
export async function getIdleCards(): Promise<{ idle: number; total: number }> {
  console.error("[floor-board] getIdleCards start");
  try {
    const [row] = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        idle: sql<number>`COUNT(*) FILTER (WHERE ${qrCards.status} = 'IDLE')::int`,
      })
      .from(qrCards);
    return {
      total: row?.total ?? 0,
      idle: row?.idle ?? 0,
    };
  } catch (err) {
    console.error("[floor-board] getIdleCards failed:", err);
    throw err;
  }
}

// ─── per-machine lifeline ────────────────────────────────────────────────

/** Per-machine lifelines — for each machine returns:
 *    - last event time + type
 *    - current bag (id, product, started_at) when station_live points
 *    - today's finalized + units count
 *    - 24h hourly events (24-bucket array)
 *    - product 7d avg cycle (s) for the current bag's product, when known
 *    - compressors (from legacy_compressors)
 */
export type MachineLifeline = {
  machineId: string;
  name: string;
  kind: string;
  cardsPerTurn: number;
  // status + last activity
  lastEventAt: Date | null;
  lastEventType: string | null;
  // current run
  currentBagId: string | null;
  currentReceiptNumber: string | null;
  currentProductId: string | null;
  currentProductName: string | null;
  currentBagStartedAt: Date | null;
  currentProductAvgCycleSec: number | null;
  // today
  todayFinalized: number;
  todayPackaged: number;
  todayBlistered: number;
  todaySealed: number;
  todayUnits: number;
  // 24h heartbeat
  hourly: number[]; // length 24, oldest first
  // compressors
  compressors: Array<{ name: string; status: string }>;
};

export async function getMachineLifelines(): Promise<MachineLifeline[]> {
  console.error("[floor-board] getMachineLifelines start");
  try {
    const since24h = new Date(Date.now() - 24 * ONE_HOUR);
    const today = new Date().toISOString().slice(0, 10);

    // Single big query: per machine, the last event, the most recent
    // bag claimed via any of its stations, today's throughput totals,
    // and a 24-hour hourly event count.
    const rows = (await db.execute(sql`
      WITH machine_today AS (
        SELECT
          machine_id,
          COALESCE(SUM(bags_finalized), 0)::int AS finalized,
          COALESCE(SUM(bags_packaged), 0)::int AS packaged,
          COALESCE(SUM(bags_blistered), 0)::int AS blistered,
          COALESCE(SUM(bags_sealed), 0)::int AS sealed,
          COALESCE(SUM(units_produced), 0)::int AS units
        FROM read_daily_throughput
        WHERE day = ${today}
        GROUP BY machine_id
      ),
      machine_last AS (
        SELECT DISTINCT ON (s.machine_id)
          s.machine_id,
          we.event_type::text AS event_type,
          we.occurred_at AS occurred_at,
          we.workflow_bag_id AS workflow_bag_id
        FROM workflow_events we
        JOIN stations s ON s.id = we.station_id
        WHERE s.machine_id IS NOT NULL
        ORDER BY s.machine_id, we.occurred_at DESC
      ),
      machine_hourly AS (
        SELECT
          s.machine_id,
          floor(EXTRACT(EPOCH FROM (now() - we.occurred_at)) / 3600)::int AS hours_ago,
          COUNT(*)::int AS n
        FROM workflow_events we
        JOIN stations s ON s.id = we.station_id
        WHERE s.machine_id IS NOT NULL
          AND we.occurred_at >= ${since24h.toISOString()}::timestamptz
        GROUP BY s.machine_id, hours_ago
      ),
      machine_hourly_array AS (
        SELECT
          machine_id,
          ARRAY(
            SELECT COALESCE(
              (SELECT n FROM machine_hourly h WHERE h.machine_id = mh.machine_id AND h.hours_ago = i),
              0
            )
            FROM generate_series(23, 0, -1) AS i
          ) AS hourly
        FROM (SELECT DISTINCT machine_id FROM machine_hourly) mh
      )
      SELECT
        m.id AS machine_id,
        m.name,
        m.kind::text AS kind,
        m.cards_per_turn,
        ml.event_type AS last_event_type,
        ml.occurred_at AS last_event_at,
        mt.finalized AS today_finalized,
        mt.packaged AS today_packaged,
        mt.blistered AS today_blistered,
        mt.sealed AS today_sealed,
        mt.units AS today_units,
        COALESCE(mha.hourly, ARRAY[]::int[]) AS hourly
      FROM machines m
      LEFT JOIN machine_last ml ON ml.machine_id = m.id
      LEFT JOIN machine_today mt ON mt.machine_id = m.id
      LEFT JOIN machine_hourly_array mha ON mha.machine_id = m.id
      WHERE m.is_active = true
      ORDER BY m.name
    `)) as unknown as Array<{
      machine_id: string;
      name: string;
      kind: string;
      cards_per_turn: number;
      last_event_type: string | null;
      last_event_at: string | null;
      today_finalized: number | null;
      today_packaged: number | null;
      today_blistered: number | null;
      today_sealed: number | null;
      today_units: number | null;
      hourly: number[] | null;
    }>;

    // For each machine, find any station's "current bag" via read_station_live
    // and join product/started_at. Most stations idle → empty result fast.
    const liveBags = (await db.execute(sql`
      SELECT DISTINCT ON (s.machine_id)
        s.machine_id,
        rsl.current_workflow_bag_id AS bag_id,
        wb.receipt_number,
        wb.product_id,
        p.name AS product_name,
        wb.started_at
      FROM stations s
      JOIN read_station_live rsl ON rsl.station_id = s.id
      JOIN workflow_bags wb ON wb.id = rsl.current_workflow_bag_id
      LEFT JOIN products p ON p.id = wb.product_id
      WHERE s.machine_id IS NOT NULL
        AND rsl.current_workflow_bag_id IS NOT NULL
      ORDER BY s.machine_id, rsl.last_event_at DESC NULLS LAST
    `)) as unknown as Array<{
      machine_id: string;
      bag_id: string;
      receipt_number: string | null;
      product_id: string | null;
      product_name: string | null;
      started_at: string;
    }>;
    const liveByMachine = new Map(liveBags.map((r) => [r.machine_id, r]));

    // Product 7d avg cycle, keyed by productId.
    const since7d = new Date(Date.now() - 7 * ONE_DAY);
    const productCycles = await db
      .select({
        productId: readBagMetrics.productId,
        avgCycleSec: sql<number>`COALESCE(AVG(${readBagMetrics.totalSeconds}), 0)::int`,
      })
      .from(readBagMetrics)
      .where(
        and(
          gte(readBagMetrics.finalizedAt, since7d),
          isNotNull(readBagMetrics.productId),
        ),
      )
      .groupBy(readBagMetrics.productId);
    const avgCycleByProduct = new Map(
      productCycles.map((r) => [r.productId, r.avgCycleSec]),
    );

    // Compressors per machine — legacy table, may be empty.
    const compressors = await db
      .select({
        machineId: legacyCompressors.machineId,
        name: legacyCompressors.compressorName,
        status: legacyCompressors.status,
        isActive: legacyCompressors.isActive,
      })
      .from(legacyCompressors)
      .where(eq(legacyCompressors.isActive, true));
    const compressorsByMachine = new Map<
      string,
      Array<{ name: string; status: string }>
    >();
    for (const c of compressors) {
      if (!c.machineId) continue;
      const list = compressorsByMachine.get(c.machineId) ?? [];
      list.push({ name: c.name, status: c.status });
      compressorsByMachine.set(c.machineId, list);
    }

    return rows.map((r) => {
      const live = liveByMachine.get(r.machine_id);
      const hourly = Array.isArray(r.hourly)
        ? r.hourly.map((n) => Number(n) || 0)
        : [];
      // Pad to 24 entries (oldest first).
      while (hourly.length < 24) hourly.unshift(0);
      const truncatedHourly = hourly.slice(-24);
      const productId = live?.product_id ?? null;
      return {
        machineId: r.machine_id,
        name: r.name,
        kind: r.kind,
        cardsPerTurn: Number(r.cards_per_turn) || 1,
        lastEventAt: r.last_event_at ? new Date(r.last_event_at) : null,
        lastEventType: r.last_event_type,
        currentBagId: live?.bag_id ?? null,
        currentReceiptNumber: live?.receipt_number ?? null,
        currentProductId: productId,
        currentProductName: live?.product_name ?? null,
        currentBagStartedAt: live?.started_at ? new Date(live.started_at) : null,
        currentProductAvgCycleSec: productId
          ? (avgCycleByProduct.get(productId) ?? null)
          : null,
        todayFinalized: Number(r.today_finalized) || 0,
        todayPackaged: Number(r.today_packaged) || 0,
        todayBlistered: Number(r.today_blistered) || 0,
        todaySealed: Number(r.today_sealed) || 0,
        todayUnits: Number(r.today_units) || 0,
        hourly: truncatedHourly,
        compressors: compressorsByMachine.get(r.machine_id) ?? [],
      };
    });
  } catch (err) {
    console.error("[floor-board] getMachineLifelines failed:", err);
    throw err;
  }
}

// ─── station status grid ─────────────────────────────────────────────────

export type StationStatusRow = {
  stationId: string;
  label: string;
  kind: string;
  machineName: string | null;
  lastEventAt: Date | null;
  lastEventType: string | null;
  currentReceiptNumber: string | null;
  currentProductName: string | null;
};

export async function getStationStatusGrid(): Promise<StationStatusRow[]> {
  console.error("[floor-board] getStationStatusGrid start");
  try {
    const rows = (await db.execute(sql`
      SELECT
        s.id AS station_id,
        s.label,
        s.kind::text AS kind,
        m.name AS machine_name,
        rsl.last_event_at,
        rsl.last_event_type,
        wb.receipt_number,
        p.name AS product_name
      FROM stations s
      LEFT JOIN machines m ON m.id = s.machine_id
      LEFT JOIN read_station_live rsl ON rsl.station_id = s.id
      LEFT JOIN workflow_bags wb ON wb.id = rsl.current_workflow_bag_id
      LEFT JOIN products p ON p.id = wb.product_id
      WHERE s.is_active = true
      ORDER BY s.label
    `)) as unknown as Array<{
      station_id: string;
      label: string;
      kind: string;
      machine_name: string | null;
      last_event_at: string | null;
      last_event_type: string | null;
      receipt_number: string | null;
      product_name: string | null;
    }>;
    return rows.map((r) => ({
      stationId: r.station_id,
      label: r.label,
      kind: r.kind,
      machineName: r.machine_name,
      lastEventAt: r.last_event_at ? new Date(r.last_event_at) : null,
      lastEventType: r.last_event_type,
      currentReceiptNumber: r.receipt_number,
      currentProductName: r.product_name,
    }));
  } catch (err) {
    console.error("[floor-board] getStationStatusGrid failed:", err);
    throw err;
  }
}

// ─── flavor breakdown ────────────────────────────────────────────────────

export type FlavorRow = {
  productId: string | null;
  productName: string;
  units: number;
  bags: number;
};

export async function getFlavorBreakdownToday(): Promise<FlavorRow[]> {
  console.error("[floor-board] getFlavorBreakdownToday start");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db
      .select({
        productId: readDailyThroughput.productId,
        productName: products.name,
        units: sql<number>`COALESCE(SUM(${readDailyThroughput.unitsProduced}), 0)::int`,
        bags: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}), 0)::int`,
      })
      .from(readDailyThroughput)
      .leftJoin(products, eq(products.id, readDailyThroughput.productId))
      .where(eq(readDailyThroughput.day, today))
      .groupBy(readDailyThroughput.productId, products.name)
      .orderBy(sql`SUM(${readDailyThroughput.unitsProduced}) DESC`);
    return rows.map((r) => ({
      productId: r.productId,
      productName: r.productName ?? "—",
      units: r.units,
      bags: r.bags,
    }));
  } catch (err) {
    console.error("[floor-board] getFlavorBreakdownToday failed:", err);
    throw err;
  }
}

// ─── pause-reason donut (last 7d) ────────────────────────────────────────

export type PauseReasonRow = {
  reason: string;
  totalSeconds: number;
  occurrences: number;
};

export async function getPauseReasons7d(): Promise<PauseReasonRow[]> {
  console.error("[floor-board] getPauseReasons7d start");
  try {
    const since = new Date(Date.now() - 7 * ONE_DAY);
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
          AND p.occurred_at >= ${since.toISOString()}::timestamptz
      )
      SELECT
        reason,
        COUNT(*)::int AS occurrences,
        COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS total_seconds
      FROM paired
      WHERE resumed_at IS NOT NULL
      GROUP BY reason
      ORDER BY total_seconds DESC
    `)) as unknown as Array<{
      reason: string;
      occurrences: number;
      total_seconds: number;
    }>;
    return rows.map((r) => ({
      reason: r.reason,
      occurrences: Number(r.occurrences) || 0,
      totalSeconds: Number(r.total_seconds) || 0,
    }));
  } catch (err) {
    console.error("[floor-board] getPauseReasons7d failed:", err);
    throw err;
  }
}

// ─── operator-on-shift table (last 24h) ──────────────────────────────────

export type OperatorOnShiftRow = {
  /** Stable group key. Either an employee uuid or `__code:<code>` for
   *  legacy payload-only rows. */
  groupKey: string;
  /** Display label — employees.fullName when known, else the typed
   *  operator code. */
  displayName: string;
  /** Stable identity when accountability resolved. Null for legacy. */
  employeeId: string | null;
  /** Free-text code when known. May be null on employee-keyed rows
   *  whose events did not include a typed code. */
  operatorCode: string | null;
  /** HIGH for employee-keyed rows, LOW for legacy code-only rows. */
  confidence: "HIGH" | "LOW";
  events: number;
  lastEventAt: Date | null;
  distinctStations: number;
};

export async function getOperatorsOnShift24h(): Promise<{
  rows: OperatorOnShiftRow[];
  hasOperatorPayload: boolean;
}> {
  console.error("[floor-board] getOperatorsOnShift24h start");
  try {
    const since = new Date(Date.now() - 24 * ONE_HOUR);
    // OP-1E: prefer workflow_events.employee_id (HIGH confidence)
    // and fall back to payload->>'operator_code' for legacy events
    // that pre-date OP-1B / OP-1C accountability.
    const [seen] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(workflowEvents)
      .where(
        and(
          gte(workflowEvents.occurredAt, since),
          sql`(${workflowEvents.employeeId} IS NOT NULL OR ${workflowEvents.payload}->>'operator_code' IS NOT NULL)`,
        ),
      );
    if (!seen || seen.n === 0) {
      return { rows: [], hasOperatorPayload: false };
    }
    const rows = (await db.execute(sql`
      WITH attributed AS (
        SELECT
          we.id,
          we.station_id,
          we.occurred_at,
          we.employee_id,
          NULLIF(we.payload->>'operator_code', '') AS operator_code,
          CASE
            WHEN we.employee_id IS NOT NULL
              THEN we.employee_id::text
            ELSE '__code:' || COALESCE(we.payload->>'operator_code', '')
          END AS group_key
        FROM workflow_events we
        WHERE we.occurred_at >= ${since.toISOString()}::timestamptz
          AND (
            we.employee_id IS NOT NULL
            OR (we.payload->>'operator_code' IS NOT NULL
                AND we.payload->>'operator_code' <> '')
          )
      )
      SELECT
        a.group_key,
        MAX(a.employee_id::text) AS employee_id,
        MAX(a.operator_code) AS operator_code,
        e.full_name AS employee_full_name,
        COUNT(*)::int AS events,
        MAX(a.occurred_at) AS last_event_at,
        COUNT(DISTINCT a.station_id)::int AS distinct_stations
      FROM attributed a
      LEFT JOIN employees e ON e.id::text = a.group_key
      GROUP BY a.group_key, e.full_name
      ORDER BY events DESC
      LIMIT 8
    `)) as unknown as Array<{
      group_key: string;
      employee_id: string | null;
      operator_code: string | null;
      employee_full_name: string | null;
      events: number;
      last_event_at: string;
      distinct_stations: number;
    }>;
    return {
      rows: rows.map((r) => {
        const isEmployee = r.employee_id != null;
        const displayName = isEmployee
          ? r.employee_full_name ?? r.operator_code ?? r.employee_id!.slice(0, 8)
          : r.operator_code ?? "(unknown)";
        return {
          groupKey: r.group_key,
          displayName,
          employeeId: r.employee_id,
          operatorCode: r.operator_code,
          confidence: isEmployee ? "HIGH" : "LOW",
          events: Number(r.events) || 0,
          lastEventAt: r.last_event_at ? new Date(r.last_event_at) : null,
          distinctStations: Number(r.distinct_stations) || 0,
        };
      }),
      hasOperatorPayload: true,
    };
  } catch (err) {
    console.error("[floor-board] getOperatorsOnShift24h failed:", err);
    throw err;
  }
}

// ─── cost-of-pause callout ───────────────────────────────────────────────

const LABOR_RATE_USD_PER_HOUR = 25;

export async function getPauseCostToday(): Promise<{
  pausedSeconds: number;
  costUsd: number;
}> {
  console.error("[floor-board] getPauseCostToday start");
  try {
    // Sum all closed pauses (BAG_PAUSED→BAG_RESUMED) since local
    // midnight ET. Open pauses ignored — they go in the forgotten-bag
    // panel.
    const rows = (await db.execute(sql`
      WITH bounds AS (
        SELECT
          (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') AS day_start
      ),
      paired AS (
        SELECT
          p.occurred_at AS paused_at,
          (
            SELECT MIN(r.occurred_at) FROM workflow_events r
            WHERE r.workflow_bag_id = p.workflow_bag_id
              AND r.event_type = 'BAG_RESUMED'
              AND r.occurred_at > p.occurred_at
          ) AS resumed_at
        FROM workflow_events p, bounds b
        WHERE p.event_type = 'BAG_PAUSED'
          AND p.occurred_at >= b.day_start
      )
      SELECT
        COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS paused_seconds
      FROM paired
      WHERE resumed_at IS NOT NULL
    `)) as unknown as Array<{ paused_seconds: number }>;
    const seconds = Number(rows[0]?.paused_seconds ?? 0);
    return {
      pausedSeconds: seconds,
      costUsd: (seconds / 3600) * LABOR_RATE_USD_PER_HOUR,
    };
  } catch (err) {
    console.error("[floor-board] getPauseCostToday failed:", err);
    throw err;
  }
}

export const PAUSE_LABOR_RATE_USD_PER_HOUR = LABOR_RATE_USD_PER_HOUR;

// ─── lane-imbalance verdict (already had ratio in page; expose
//     the chip-ready text here so the alerts feed can also speak it). ──

export async function getLaneImbalanceChip(): Promise<{
  card: number | null;
  bottle: number | null;
  imbalanceSide: "card" | "bottle" | null;
}> {
  console.error("[floor-board] getLaneImbalanceChip start");
  try {
    const since = new Date(Date.now() - 24 * ONE_HOUR);
    const [counts] = await db
      .select({
        cardBlistered: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BLISTER_COMPLETE')::int`,
        cardPackaged: sql<number>`COUNT(*) FILTER (WHERE event_type::text IN ('PACKAGING_SNAPSHOT','PACKAGING_COMPLETE'))::int`,
        bottleHandpacked: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BOTTLE_HANDPACK_COMPLETE')::int`,
        bottleStickered: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BOTTLE_STICKER_COMPLETE')::int`,
      })
      .from(workflowEvents)
      .where(gte(workflowEvents.occurredAt, since));
    const cb = counts?.cardBlistered ?? 0;
    const cp = counts?.cardPackaged ?? 0;
    const bh = counts?.bottleHandpacked ?? 0;
    const bs = counts?.bottleStickered ?? 0;
    const cardRatio = cp > 0 ? cb / cp : null;
    const bottleRatio = bs > 0 ? bh / bs : null;
    const imbalanceSide: "card" | "bottle" | null =
      cardRatio !== null && (cardRatio > 1.3 || cardRatio < 0.77)
        ? "card"
        : bottleRatio !== null && (bottleRatio > 1.3 || bottleRatio < 0.77)
          ? "bottle"
          : null;
    return {
      card: cardRatio,
      bottle: bottleRatio,
      imbalanceSide,
    };
  } catch (err) {
    console.error("[floor-board] getLaneImbalanceChip failed:", err);
    throw err;
  }
}

// ─── top in-flight bags (bottom of page) ─────────────────────────────────

export type InFlightBagRow = {
  bagId: string;
  receiptNumber: string | null;
  productName: string | null;
  stage: string | null;
  startedAt: Date;
  lastEventAt: Date | null;
  isPaused: boolean;
  isOnHold: boolean;
};

export async function getTopInFlightBags(): Promise<InFlightBagRow[]> {
  console.error("[floor-board] getTopInFlightBags start");
  try {
    // Bags started in the last 14d (so legacy 30d+ ghost bags don't
    // dominate) that aren't finalized, sorted by elapsed desc.
    const since = new Date(Date.now() - 14 * ONE_DAY);
    const rows = await db
      .select({
        bagId: workflowBags.id,
        receiptNumber: workflowBags.receiptNumber,
        productName: products.name,
        startedAt: workflowBags.startedAt,
        stage: readBagState.stage,
        lastEventAt: readBagState.lastEventAt,
        isPaused: readBagState.isPaused,
        isOnHold: readBagState.isOnHold,
      })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
      .where(
        and(
          isNull(workflowBags.finalizedAt),
          gte(workflowBags.startedAt, since),
        ),
      )
      .orderBy(workflowBags.startedAt) // oldest-first = longest elapsed
      .limit(20);
    return rows.map((r) => ({
      bagId: r.bagId,
      receiptNumber: r.receiptNumber,
      productName: r.productName,
      stage: r.stage,
      startedAt: r.startedAt as unknown as Date,
      lastEventAt: r.lastEventAt as unknown as Date | null,
      isPaused: r.isPaused ?? false,
      isOnHold: r.isOnHold ?? false,
    }));
  } catch (err) {
    console.error("[floor-board] getTopInFlightBags failed:", err);
    throw err;
  }
}

// ─── damage cluster detector (only when synthesized data exists) ─────────

export type DamageClusterRow = {
  thisHourDamage: number;
  rollingMean: number;
  rollingStdDev: number;
  isCluster: boolean;
};

/** Looks at PACKAGING_DAMAGE_RETURN events (and the rippedCards on
 *  read_bag_metrics). A "cluster" is when this hour's damage rate is
 *  more than 2 standard deviations above the trailing 7d hourly
 *  mean. Returns hasData=false when there's no signal yet. */
export async function getDamageCluster(): Promise<{
  hasData: boolean;
  thisHourDamage: number;
  rollingMean: number;
  rollingStdDev: number;
  isCluster: boolean;
}> {
  console.error("[floor-board] getDamageCluster start");
  try {
    const rows = (await db.execute(sql`
      WITH per_hour AS (
        SELECT
          date_trunc('hour', occurred_at) AS hr,
          COUNT(*)::int AS dmg
        FROM workflow_events
        WHERE event_type = 'PACKAGING_DAMAGE_RETURN'
          AND occurred_at >= now() - INTERVAL '7 days'
        GROUP BY 1
      ),
      stats AS (
        SELECT
          AVG(dmg)::float AS mean_d,
          COALESCE(STDDEV(dmg), 0)::float AS sd_d,
          COUNT(*)::int AS n_hrs
        FROM per_hour
      ),
      this_hour AS (
        SELECT COUNT(*)::int AS dmg
        FROM workflow_events
        WHERE event_type = 'PACKAGING_DAMAGE_RETURN'
          AND occurred_at >= date_trunc('hour', now())
      )
      SELECT
        (SELECT dmg FROM this_hour)::int AS this_hour_dmg,
        (SELECT mean_d FROM stats)::float AS mean_d,
        (SELECT sd_d FROM stats)::float AS sd_d,
        (SELECT n_hrs FROM stats)::int AS n_hrs
    `)) as unknown as Array<{
      this_hour_dmg: number;
      mean_d: number | null;
      sd_d: number | null;
      n_hrs: number;
    }>;
    const r = rows[0];
    if (!r || !r.n_hrs || r.n_hrs < 6) {
      return {
        hasData: false,
        thisHourDamage: 0,
        rollingMean: 0,
        rollingStdDev: 0,
        isCluster: false,
      };
    }
    const mean = Number(r.mean_d) || 0;
    const sd = Number(r.sd_d) || 0;
    const cur = Number(r.this_hour_dmg) || 0;
    return {
      hasData: true,
      thisHourDamage: cur,
      rollingMean: mean,
      rollingStdDev: sd,
      isCluster: cur > mean + 2 * sd && cur >= 2,
    };
  } catch (err) {
    console.error("[floor-board] getDamageCluster failed:", err);
    throw err;
  }
}

// ─── material runway days (best-effort placeholder) ──────────────────────

/** Material runway = inventory on hand / daily burn rate. Phase-2:
 *  needs packaging_lots inventory + read_material_burn 7d to compute.
 *  For v1 we surface NULL when burn data isn't there yet — KPI tile
 *  shows "—". */
export async function getMaterialRunwayDays(): Promise<number | null> {
  console.error("[floor-board] getMaterialRunwayDays start");
  try {
    const rows = (await db.execute(sql`
      WITH burn7 AS (
        SELECT
          packaging_material_id,
          AVG(qty_consumed)::float AS daily_burn
        FROM read_material_burn
        WHERE day >= (CURRENT_DATE - INTERVAL '7 days')
        GROUP BY packaging_material_id
        HAVING AVG(qty_consumed) > 0
      ),
      onhand AS (
        SELECT
          pl.packaging_material_id,
          SUM(pl.qty_on_hand)::float AS qty
        FROM packaging_lots pl
        WHERE pl.qty_on_hand > 0
        GROUP BY pl.packaging_material_id
      )
      SELECT
        MIN(o.qty / NULLIF(b.daily_burn, 0)) AS runway_days
      FROM onhand o
      JOIN burn7 b USING (packaging_material_id)
    `)) as unknown as Array<{ runway_days: number | null }>;
    const r = rows[0];
    if (!r || r.runway_days == null) return null;
    return Number(r.runway_days);
  } catch (err) {
    // packaging_lots.qty_remaining may not exist yet — soft-fail to null.
    console.error(
      "[floor-board] getMaterialRunwayDays soft-failed (returning null):",
      err,
    );
    return null;
  }
}
