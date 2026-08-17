// lib/production/floor-command.ts
import { db } from "@/lib/db";
import {
  machines,
  products,
  readQueueState,
  readStationLive,
  readDailyThroughput,
  readBagState,
  readOperatorDaily,
  readBagMetrics,
  stationExceptionReports,
  stations,
  workflowEvents,
  workflowBags,
  dueTargets,
} from "@/lib/db/schema";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { floorThroughputDayKey } from "@/lib/projector/index";
import type {
  AttentionItem,
  OperatorDailyRow,
  QueueHealthRow,
  ShiftTargetStatus,
  StationWithLive,
  ThroughputDataPoint,
} from "@/lib/floor-command/types";

export { computeShiftProgress } from "@/lib/production/shift-window";
import { computeShiftProgress } from "@/lib/production/shift-window";

// ---------------------------------------------------------------------------
// 1. Stations with live state
// ---------------------------------------------------------------------------

export async function getStationsWithLiveState(): Promise<StationWithLive[]> {
  const rows = await db
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
      machineId: stations.machineId,
      machineName: machines.name,
      machineTargetBagsPerHour: machines.targetBagsPerHour,
      isActive: stations.isActive,
      currentWorkflowBagId: readStationLive.currentWorkflowBagId,
      currentProductId: readStationLive.currentProductId,
      currentProductName: products.name,
      currentReceiptNumber: workflowBags.receiptNumber,
      currentEmployeeName: readStationLive.currentEmployeeName,
      lastEventType: readStationLive.lastEventType,
      lastEventAt: readStationLive.lastEventAt,
      busyForSeconds: readStationLive.busyForSeconds,
    })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .leftJoin(readStationLive, eq(stations.id, readStationLive.stationId))
    .leftJoin(products, eq(readStationLive.currentProductId, products.id))
    .leftJoin(
      workflowBags,
      eq(readStationLive.currentWorkflowBagId, workflowBags.id),
    )
    .where(eq(stations.isActive, true))
    .orderBy(stations.label);

  return rows.map((r) => ({
    ...r,
    kind: r.kind as StationWithLive["kind"],
    lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// 2. Queue health summary
// ---------------------------------------------------------------------------

export async function getQueueHealthSummary(): Promise<QueueHealthRow[]> {
  const rows = await db
    .select({
      stageKey: readQueueState.stageKey,
      wip: readQueueState.wip,
      oldestAgeSeconds: readQueueState.oldestAgeSeconds,
      avgAgeSeconds: readQueueState.avgAgeSeconds,
      p90AgeSeconds: readQueueState.p90AgeSeconds,
      bagsOverThreshold: readQueueState.bagsOverThreshold,
      queueStatus: readQueueState.queueStatus,
    })
    .from(readQueueState)
    .orderBy(readQueueState.stageKey);

  return rows.map((r) => ({
    ...r,
    queueStatus: r.queueStatus as QueueHealthRow["queueStatus"],
  }));
}

// ---------------------------------------------------------------------------
// 3. Shift target status
// ---------------------------------------------------------------------------

export async function getShiftTargetStatus(tz: string): Promise<ShiftTargetStatus> {
  const now = new Date();
  const { minutesElapsed, minutesRemaining, shiftStartUtc } =
    computeShiftProgress(now, tz);

  const todayStr = shiftStartUtc.toISOString().slice(0, 10);
  const throughputRows = await db
    .select({
      unitsProduced: sql<number>`coalesce(sum(${readDailyThroughput.unitsProduced}), 0)`,
      productId: readDailyThroughput.productId,
    })
    .from(readDailyThroughput)
    .where(eq(readDailyThroughput.day, sql`${todayStr}::date`))
    .groupBy(readDailyThroughput.productId);

  const unitsProduced = throughputRows.reduce(
    (acc, r) => acc + (Number(r.unitsProduced) ?? 0),
    0,
  );

  let dailyGoal: number | null = null;
  if (throughputRows.length > 0 && throughputRows[0]?.productId) {
    const productRow = await db
      .select({ dailyUnitGoal: products.dailyUnitGoal })
      .from(products)
      .where(eq(products.id, throughputRows[0].productId))
      .limit(1);
    dailyGoal = productRow[0]?.dailyUnitGoal ?? null;
  }

  if (dailyGoal == null) {
    const [dueSum] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${dueTargets.targetQuantity}), 0)::int`,
      })
      .from(dueTargets)
      .where(
        and(
          isNull(dueTargets.completedAt),
          sql`(${dueTargets.dueAt} AT TIME ZONE ${tz})::date = ${todayStr}::date`,
        ),
      );
    const dueTotal = Number(dueSum?.total ?? 0);
    if (dueTotal > 0) dailyGoal = dueTotal;
  }

  const projectedTotal =
    minutesElapsed > 0 && dailyGoal !== null
      ? Math.round(
          (unitsProduced / minutesElapsed) * (minutesElapsed + minutesRemaining),
        )
      : null;

  const gapUnits =
    dailyGoal !== null && projectedTotal !== null
      ? dailyGoal - projectedTotal
      : null;

  return {
    unitsProduced,
    dailyGoal,
    minutesElapsed,
    minutesRemaining,
    projectedTotal,
    gapUnits,
  };
}

// ---------------------------------------------------------------------------
// 4. Attention items
// ---------------------------------------------------------------------------

export async function getAttentionItems(): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const now = new Date();
  const idleThresholdMs = 5 * 60 * 1000;

  const liveRows = await db
    .select({
      stationId: readStationLive.stationId,
      label: stations.label,
      lastEventAt: readStationLive.lastEventAt,
      currentWorkflowBagId: readStationLive.currentWorkflowBagId,
    })
    .from(readStationLive)
    .innerJoin(stations, eq(readStationLive.stationId, stations.id))
    .where(
      and(
        eq(stations.isActive, true),
        isNull(readStationLive.currentWorkflowBagId),
      ),
    );

  for (const row of liveRows) {
    if (
      row.lastEventAt &&
      now.getTime() - row.lastEventAt.getTime() > idleThresholdMs
    ) {
      const idleMinutes = Math.floor(
        (now.getTime() - row.lastEventAt.getTime()) / 60000,
      );
      items.push({
        type: "idle_machine",
        label: row.label,
        detail: `idle ${idleMinutes} min`,
      });
    }
  }

  const reworkRows = await db
    .select({
      workflowBagId: readBagState.workflowBagId,
      currentOperatorCode: readBagState.currentOperatorCode,
    })
    .from(readBagState)
    .where(eq(readBagState.reworkPending, true))
    .limit(10);

  for (const row of reworkRows) {
    items.push({
      type: "rework_pending",
      label: `Bag ${row.workflowBagId.slice(0, 8)}`,
      detail: row.currentOperatorCode ?? "unknown operator",
    });
  }

  // P4b Task 4 — Report Problem's PRODUCTION_EXCEPTION_RAISED,
  // DOWNTIME_STARTED, and QA_HOLD_STARTED, so every category lands on
  // the Act Now rail (spec: "All land on the /floor-board Act Now
  // rail"). None of the three had ANY reader before this — grepping the
  // repo for each literal turned up only their schema.ts enum
  // declarations and this task's own new emitters. DOWNTIME_ENDED and
  // QA_HOLD_RELEASED exist on the enum but nothing emits them yet
  // (that pairing is P5 scope, same as the supervisor inbox/badge the
  // spec describes), so this is a straight recency window rather than
  // an unresolved-vs-resolved query like loadDowntimeToday's BAG_PAUSED/
  // BAG_RESUMED pairing (floor-manager-snapshot.ts) — a report simply
  // ages off the rail after a few hours instead of being dismissed.
  const exceptionRows = (await db.execute(sql`
    SELECT
      we.id AS id,
      we.event_type AS event_type,
      we.payload AS payload,
      we.occurred_at AS occurred_at,
      s.label AS station_label,
      wb.receipt_number AS receipt_number
    FROM workflow_events we
    LEFT JOIN stations s ON s.id = we.station_id
    LEFT JOIN workflow_bags wb ON wb.id = we.workflow_bag_id
    WHERE we.event_type::text IN
      ('PRODUCTION_EXCEPTION_RAISED', 'DOWNTIME_STARTED', 'QA_HOLD_STARTED')
      AND we.occurred_at >= now() - interval '4 hours'
    ORDER BY we.occurred_at DESC
    LIMIT 10
  `)) as unknown as Array<{
    id: string;
    event_type: "PRODUCTION_EXCEPTION_RAISED" | "DOWNTIME_STARTED" | "QA_HOLD_STARTED";
    payload: { category?: string; detail?: string } | null;
    occurred_at: string;
    station_label: string | null;
    receipt_number: string | null;
  }>;

  // P5 fix-round (MED Task 5): merge both operator-flagged buckets
  // (production_exception workflow events + station_report rows) into a
  // single list sorted by recency, THEN apply the EXCEPTION_ROWS_MAX=3
  // cap. Without this, older bagged DOWNTIME/QA rows in exceptionRows
  // consumed the full cap before any newer bagless MACHINE crit in
  // reportRows could enter the budget — starvation by insertion order.
  const EXCEPTION_ROWS_MAX = 3;

  // Build a unified intermediate list with an ISO timestamp for sorting.
  type ExceptionCandidate =
    | { source: "exception"; ts: string; item: AttentionItem }
    | { source: "report"; ts: string; item: AttentionItem };
  const candidates: ExceptionCandidate[] = [];

  for (const row of exceptionRows) {
    const kind =
      row.event_type === "DOWNTIME_STARTED"
        ? "Machine down"
        : row.event_type === "QA_HOLD_STARTED"
          ? "Quality hold"
          : (row.payload?.category ?? "Reported");
    candidates.push({
      source: "exception",
      ts: row.occurred_at,
      item: {
        type: "production_exception",
        label: row.station_label ?? "Unknown station",
        detail: [kind, row.payload?.detail].filter(Boolean).join(" — "),
        exceptionEventType: row.event_type,
        receiptNumber: row.receipt_number,
        // P6 Task 6(c): carry the event id so the admin rail can render
        // [ Resolved ] for DOWNTIME_STARTED rows.
        ...(row.event_type === "DOWNTIME_STARTED"
          ? { downtimeEventId: row.id }
          : {}),
      },
    });
  }

  // P5-SUPERVISOR Task 5(b) — unacknowledged bagless reports (MACHINE
  // and OTHER only, per raiseStationReport's own contract). Distinct
  // from the workflow_events exception rows above: those age off after
  // 4 hours (no dismissal path), while these persist until an admin
  // acknowledges them from the Act Now rail (Task 6 wires the ack
  // action). Read is scoped to acknowledged_at IS NULL and ordered by
  // recency so the most urgent (typically machine-down) surfaces first.
  const reportRows = await db
    .select({
      id: stationExceptionReports.id,
      category: stationExceptionReports.category,
      detail: stationExceptionReports.detail,
      createdAt: stationExceptionReports.createdAt,
      stationLabel: stations.label,
    })
    .from(stationExceptionReports)
    .innerJoin(stations, eq(stationExceptionReports.stationId, stations.id))
    .where(isNull(stationExceptionReports.acknowledgedAt))
    .orderBy(desc(stationExceptionReports.createdAt))
    .limit(10);

  for (const row of reportRows) {
    // Category comes back as text (schema stores it as text to avoid
    // ALTER TYPE); the engine layer validates the vocabulary on write,
    // so a non-MACHINE/OTHER row here is a data-hygiene anomaly worth
    // surfacing rather than silently dropping. Coerce to the union.
    const cat: "MACHINE" | "OTHER" =
      row.category === "OTHER" ? "OTHER" : "MACHINE";
    const kind = cat === "MACHINE" ? "Machine down" : "Reported";
    candidates.push({
      source: "report",
      ts: row.createdAt.toISOString(),
      item: {
        type: "station_report",
        label: row.stationLabel,
        detail: [kind, row.detail].filter(Boolean).join(" — "),
        stationReportCategory: cat,
        stationReportId: row.id,
      },
    });
  }

  // Sort merged bucket newest-first and admit only the cap-3 most recent
  // entries. This ensures a fresh bagless MACHINE crit is never starved
  // by older bagged DOWNTIME/QA rows that happen to have arrived earlier.
  candidates.sort((a, b) => b.ts.localeCompare(a.ts));
  for (const c of candidates.slice(0, EXCEPTION_ROWS_MAX)) {
    items.push(c.item);
  }

  return items;
}

// ---------------------------------------------------------------------------
// 5. Operator daily summary
// ---------------------------------------------------------------------------

export async function getOperatorDailySummary(
  tz: string,
): Promise<OperatorDailyRow[]> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);
  const todayStr = shiftStartUtc.toISOString().slice(0, 10);

  const rows = await db
    .select({
      operatorCode: readOperatorDaily.operatorCode,
      employeeId: readOperatorDaily.employeeId,
      bagsFinalized: readOperatorDaily.bagsFinalized,
      activeSecondsTotal: readOperatorDaily.activeSecondsTotal,
      damageEventsTotal: readOperatorDaily.damageEventsTotal,
      reworkSentTotal: readOperatorDaily.reworkSentTotal,
      correctionsTotal: readOperatorDaily.correctionsTotal,
    })
    .from(readOperatorDaily)
    .where(eq(readOperatorDaily.day, sql`${todayStr}::date`))
    .orderBy(desc(readOperatorDaily.bagsFinalized));

  // operatorCode is nullable in the DB (legacy rows may have only employee_id).
  // Coerce to a non-null string for the OperatorDailyRow contract using
  // the employee_id short form as fallback.
  return rows.map((r) => ({
    ...r,
    operatorCode: r.operatorCode ?? r.employeeId?.slice(0, 8) ?? "unknown",
  }));
}

// ---------------------------------------------------------------------------
// 6. KPI strip data
// ---------------------------------------------------------------------------

export type KpiStripData = {
  bagsToday: number;
  unitsOut: number;
  avgCycleSeconds: number | null;
  activeOperators: number;
  firstPassYieldPct: number | null;
  stationsCurrentlyIdle: number;
};

export async function getKpiStripData(tz: string): Promise<KpiStripData> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);
  const todayStr = floorThroughputDayKey(now);

  const [throughput, bagMetrics, liveStations] = await Promise.all([
    db
      .select({
        bagsFinalized: sql<number>`coalesce(sum(${readDailyThroughput.bagsFinalized}), 0)`,
        unitsProduced: sql<number>`coalesce(sum(${readDailyThroughput.unitsProduced}), 0)`,
      })
      .from(readDailyThroughput)
      .where(eq(readDailyThroughput.day, sql`${todayStr}::date`)),

    db
      .select({
        avgTotalSeconds: sql<number>`coalesce(avg(${readBagMetrics.totalSeconds}), 0)`,
        avgYieldPct: sql<number>`coalesce(avg(${readBagMetrics.yieldPct}), 0)`,
        cnt: sql<number>`count(*)`,
      })
      .from(readBagMetrics)
      .where(gte(readBagMetrics.finalizedAt, shiftStartUtc)),

    db
      .select({
        stationId: readStationLive.stationId,
        lastEventAt: readStationLive.lastEventAt,
        currentWorkflowBagId: readStationLive.currentWorkflowBagId,
      })
      .from(readStationLive)
      .innerJoin(stations, eq(readStationLive.stationId, stations.id))
      .where(eq(stations.isActive, true)),
  ]);

  const idleThresholdMs = 5 * 60 * 1000;
  const activeThresholdMs = 15 * 60 * 1000;

  const activeOperators = liveStations.filter(
    (s) =>
      s.lastEventAt &&
      now.getTime() - s.lastEventAt.getTime() < activeThresholdMs,
  ).length;

  const stationsCurrentlyIdle = liveStations.filter(
    (s) =>
      s.currentWorkflowBagId === null &&
      s.lastEventAt &&
      now.getTime() - s.lastEventAt.getTime() > idleThresholdMs,
  ).length;

  const bagData = bagMetrics[0];
  const t = throughput[0];

  return {
    bagsToday: Number(t?.bagsFinalized ?? 0),
    unitsOut: Number(t?.unitsProduced ?? 0),
    avgCycleSeconds:
      bagData && Number(bagData.cnt) > 0
        ? Math.round(Number(bagData.avgTotalSeconds))
        : null,
    activeOperators,
    firstPassYieldPct:
      bagData && Number(bagData.cnt) > 0
        ? Math.round(Number(bagData.avgYieldPct) * 10) / 10
        : null,
    stationsCurrentlyIdle,
  };
}

// ---------------------------------------------------------------------------
// 7. Recent events
// ---------------------------------------------------------------------------

export type RecentEventRow = {
  id: string;
  eventType: string;
  workflowBagId: string;
  stationId: string | null;
  employeeId: string | null;
  occurredAt: string;
};

export async function getRecentEvents(limit = 30): Promise<RecentEventRow[]> {
  const rows = await db
    .select({
      id: workflowEvents.id,
      eventType: workflowEvents.eventType,
      workflowBagId: workflowEvents.workflowBagId,
      stationId: workflowEvents.stationId,
      employeeId: workflowEvents.employeeId,
      occurredAt: workflowEvents.occurredAt,
    })
    .from(workflowEvents)
    .orderBy(desc(workflowEvents.occurredAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    eventType: r.eventType as string,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// 8. buildShiftStatusData (pure — no DB)
// ---------------------------------------------------------------------------

import type {
  ShiftStatusData,
  StatusCell,
} from "@/lib/floor-command/types";

export function buildShiftStatusData(
  target: ShiftTargetStatus,
  queues: QueueHealthRow[],
  yieldPct: number | null,
  attention: AttentionItem[],
): ShiftStatusData {
  let targetCell: StatusCell;
  if (target.dailyGoal === null) {
    targetCell = {
      label: "Target",
      value: `${target.unitsProduced.toLocaleString()} units`,
      detail:
        "no goal — set product daily goal or open due targets for today",
      level: "neutral",
    };
  } else {
    const gapPct =
      target.projectedTotal !== null
        ? (target.dailyGoal - target.projectedTotal) / target.dailyGoal
        : 0;
    const level = gapPct > 0.1 ? "crit" : gapPct > 0 ? "warn" : "good";
    const gapLabel =
      target.gapUnits !== null && target.gapUnits > 0
        ? `behind ${target.gapUnits.toLocaleString()} units`
        : "on pace";
    targetCell = {
      label: "Target",
      value: `${target.unitsProduced.toLocaleString()} / ${target.dailyGoal.toLocaleString()} units`,
      detail: gapLabel,
      level,
    };
  }

  const stalled = queues.filter((q) => q.queueStatus === "STALLED");
  const aging = queues.filter((q) => q.queueStatus === "AGING");
  let bottleneckCell: StatusCell;
  if (stalled.length > 0) {
    const worst = stalled[0]!;
    const ageMin = worst.oldestAgeSeconds
      ? Math.floor(worst.oldestAgeSeconds / 60)
      : null;
    bottleneckCell = {
      label: "Bottleneck",
      value: worst.stageKey.replace(/_/g, " ").toLowerCase(),
      detail:
        ageMin !== null ? `stalled — oldest bag ${ageMin} min` : "stalled",
      level: "crit",
    };
  } else if (aging.length > 0) {
    const worst = aging[0]!;
    const ageMin = worst.oldestAgeSeconds
      ? Math.floor(worst.oldestAgeSeconds / 60)
      : null;
    bottleneckCell = {
      label: "Bottleneck",
      value: worst.stageKey.replace(/_/g, " ").toLowerCase(),
      detail: ageMin !== null ? `aging — oldest bag ${ageMin} min` : "aging",
      level: "warn",
    };
  } else {
    bottleneckCell = {
      label: "Bottleneck",
      value: "all stages flowing",
      level: "good",
    };
  }

  let qualityCell: StatusCell;
  if (yieldPct === null) {
    qualityCell = { label: "Quality", value: "no data yet", level: "neutral" };
  } else {
    const level = yieldPct >= 98 ? "good" : yieldPct >= 94 ? "warn" : "crit";
    qualityCell = {
      label: "Quality",
      value: `${yieldPct.toFixed(1)}% first-pass yield`,
      level,
    };
  }

  let attentionCell: StatusCell;
  if (attention.length === 0) {
    attentionCell = {
      label: "Attention",
      value: "all machines active",
      level: "good",
    };
  } else {
    const first = attention[0]!;
    attentionCell = {
      label: "Attention",
      value: `${first.label} — ${first.detail}`,
      ...(attention.length > 1 ? { detail: `+${attention.length - 1} more` } : {}),
      level: attention.length >= 2 ? "crit" : "warn",
    };
  }

  return {
    target: targetCell,
    bottleneck: bottleneckCell,
    quality: qualityCell,
    attention: attentionCell,
  };
}

// ---------------------------------------------------------------------------
// 9. Hourly throughput
// ---------------------------------------------------------------------------

export async function getHourlyThroughput(
  tz: string,
): Promise<ThroughputDataPoint[]> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);

  // postgres-js rejects Date objects in raw SQL template literals;
  // cast to ISO string and let Postgres parse it as timestamptz.
  const shiftStartIso = shiftStartUtc.toISOString();

  const rows = await db.execute(sql`
    SELECT
      date_trunc('hour', occurred_at AT TIME ZONE ${tz}) AS hour_local,
      count(*) AS bag_count
    FROM workflow_events
    WHERE event_type = 'BAG_FINALIZED'
      AND occurred_at >= ${shiftStartIso}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `);

  return (rows as unknown as Array<{ hour_local: Date; bag_count: string }>).map((r) => ({
    label: new Date(r.hour_local).toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }),
    bagsPerHour: parseInt(r.bag_count, 10),
  }));
}
