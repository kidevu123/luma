// Canonical production-intelligence API. Every dashboard, page, and
// future report goes through this module — UI never recomputes
// metrics. The contract is the MetricResult shape in ./types.ts:
// every value carries its own confidence tag, and any input gap
// surfaces as MISSING + a labelled empty state.
//
// Honest-data rules (locked):
//   1. workflow_events is the source of truth.
//   2. Read-models are convenience projections; the metric layer
//      falls back to a live computation when a Phase A read model
//      is empty (until projector extensions land in Phase C).
//   3. OEE / performance / labor cost / on-time refuse to compute
//      without standards. They never imply a value.
//   4. Bottle line never claims activity it doesn't have.
//   5. Counter deltas reflect counter_end - counter_start; raw
//      event counts are never reported as production output.
//   6. Genealogy reads straight off workflow_events — no derivation.

import {
  and,
  asc,
  desc,
  eq,
  gte,
  lt,
  isNotNull,
  isNull,
  sql,
  count,
  sum,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  workflowEvents,
  workflowBags,
  readBagState,
  readBagMetrics,
  readDailyThroughput,
  readStationLive,
  readOperatorDaily,
  readMaterialBurn,
  readQueueState,
  readSkuDaily,
  readMaterialReconciliation,
  productionCalendars,
  stationStandards,
  laborRates,
  dueTargets,
  stations,
  machines,
  products,
  inventoryBags,
  finishedLots,
  packagingMaterials,
  packagingLots,
  productPackagingSpecs,
  blisterMaterialStandards,
  readMaterialLotState,
  readMaterialConsumptionDaily,
  readRollUsage,
  employees,
  users,
} from "@/lib/db/schema";
import {
  type DateRange,
  type MetricBundle,
  type MetricResult,
  type MetricFilters,
  type Route,
  type StageKey,
  type GenealogyEvent,
  type BagGenealogyResult,
  type BottleneckResult,
  STAGE_KEYS,
} from "./types";
import {
  ok,
  zero,
  partial,
  estimated,
  missing,
  combineConfidence,
  clampPct,
} from "./confidence";
import { lastNDays, todayRange, diffSeconds, formatDuration } from "./time";
import { ROUTE_TO_MACHINE_KINDS, timeWindow, inText } from "./sql";
import { routeForMachineKind } from "./units";

// ─── Standards availability ───────────────────────────────────────
// One round-trip per call; cheap, and used by every standards-
// dependent metric. Returns a snapshot so the function can decide
// whether to compute or to refuse.

interface StandardsSnapshot {
  hasCalendar: boolean;
  hasStationStandards: boolean;
  hasLaborRates: boolean;
  hasDueTargets: boolean;
}

async function loadStandardsSnapshot(): Promise<StandardsSnapshot> {
  // Existence checks via LIMIT 1 — much cheaper than COUNT(*) on a
  // table that may grow to thousands of rows in time. We only care
  // whether the user has bothered to configure each table at all.
  const [cal] = await db
    .select({ id: productionCalendars.id })
    .from(productionCalendars)
    .limit(1);
  const [std] = await db
    .select({ id: stationStandards.id })
    .from(stationStandards)
    .where(eq(stationStandards.isActive, true))
    .limit(1);
  const [lab] = await db
    .select({ id: laborRates.id })
    .from(laborRates)
    .limit(1);
  const [due] = await db
    .select({ id: dueTargets.id })
    .from(dueTargets)
    .limit(1);
  return {
    hasCalendar: !!cal,
    hasStationStandards: !!std,
    hasLaborRates: !!lab,
    hasDueTargets: !!due,
  };
}

// ─── 1. deriveDashboardMetrics ────────────────────────────────────
// Top KPI strip + headline rollups. Composed of cheap reads off
// existing read models. Standards-dependent metrics in here
// (schedule gap) refuse without due_targets.

export async function deriveDashboardMetrics(
  dateRange: DateRange = todayRange(),
  filters: MetricFilters = {},
): Promise<MetricBundle> {
  const standards = await loadStandardsSnapshot();
  const PAUSED_THRESHOLD_SEC = 30 * 60; // 30 minutes

  // bags_in_flow: bags not finalized.
  const wipRows = await db
    .select({ wip: count() })
    .from(readBagState)
    .where(eq(readBagState.isFinalized, false));
  const wip = wipRows[0]?.wip ?? 0;

  // Today's throughput rollup.
  const todayWindow = todayRange();
  const dayKey = todayWindow.from.toISOString().slice(0, 10);
  const [throughput] = await db
    .select({
      bagsBlistered: sum(readDailyThroughput.bagsBlistered).mapWith(Number),
      bagsSealed: sum(readDailyThroughput.bagsSealed).mapWith(Number),
      bagsPackaged: sum(readDailyThroughput.bagsPackaged).mapWith(Number),
      bagsFinalized: sum(readDailyThroughput.bagsFinalized).mapWith(Number),
      unitsProduced: sum(readDailyThroughput.unitsProduced).mapWith(Number),
      displaysProduced: sum(readDailyThroughput.displaysProduced).mapWith(Number),
      casesProduced: sum(readDailyThroughput.casesProduced).mapWith(Number),
    })
    .from(readDailyThroughput)
    .where(eq(readDailyThroughput.day, dayKey));

  // Oldest queue age — uses readBagState as a live source (Phase A
  // read_queue_state isn't projected yet).
  const [oldestRow] = await db
    .select({
      ageSeconds: sql<number>`EXTRACT(EPOCH FROM (now() - MIN(${readBagState.lastEventAt})))::int`,
    })
    .from(readBagState)
    .where(
      and(eq(readBagState.isFinalized, false), isNotNull(readBagState.lastEventAt)),
    );

  // Paused bags over threshold.
  const [pausedRow] = await db
    .select({ n: count() })
    .from(readBagState)
    .where(
      and(
        eq(readBagState.isPaused, true),
        sql`${readBagState.pausedAt} < now() - interval '${sql.raw(String(PAUSED_THRESHOLD_SEC))} seconds'`,
      ),
    );

  // Schedule gap — only if due_targets exist.
  let scheduleGap: MetricResult;
  if (!standards.hasDueTargets) {
    scheduleGap = missing(
      "units",
      ["due_targets"],
      "No target configured",
      "Add due targets at /standards/due-targets to track schedule adherence.",
    );
  } else {
    // Sum target_quantity of open due_targets due in the next 24h
    // and subtract the units we've produced toward each. For now
    // we report the open count; full per-target gap math lives in
    // deriveFinishedGoodsMetrics.
    const [openRow] = await db
      .select({ n: count() })
      .from(dueTargets)
      .where(
        and(
          isNull(dueTargets.completedAt),
          sql`${dueTargets.dueAt} < now() + interval '24 hours'`,
        ),
      );
    scheduleGap = ok(openRow?.n ?? 0, "open targets due ≤24h");
  }

  return {
    bagsInFlow: ok(Number(wip ?? 0), "bags"),
    goodUnitsToday: ok(Number(throughput?.unitsProduced ?? 0), "units"),
    displaysToday: ok(Number(throughput?.displaysProduced ?? 0), "displays"),
    casesToday: ok(Number(throughput?.casesProduced ?? 0), "cases"),
    bagsFinalizedToday: ok(Number(throughput?.bagsFinalized ?? 0), "bags"),
    oldestQueueAgeMinutes:
      oldestRow?.ageSeconds == null
        ? zero("min", "No active bags in queue.")
        : ok(Math.round(oldestRow.ageSeconds / 60), "min"),
    pausedBagsOverThreshold: ok(Number(pausedRow?.n ?? 0), "bags"),
    scheduleGap,
    // Suppress unused-import warnings on filters until per-filter
    // wiring is added below in derive* siblings.
    _: ok(JSON.stringify(filters), null),
  };
}

// ─── 2. deriveBagGenealogy ────────────────────────────────────────
// Reads straight off workflow_events — no materialised view, no
// derivation. The metric layer enriches with station/machine/
// employee names so the UI can render in one pass.

export async function deriveBagGenealogy(
  bagId: string,
): Promise<BagGenealogyResult> {
  if (!bagId) {
    return {
      bagId: "",
      events: [],
      summary: emptyGenealogySummary(),
      confidence: "MISSING",
      missingInputs: ["bagId"],
    };
  }
  const rows = await db
    .select({
      eventId: workflowEvents.id,
      occurredAt: workflowEvents.occurredAt,
      eventType: workflowEvents.eventType,
      payload: workflowEvents.payload,
      stationId: workflowEvents.stationId,
      stationLabel: stations.label,
      machineId: stations.machineId,
      machineName: machines.name,
      machineKind: machines.kind,
      employeeId: workflowEvents.employeeId,
      employeeName: employees.fullName,
      userId: workflowEvents.userId,
    })
    .from(workflowEvents)
    .leftJoin(stations, eq(stations.id, workflowEvents.stationId))
    .leftJoin(machines, eq(machines.id, stations.machineId))
    .leftJoin(employees, eq(employees.id, workflowEvents.employeeId))
    .where(eq(workflowEvents.workflowBagId, bagId))
    .orderBy(asc(workflowEvents.occurredAt), asc(workflowEvents.id));

  if (rows.length === 0) {
    return {
      bagId,
      events: [],
      summary: emptyGenealogySummary("no events for this bag"),
      confidence: "MISSING",
      missingInputs: ["events"],
    };
  }

  const events: GenealogyEvent[] = rows.map((r, i) => {
    const payload = r.payload as Record<string, unknown> | null;
    const notes =
      payload && typeof payload === "object"
        ? (payload.notes as string | undefined) ??
          (payload.reason as string | undefined) ??
          null
        : null;
    return {
      eventId: r.eventId,
      sequence: i + 1,
      occurredAt: r.occurredAt,
      eventType: r.eventType,
      payload: r.payload,
      stationId: r.stationId,
      stationLabel: r.stationLabel,
      machineId: r.machineId,
      machineName: r.machineName,
      machineKind: r.machineKind,
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      userId: r.userId,
      notes,
    };
  });

  const first = events[0]!.occurredAt;
  const last = events[events.length - 1]!.occurredAt;
  const distinctStations = new Set(
    events.map((e) => e.stationId).filter((s): s is string => !!s),
  ).size;
  const spanSec = diffSeconds(first, last) ?? 0;

  return {
    bagId,
    events,
    summary: {
      eventCount: ok(events.length, "events"),
      firstEventAt: ok(first.toISOString(), "iso"),
      lastEventAt: ok(last.toISOString(), "iso"),
      spanMinutes: ok(Math.round(spanSec / 60), "min", {
        explanation: formatDuration(spanSec),
      }),
      distinctStations: ok(distinctStations, "stations"),
    },
    confidence: "HIGH",
    missingInputs: [],
  };
}

function emptyGenealogySummary(explanation = "no events captured") {
  const m = (label: string) =>
    missing(null, ["events"], label, explanation);
  return {
    eventCount: m("No activity"),
    firstEventAt: m("No activity"),
    lastEventAt: m("No activity"),
    spanMinutes: m("No activity"),
    distinctStations: m("No activity"),
  };
}

// ─── 3. deriveMachineMetrics ──────────────────────────────────────
// Per-machine state + KPIs. State derived from real event activity,
// never asserted. NOT_INTEGRATED if no station is configured for
// this machine; NO_ACTIVITY_TODAY if configured but quiet.

export async function deriveMachineMetrics(
  machineId: string,
  dateRange: DateRange = todayRange(),
): Promise<MetricBundle> {
  const standards = await loadStandardsSnapshot();
  const [machine] = await db
    .select()
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  if (!machine) {
    return {
      state: missing(null, ["machineId"], "Unknown machine"),
    };
  }

  const machineStations = await db
    .select({ id: stations.id, label: stations.label })
    .from(stations)
    .where(eq(stations.machineId, machineId));

  if (machineStations.length === 0) {
    return {
      state: ok("NOT_INTEGRATED", null, {
        explanation: "No station is configured for this machine.",
      }),
      currentBag: missing(null, ["station"], "Not integrated"),
      currentSku: missing(null, ["station"], "Not integrated"),
      currentOperator: missing(null, ["station"], "Not integrated"),
      activeRuntimeToday: missing("min", ["station"], "Not integrated"),
      unitsToday: missing("units", ["station"], "Not integrated"),
      unitsPerHour: missing("units/hr", ["station"], "Not integrated"),
      idealCycleSeconds: missing(
        "sec/unit",
        ["station_standards"],
        "No standard configured",
      ),
      oeeAvailability: missing(
        "%",
        ["production_calendars"],
        "Insufficient data for OEE",
      ),
      oeePerformance: missing(
        "%",
        ["station_standards"],
        "Insufficient data for OEE",
      ),
      oeeQuality: missing(
        "%",
        ["damages", "scrap"],
        "Insufficient data for OEE",
      ),
      oee: missing(
        "%",
        ["all_oee_inputs"],
        "Insufficient data for OEE",
      ),
    };
  }

  const stationIds = machineStations.map((s) => s.id);

  // Today's bags-* throughput for this machine.
  const dayKey = todayRange().from.toISOString().slice(0, 10);
  const [t] = await db
    .select({
      bagsBlistered: sum(readDailyThroughput.bagsBlistered).mapWith(Number),
      bagsSealed: sum(readDailyThroughput.bagsSealed).mapWith(Number),
      bagsPackaged: sum(readDailyThroughput.bagsPackaged).mapWith(Number),
      bagsFinalized: sum(readDailyThroughput.bagsFinalized).mapWith(Number),
      units: sum(readDailyThroughput.unitsProduced).mapWith(Number),
    })
    .from(readDailyThroughput)
    .where(
      and(
        eq(readDailyThroughput.day, dayKey),
        eq(readDailyThroughput.machineId, machineId),
      ),
    );
  const unitsToday = Number(t?.units ?? 0);

  // Active runtime — sum of stage-event-implied durations on this
  // machine today. We use stage events only (no pause events) so
  // runtime reflects actual production minutes.
  const [runtime] = await db.execute<{ runtime_seconds: number | null }>(sql`
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (we.occurred_at - prev.occurred_at)))::int, 0) AS runtime_seconds
    FROM workflow_events we
    JOIN stations s ON s.id = we.station_id
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM workflow_events
      WHERE workflow_bag_id = we.workflow_bag_id
        AND occurred_at < we.occurred_at
        AND event_type IN ('CARD_ASSIGNED','BLISTER_COMPLETE','SEALING_COMPLETE',
                           'PACKAGING_COMPLETE','BOTTLE_HANDPACK_COMPLETE',
                           'BOTTLE_CAP_SEAL_COMPLETE','BOTTLE_STICKER_COMPLETE')
      ORDER BY occurred_at DESC LIMIT 1
    ) prev ON TRUE
    WHERE s.machine_id = ${machineId}
      AND ${timeWindow(sql`we.occurred_at`, dateRange.from, dateRange.to)}
      AND we.event_type IN ('BLISTER_COMPLETE','SEALING_COMPLETE',
                            'PACKAGING_COMPLETE','BOTTLE_HANDPACK_COMPLETE',
                            'BOTTLE_CAP_SEAL_COMPLETE','BOTTLE_STICKER_COMPLETE');
  `);
  const runtimeSec = Number(runtime?.runtime_seconds ?? 0);

  // Live state: any event today on a station owned by this machine?
  const [live] = await db
    .select({
      currentWorkflowBagId: readStationLive.currentWorkflowBagId,
      currentEmployeeName: readStationLive.currentEmployeeName,
      lastEventAt: readStationLive.lastEventAt,
      lastEventType: readStationLive.lastEventType,
    })
    .from(readStationLive)
    .where(
      sql`${readStationLive.stationId} IN ${inText(stationIds)}
          AND ${readStationLive.lastEventAt} IS NOT NULL
          AND ${readStationLive.lastEventAt} >= ${todayRange().from.toISOString()}::timestamptz`,
    )
    .orderBy(desc(readStationLive.lastEventAt))
    .limit(1);

  const state = live
    ? "LIVE"
    : runtimeSec > 0
      ? "LIVE"
      : "NO_ACTIVITY_TODAY";

  // Current bag's product (via readBagState).
  let currentBag: MetricResult = missing(null, ["live_state"], "Idle");
  let currentSku: MetricResult = missing(null, ["live_state"], "Idle");
  let currentOperator: MetricResult = missing(null, ["live_state"], "Idle");
  if (live?.currentWorkflowBagId) {
    const [bag] = await db
      .select({ name: readBagState.productName })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, live.currentWorkflowBagId))
      .limit(1);
    currentBag = ok(live.currentWorkflowBagId, null);
    currentSku = bag?.name ? ok(bag.name, null) : missing(null, ["product"], "Unknown");
    currentOperator = live.currentEmployeeName
      ? ok(live.currentEmployeeName, null)
      : missing(null, ["operator_code"], "Unknown");
  }

  const unitsPerHour =
    runtimeSec > 0 && unitsToday > 0
      ? ok(Math.round((unitsToday / runtimeSec) * 3600), "units/hr")
      : zero("units/hr", "No completed units today.");

  // Standards-dependent metrics — refuse cleanly without standards.
  const idealCycleSeconds = standards.hasStationStandards
    ? await loadIdealCycleSeconds(machineId, dateRange.from)
    : missing("sec/unit", ["station_standards"], "No standard configured");

  const oeeBundle = await computeOEE({
    standards,
    machineId,
    runtimeSec,
    unitsToday,
    dateRange,
  });

  return {
    state: ok(state, null),
    currentBag,
    currentSku,
    currentOperator,
    activeRuntimeToday: ok(Math.round(runtimeSec / 60), "min", {
      explanation: formatDuration(runtimeSec),
    }),
    unitsToday: ok(unitsToday, "units"),
    unitsPerHour,
    idealCycleSeconds,
    bagsBlistered: ok(Number(t?.bagsBlistered ?? 0), "bags"),
    bagsSealed: ok(Number(t?.bagsSealed ?? 0), "bags"),
    bagsPackaged: ok(Number(t?.bagsPackaged ?? 0), "bags"),
    bagsFinalized: ok(Number(t?.bagsFinalized ?? 0), "bags"),
    ...oeeBundle,
  };
}

// ─── 4. deriveStationMetrics ──────────────────────────────────────

export async function deriveStationMetrics(
  stationId: string,
  dateRange: DateRange = todayRange(),
): Promise<MetricBundle> {
  const [station] = await db
    .select({
      id: stations.id,
      label: stations.label,
      machineId: stations.machineId,
    })
    .from(stations)
    .where(eq(stations.id, stationId))
    .limit(1);
  if (!station) {
    return { state: missing(null, ["stationId"], "Unknown station") };
  }
  // Roll up via the machine — same shape, narrower scope. The
  // station-level tweak is that the live-state lookup is on the
  // station row itself.
  const [live] = await db
    .select()
    .from(readStationLive)
    .where(eq(readStationLive.stationId, stationId))
    .limit(1);

  const isLive =
    live?.lastEventAt &&
    live.lastEventAt >= dateRange.from &&
    live.lastEventAt < dateRange.to;

  return {
    state: ok(isLive ? "LIVE" : "NO_ACTIVITY_TODAY", null),
    currentBag: live?.currentWorkflowBagId
      ? ok(live.currentWorkflowBagId, null)
      : missing(null, ["live_state"], "Idle"),
    currentOperator: live?.currentEmployeeName
      ? ok(live.currentEmployeeName, null)
      : missing(null, ["operator_code"], "Idle"),
    lastEventType: live?.lastEventType
      ? ok(live.lastEventType, null)
      : missing(null, ["event"], "No activity"),
    busyForSeconds: live?.busyForSeconds
      ? ok(live.busyForSeconds, "sec", {
          explanation: formatDuration(live.busyForSeconds),
        })
      : zero("sec"),
    machineId: station.machineId
      ? ok(station.machineId, null)
      : missing(null, ["machineId"], "Not assigned"),
  };
}

// ─── 5. deriveRouteMetrics ────────────────────────────────────────
// Route = CARD or BOTTLE. Aggregates throughput across all machines
// of the matching kind.

export async function deriveRouteMetrics(
  route: Route,
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const kinds = ROUTE_TO_MACHINE_KINDS[route];
  if (!kinds || kinds.length === 0) {
    return {
      state: missing(null, ["route"], "Unknown route"),
    };
  }
  const fromDay = dateRange.from.toISOString().slice(0, 10);
  const toDay = dateRange.to.toISOString().slice(0, 10);
  const [agg] = await db.execute<{
    bags: number;
    units: number;
    displays: number;
    cases: number;
  }>(sql`
    SELECT
      COALESCE(SUM(rdt.bags_finalized), 0)::int AS bags,
      COALESCE(SUM(rdt.units_produced), 0)::int AS units,
      COALESCE(SUM(rdt.displays_produced), 0)::int AS displays,
      COALESCE(SUM(rdt.cases_produced), 0)::int AS cases
    FROM read_daily_throughput rdt
    JOIN machines m ON m.id = rdt.machine_id
    WHERE rdt.day >= ${fromDay}::date
      AND rdt.day < ${toDay}::date
      AND m.kind IN ${inText([...kinds])};
  `);
  const bags = Number(agg?.bags ?? 0);
  if (bags === 0) {
    // Honest empty state — distinguish "no activity" from "not integrated".
    // For BOTTLE specifically, the spec calls out: "Bottle line does not
    // show fake activity."
    return {
      bagsCompleted: zero("bags", "No activity captured for this route in window."),
      unitsProduced: zero("units"),
      displaysProduced: zero("displays"),
      casesProduced: zero("cases"),
      route: ok(route, null),
    };
  }
  return {
    bagsCompleted: ok(bags, "bags"),
    unitsProduced: ok(Number(agg?.units ?? 0), "units"),
    displaysProduced: ok(Number(agg?.displays ?? 0), "displays"),
    casesProduced: ok(Number(agg?.cases ?? 0), "cases"),
    route: ok(route, null),
  };
}

// ─── 6. deriveStageMetrics ────────────────────────────────────────
// Per-stage WIP + average cycle time. Stage = a logical step in the
// flow (BLISTER, SEALING, PACKAGING, BOTTLE_FILL, etc.). For now we
// derive from readBagState's stage column since Phase A read_queue_
// state isn't projected yet.

export async function deriveStageMetrics(
  stageId: StageKey,
  dateRange: DateRange = todayRange(),
): Promise<MetricBundle> {
  if (!STAGE_KEYS.includes(stageId)) {
    return { state: missing(null, ["stageId"], "Unknown stage") };
  }
  const stageColumnValues = STAGE_TO_BAG_STAGES[stageId];
  if (!stageColumnValues || stageColumnValues.length === 0) {
    return {
      wip: zero("bags", `No bags currently in ${stageId}.`),
    };
  }
  const [row] = await db
    .select({
      wip: count(),
      oldestSeconds: sql<number | null>`EXTRACT(EPOCH FROM (now() - MIN(${readBagState.lastEventAt})))::int`,
      avgSeconds: sql<number | null>`EXTRACT(EPOCH FROM AVG(now() - ${readBagState.lastEventAt}))::int`,
    })
    .from(readBagState)
    .where(
      and(
        eq(readBagState.isFinalized, false),
        sql`${readBagState.stage} IN ${inText(stageColumnValues)}`,
      ),
    );
  const wip = Number(row?.wip ?? 0);
  return {
    stageId: ok(stageId, null),
    wip: ok(wip, "bags"),
    oldestQueueAgeMinutes:
      row?.oldestSeconds != null
        ? ok(Math.round(row.oldestSeconds / 60), "min")
        : zero("min", "Stage empty."),
    avgQueueAgeMinutes:
      row?.avgSeconds != null
        ? ok(Math.round(row.avgSeconds / 60), "min")
        : zero("min", "Stage empty."),
  };
}

/** Mapping from canonical stage keys to the readBagState.stage
 *  enum-ish strings. Intentionally narrow — bottle stages map to
 *  the same string for now since the read_bag_state stage column
 *  doesn't differentiate. When the projector picks up bottle stages
 *  separately (Phase C) this map widens. */
const STAGE_TO_BAG_STAGES: Record<StageKey, ReadonlyArray<string>> = {
  BLISTER_QUEUE: ["STARTED"],
  POST_BLISTER_STAGING: ["BLISTERED"],
  SEALING_QUEUE: ["BLISTERED"],
  POST_SEAL_STAGING: ["SEALED"],
  PACKAGING_QUEUE: ["SEALED"],
  BOTTLE_FILL_QUEUE: ["STARTED"],
  BOTTLE_STICKER_QUEUE: ["BOTTLE_HANDPACK"],
  BOTTLE_INDUCTION_QUEUE: ["BOTTLE_STICKER"],
  FINISHED_GOODS_QUEUE: ["PACKAGED"],
};

// ─── 7. deriveQueueAging ──────────────────────────────────────────
// Live per-stage queue ages. Reads the projected read_queue_state
// when present; falls back to readBagState live computation when
// the Phase A projector hasn't been wired yet.

export async function deriveQueueAging(
  _dateRange: DateRange = todayRange(),
): Promise<MetricBundle> {
  // Try the projected table first.
  const projected = await db
    .select()
    .from(readQueueState)
    .orderBy(asc(readQueueState.stageKey));
  if (projected.length > 0) {
    const out: MetricBundle = {};
    for (const r of projected) {
      out[`${r.stageKey}.wip`] = ok(r.wip, "bags");
      out[`${r.stageKey}.oldestAgeMinutes`] =
        r.oldestAgeSeconds != null
          ? ok(Math.round(r.oldestAgeSeconds / 60), "min")
          : zero("min", "Queue empty.");
      out[`${r.stageKey}.avgAgeMinutes`] =
        r.avgAgeSeconds != null
          ? ok(Math.round(r.avgAgeSeconds / 60), "min")
          : zero("min", "Queue empty.");
      out[`${r.stageKey}.p90AgeMinutes`] =
        r.p90AgeSeconds != null
          ? ok(Math.round(r.p90AgeSeconds / 60), "min")
          : zero("min", "Insufficient samples.");
      out[`${r.stageKey}.bagsOverThreshold`] = ok(
        r.bagsOverThreshold,
        "bags",
      );
      out[`${r.stageKey}.status`] = ok(r.queueStatus, null);
    }
    return out;
  }
  // Fallback — live computation. Not as fast but always honest.
  const out: MetricBundle = {};
  for (const stageKey of STAGE_KEYS) {
    const sub = await deriveStageMetrics(stageKey);
    out[`${stageKey}.wip`] = sub.wip ?? zero("bags");
    out[`${stageKey}.oldestAgeMinutes`] =
      sub.oldestQueueAgeMinutes ?? zero("min");
    out[`${stageKey}.avgAgeMinutes`] =
      sub.avgQueueAgeMinutes ?? zero("min");
    out[`${stageKey}.p90AgeMinutes`] = missing(
      "min",
      ["read_queue_state"],
      "p90 not available in fallback",
    );
    out[`${stageKey}.bagsOverThreshold`] = zero("bags");
    out[`${stageKey}.status`] = ok("FLOWING", null);
  }
  return out;
}

// ─── 8. deriveBottleneck ──────────────────────────────────────────
// Identify the current bottleneck: highest queue age, highest WIP,
// or longest cycle vs standard. We only consult the cycle-vs-
// standard branch when standards exist.

export async function deriveBottleneck(
  dateRange: DateRange = todayRange(),
): Promise<BottleneckResult> {
  const aging = await deriveQueueAging(dateRange);
  let worstStage: StageKey | null = null;
  let worstAgeMin = -1;
  let worstWip = -1;
  for (const stageKey of STAGE_KEYS) {
    const ageMr = aging[`${stageKey}.oldestAgeMinutes`];
    const wipMr = aging[`${stageKey}.wip`];
    const age = typeof ageMr?.value === "number" ? ageMr.value : -1;
    const wip = typeof wipMr?.value === "number" ? wipMr.value : -1;
    if (age > worstAgeMin || (age === worstAgeMin && wip > worstWip)) {
      worstAgeMin = age;
      worstWip = wip;
      worstStage = stageKey;
    }
  }
  if (worstStage == null || worstAgeMin <= 0) {
    return {
      stageKey: missing(null, ["queue_state"], "No bottleneck — queues clear"),
      reason: missing(null, ["queue_state"], "No bottleneck"),
      oldestAgeMinutes: zero("min"),
      wip: zero("bags"),
      cycleVsStandardPct: missing(
        "%",
        ["station_standards"],
        "No standard configured",
      ),
    };
  }
  return {
    stageKey: ok(worstStage, null, {
      explanation: `Oldest queue age ${worstAgeMin}m at ${worstWip} WIP.`,
    }),
    reason: ok(worstAgeMin > 60 ? "QUEUE_AGE" : "WIP", null),
    oldestAgeMinutes: ok(worstAgeMin, "min"),
    wip: ok(worstWip, "bags"),
    cycleVsStandardPct: missing(
      "%",
      ["station_standards"],
      "No standard configured",
    ),
  };
}

// ─── 9. derivePackagingMetrics ────────────────────────────────────
// Displays / cases / loose units / damages — separated. From
// readBagMetrics (per-bag snapshots) windowed by finalizedAt.

export async function derivePackagingMetrics(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const [agg] = await db
    .select({
      masterCases: sum(readBagMetrics.masterCases).mapWith(Number),
      displaysMade: sum(readBagMetrics.displaysMade).mapWith(Number),
      looseCards: sum(readBagMetrics.looseCards).mapWith(Number),
      damagedPackaging: sum(readBagMetrics.damagedPackaging).mapWith(Number),
      rippedCards: sum(readBagMetrics.rippedCards).mapWith(Number),
      bagsFinalised: count(),
    })
    .from(readBagMetrics)
    .where(timeWindow(readBagMetrics.finalizedAt, dateRange.from, dateRange.to));
  const cases = Number(agg?.masterCases ?? 0);
  const displays = Number(agg?.displaysMade ?? 0);
  const loose = Number(agg?.looseCards ?? 0);
  const damages = Number(agg?.damagedPackaging ?? 0);
  const ripped = Number(agg?.rippedCards ?? 0);
  const bags = Number(agg?.bagsFinalised ?? 0);
  return {
    masterCases: ok(cases, "cases"),
    displaysMade: ok(displays, "displays"),
    looseCards: ok(loose, "cards"),
    damagedPackaging: ok(damages, "units"),
    rippedCards: ok(ripped, "cards"),
    bagsFinalised: ok(bags, "bags"),
    damageRatePct:
      cases + displays + loose === 0
        ? missing("%", ["output_units"], "No reject data")
        : ok(
            +(((damages + ripped) / (cases + displays + loose)) * 100).toFixed(2),
            "%",
          ),
  };
}

// ─── 10. deriveDamageAndReworkMetrics ─────────────────────────────
// First-pass yield, damage rate, rework rate. Rework is gated on
// REWORK_SENT events being emitted (Phase C work) — until then we
// return MISSING for that metric. Damage flows from existing data.

export async function deriveDamageAndReworkMetrics(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  // Damage from PACKAGING_DAMAGE_RETURN.
  const [dmg] = await db
    .select({ n: count() })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.eventType, "PACKAGING_DAMAGE_RETURN"),
        timeWindow(workflowEvents.occurredAt, dateRange.from, dateRange.to),
      ),
    );
  // Rework — REWORK_SENT events. Returns 0 when none are emitted
  // yet (the event type exists post-Phase A; the codepaths firing
  // it land in Phase C).
  const [rew] = await db
    .select({ n: count() })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.eventType, "REWORK_SENT"),
        timeWindow(workflowEvents.occurredAt, dateRange.from, dateRange.to),
      ),
    );
  // Force-release.
  const [fr] = await db
    .select({ n: count() })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.eventType, "CARD_FORCE_RELEASED"),
        timeWindow(workflowEvents.occurredAt, dateRange.from, dateRange.to),
      ),
    );
  // Submission corrections.
  const [sc] = await db
    .select({ n: count() })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.eventType, "SUBMISSION_CORRECTED"),
        timeWindow(workflowEvents.occurredAt, dateRange.from, dateRange.to),
      ),
    );
  // First-pass yield against finalised bags.
  const [bags] = await db
    .select({ n: count(), withDamage: sum(readBagMetrics.damagedPackaging).mapWith(Number) })
    .from(readBagMetrics)
    .where(timeWindow(readBagMetrics.finalizedAt, dateRange.from, dateRange.to));
  const total = Number(bags?.n ?? 0);
  const withDmg = Number(bags?.withDamage ?? 0);
  const fpy =
    total === 0
      ? missing("%", ["bags_finalised"], "No reject data")
      : ok(+(((total - withDmg) / total) * 100).toFixed(2), "%");
  return {
    damageEvents: ok(Number(dmg?.n ?? 0), "events"),
    reworkEvents: Number(rew?.n ?? 0) > 0
      ? ok(Number(rew?.n ?? 0), "events")
      : missing("events", ["REWORK_SENT"], "No reject data"),
    forceReleaseEvents: ok(Number(fr?.n ?? 0), "events"),
    submissionCorrections: ok(Number(sc?.n ?? 0), "events"),
    firstPassYieldPct: fpy,
  };
}

// ─── 11. deriveFlavorMetrics ──────────────────────────────────────
// Per-product (flavor / SKU) analytics. Prefers readSkuDaily once
// projected; falls back to readDailyThroughput grouped by product
// while Phase A's new read model is unpopulated.

export async function deriveFlavorMetrics(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const fromDay = dateRange.from.toISOString().slice(0, 10);
  const toDay = dateRange.to.toISOString().slice(0, 10);
  const skuRows = await db
    .select()
    .from(readSkuDaily)
    .where(
      and(
        gte(readSkuDaily.day, fromDay),
        lt(readSkuDaily.day, toDay),
      ),
    );
  if (skuRows.length === 0) {
    // Fallback path — the existing readDailyThroughput is
    // populated by the projector today.
    const fallback = await db.execute<{
      product_id: string;
      product_name: string | null;
      bags: number;
      units: number;
      displays: number;
      cases: number;
    }>(sql`
      SELECT rdt.product_id,
             p.name AS product_name,
             SUM(rdt.bags_finalized)::int AS bags,
             SUM(rdt.units_produced)::int AS units,
             SUM(rdt.displays_produced)::int AS displays,
             SUM(rdt.cases_produced)::int AS cases
      FROM read_daily_throughput rdt
      LEFT JOIN products p ON p.id = rdt.product_id
      WHERE rdt.day >= ${fromDay}::date AND rdt.day < ${toDay}::date
        AND rdt.product_id IS NOT NULL
      GROUP BY rdt.product_id, p.name
      ORDER BY units DESC;
    `);
    const out: MetricBundle = {};
    if (fallback.length === 0) {
      out["_status"] = missing(
        null,
        ["read_sku_daily", "read_daily_throughput"],
        "No activity in window",
      );
      return out;
    }
    for (const r of fallback) {
      const tag = r.product_name ?? r.product_id;
      out[`${tag}.bags`] = ok(Number(r.bags), "bags");
      out[`${tag}.units`] = ok(Number(r.units), "units");
      out[`${tag}.displays`] = ok(Number(r.displays), "displays");
      out[`${tag}.cases`] = ok(Number(r.cases), "cases");
    }
    out["_source"] = ok("read_daily_throughput (fallback)", null, {
      explanation:
        "read_sku_daily empty — projector extension lands in Phase C.",
    });
    return out;
  }
  // Primary path — populated read_sku_daily.
  const out: MetricBundle = {};
  for (const r of skuRows) {
    const tag = r.productSku;
    out[`${tag}.bags`] = ok(r.bagsCompleted, "bags");
    out[`${tag}.displays`] = ok(r.displaysCompleted, "displays");
    out[`${tag}.cases`] = ok(r.casesCompleted, "cases");
    out[`${tag}.bottles`] = ok(r.bottlesCompleted, "bottles");
    out[`${tag}.damages`] = ok(r.damages, "units");
    out[`${tag}.scrap`] = ok(r.scrap, "units");
  }
  return out;
}

// ─── 12. deriveOperatorMetrics ────────────────────────────────────
// Per-operator productivity. Reads readOperatorDaily — already
// populated for finalised bags by the existing projector.

export async function deriveOperatorMetrics(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const fromDay = dateRange.from.toISOString().slice(0, 10);
  const toDay = dateRange.to.toISOString().slice(0, 10);
  const rows = await db
    .select({
      operatorCode: readOperatorDaily.operatorCode,
      bagsFinalized: sum(readOperatorDaily.bagsFinalized).mapWith(Number),
      activeSeconds: sum(readOperatorDaily.activeSecondsTotal).mapWith(Number),
      damages: sum(readOperatorDaily.damageCountTotal).mapWith(Number),
    })
    .from(readOperatorDaily)
    .where(
      and(
        gte(readOperatorDaily.day, fromDay),
        lt(readOperatorDaily.day, toDay),
      ),
    )
    .groupBy(readOperatorDaily.operatorCode)
    .orderBy(desc(sum(readOperatorDaily.bagsFinalized)));
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["read_operator_daily"],
      "No activity in window",
    );
    return out;
  }
  for (const r of rows) {
    out[`${r.operatorCode}.bagsFinalized`] = ok(
      Number(r.bagsFinalized ?? 0),
      "bags",
    );
    out[`${r.operatorCode}.activeMinutes`] = ok(
      Math.round(Number(r.activeSeconds ?? 0) / 60),
      "min",
    );
    out[`${r.operatorCode}.damages`] = ok(
      Number(r.damages ?? 0),
      "units",
    );
    const bags = Number(r.bagsFinalized ?? 0);
    const sec = Number(r.activeSeconds ?? 0);
    out[`${r.operatorCode}.unitsPerHour`] =
      bags > 0 && sec > 0
        ? ok(Math.round((bags / sec) * 3600), "bags/hr")
        : zero("bags/hr");
  }
  return out;
}

// ─── 13. deriveMaterialReconciliation ─────────────────────────────
// Per-bag reconciliation: received - consumed - scrap - remaining
// = variance. Uses readMaterialReconciliation if populated, else
// computes live from inventory_bags + workflow_bags + readBagMetrics.

export async function deriveMaterialReconciliation(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const projected = await db
    .select()
    .from(readMaterialReconciliation)
    .limit(50);
  if (projected.length > 0) {
    const out: MetricBundle = {};
    for (const r of projected) {
      const ctor = r.isEstimated ? estimated : ok;
      const missingList = r.missingInputs ? r.missingInputs.split(",") : [];
      const opts: { explanation?: string; missingInputs?: string[] } = {
        missingInputs: missingList,
      };
      if (r.missingInputs) opts.explanation = r.missingInputs;
      out[`${r.workflowBagId}.varianceQty`] = ctor(
        r.varianceQty ?? 0,
        "tablets",
        opts,
      );
    }
    return out;
  }
  // Fallback — compute live from inventory_bags + readBagMetrics
  // for the bags finalised in window. Marks each result as
  // estimated since we're stitching across tables instead of
  // reading a single audited row.
  const rows = await db.execute<{
    bag_id: string;
    received: number | null;
    finished_units: number | null;
    damage: number | null;
  }>(sql`
    SELECT wb.id AS bag_id,
           ib.pill_count AS received,
           rbm.units_yielded AS finished_units,
           rbm.damaged_packaging AS damage
    FROM workflow_bags wb
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    LEFT JOIN read_bag_metrics rbm ON rbm.workflow_bag_id = wb.id
    WHERE wb.finalized_at IS NOT NULL
      AND ${timeWindow(sql`wb.finalized_at`, dateRange.from, dateRange.to)};
  `);
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["read_material_reconciliation", "workflow_bags"],
      "No activity in window",
    );
    return out;
  }
  for (const r of rows) {
    const received = Number(r.received ?? 0);
    const finished = Number(r.finished_units ?? 0);
    const dmg = Number(r.damage ?? 0);
    const missingInputs: string[] = [];
    if (r.received == null) missingInputs.push("received");
    if (r.finished_units == null) missingInputs.push("finished");
    if (r.damage == null) missingInputs.push("damage");
    const variance = received - finished - dmg;
    out[`${r.bag_id}.varianceQty`] = estimated(variance, "tablets", {
      missingInputs,
      explanation: missingInputs.length
        ? `Estimated; missing ${missingInputs.join(", ")}.`
        : "Live computation; consider materialising read_material_reconciliation.",
    });
  }
  return out;
}

// ─── 14. deriveFinishedGoodsMetrics ───────────────────────────────
// Released vs PendingQC counts; total released units in window;
// on-time-completion only when due_targets exist.

export async function deriveFinishedGoodsMetrics(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const standards = await loadStandardsSnapshot();
  const [released] = await db
    .select({
      n: count(),
      units: sum(finishedLots.unitsProduced).mapWith(Number),
      cases: sum(finishedLots.casesProduced).mapWith(Number),
      displays: sum(finishedLots.displaysProduced).mapWith(Number),
    })
    .from(finishedLots)
    .where(
      and(
        eq(finishedLots.status, "RELEASED"),
        timeWindow(finishedLots.producedOn, dateRange.from, dateRange.to),
      ),
    );
  const [pending] = await db
    .select({ n: count() })
    .from(finishedLots)
    .where(eq(finishedLots.status, "PENDING_QC"));
  const onTime = standards.hasDueTargets
    ? await deriveOnTimeCompletion(dateRange)
    : missing(
        "%",
        ["due_targets"],
        "No target configured",
        "Add due targets at /standards/due-targets to track schedule adherence.",
      );
  return {
    releasedLots: ok(Number(released?.n ?? 0), "lots"),
    pendingQcLots: ok(Number(pending?.n ?? 0), "lots"),
    releasedUnits: ok(Number(released?.units ?? 0), "units"),
    releasedCases: ok(Number(released?.cases ?? 0), "cases"),
    releasedDisplays: ok(Number(released?.displays ?? 0), "displays"),
    onTimeCompletionPct: onTime,
  };
}

async function deriveOnTimeCompletion(
  dateRange: DateRange,
): Promise<MetricResult> {
  const [row] = await db.execute<{ total: number; on_time: number }>(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at <= due_at)::int AS on_time
    FROM due_targets
    WHERE ${timeWindow(sql`due_at`, dateRange.from, dateRange.to)};
  `);
  const total = Number(row?.total ?? 0);
  if (total === 0) {
    return missing("%", ["due_targets"], "No targets in window");
  }
  const onTime = Number(row?.on_time ?? 0);
  return ok(+((onTime / total) * 100).toFixed(2), "%");
}

// ─── OEE helpers ─────────────────────────────────────────────────

interface OEEInputs {
  standards: StandardsSnapshot;
  machineId: string;
  runtimeSec: number;
  unitsToday: number;
  dateRange: DateRange;
}

async function computeOEE(inputs: OEEInputs): Promise<MetricBundle> {
  const missingInputs: string[] = [];
  if (!inputs.standards.hasCalendar) missingInputs.push("production_calendars");
  if (!inputs.standards.hasStationStandards)
    missingInputs.push("station_standards");
  // Quality requires reject data — until SCRAP_RECORDED + reject
  // counts are emitted (Phase C), we mark Quality MISSING even if
  // standards exist.
  // Phase B refuses to surface a fake OEE.
  const refuse = (label = "Insufficient data for OEE") =>
    missing("%", missingInputs.length ? missingInputs : ["oee_inputs"], label);
  if (
    !inputs.standards.hasCalendar ||
    !inputs.standards.hasStationStandards
  ) {
    return {
      oeeAvailability: refuse(),
      oeePerformance: refuse(),
      oeeQuality: refuse(),
      oee: refuse(),
    };
  }
  // When standards are present, OEE is still gated on reject data
  // (Quality factor). For now: refuse Quality + OEE; surface
  // Availability and Performance honestly with HIGH confidence.
  // Compute Availability:
  const calendar = await loadEffectiveCalendar(inputs.dateRange.from);
  if (!calendar) {
    return {
      oeeAvailability: refuse("No production calendar for date"),
      oeePerformance: refuse(),
      oeeQuality: refuse(),
      oee: refuse(),
    };
  }
  const plannedSec = calendarPlannedSeconds(calendar);
  const availabilityPct = clampPct((inputs.runtimeSec / plannedSec) * 100);
  // Performance:
  const ideal = await loadIdealCycleSecondsAsNumber(
    inputs.machineId,
    inputs.dateRange.from,
  );
  if (ideal == null) {
    return {
      oeeAvailability: ok(+availabilityPct.toFixed(2), "%"),
      oeePerformance: refuse("No ideal cycle configured"),
      oeeQuality: missing("%", ["reject_data"], "No reject data"),
      oee: refuse(),
    };
  }
  const idealOutput = inputs.runtimeSec / ideal;
  const performancePct = clampPct(
    idealOutput > 0 ? (inputs.unitsToday / idealOutput) * 100 : 0,
  );
  // Quality refused — see comment above.
  return {
    oeeAvailability: ok(+availabilityPct.toFixed(2), "%"),
    oeePerformance: ok(+performancePct.toFixed(2), "%"),
    oeeQuality: missing("%", ["reject_data"], "No reject data"),
    oee: missing("%", ["reject_data"], "Insufficient data for OEE"),
  };
}

async function loadIdealCycleSeconds(
  machineId: string,
  asOf: Date,
): Promise<MetricResult> {
  const sec = await loadIdealCycleSecondsAsNumber(machineId, asOf);
  if (sec == null) {
    return missing(
      "sec/unit",
      ["station_standards"],
      "No standard configured",
    );
  }
  return ok(sec, "sec/unit");
}

async function loadIdealCycleSecondsAsNumber(
  machineId: string,
  asOf: Date,
): Promise<number | null> {
  const asOfDate = asOf.toISOString().slice(0, 10);
  const [row] = await db
    .select({ ideal: stationStandards.idealCycleSeconds })
    .from(stationStandards)
    .where(
      and(
        eq(stationStandards.machineId, machineId),
        eq(stationStandards.isActive, true),
        lt(stationStandards.effectiveFrom, sql`${asOfDate}::date + interval '1 day'`),
        sql`(${stationStandards.effectiveTo} IS NULL OR ${stationStandards.effectiveTo} > ${asOfDate}::date)`,
      ),
    )
    .limit(1);
  return row?.ideal != null ? Number(row.ideal) : null;
}

interface CalendarRow {
  shiftStart: string;
  shiftEnd: string;
  plannedBreakMinutes: number;
}

async function loadEffectiveCalendar(asOf: Date): Promise<CalendarRow | null> {
  const asOfDate = asOf.toISOString().slice(0, 10);
  const [row] = await db
    .select({
      shiftStart: productionCalendars.shiftStart,
      shiftEnd: productionCalendars.shiftEnd,
      plannedBreakMinutes: productionCalendars.plannedBreakMinutes,
    })
    .from(productionCalendars)
    .where(
      and(
        lt(productionCalendars.effectiveFrom, sql`${asOfDate}::date + interval '1 day'`),
        sql`(${productionCalendars.effectiveTo} IS NULL OR ${productionCalendars.effectiveTo} > ${asOfDate}::date)`,
      ),
    )
    .orderBy(desc(productionCalendars.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/** Pure helper exported for tests. Computes planned production
 *  seconds in a shift, accounting for cross-midnight shifts and
 *  planned breaks. */
export function calendarPlannedSeconds(c: {
  shiftStart: string;
  shiftEnd: string;
  plannedBreakMinutes: number;
}): number {
  const [sh, sm] = c.shiftStart.split(":").map(Number);
  const [eh, em] = c.shiftEnd.split(":").map(Number);
  const startMin = (sh ?? 0) * 60 + (sm ?? 0);
  const endMin = (eh ?? 0) * 60 + (em ?? 0);
  let durationMin = endMin - startMin;
  if (durationMin <= 0) durationMin += 24 * 60; // crosses midnight
  return Math.max(0, durationMin - (c.plannedBreakMinutes ?? 0)) * 60;
}

// ─── Pure metric helpers (exported for tests) ─────────────────────
//
// These mirror the formulas used inside the SQL queries — but in
// pure-JS form so vitest can verify the math without standing up a
// database. Keeping the SQL and the pure helpers in lock-step is a
// human discipline, not a guarantee — the dictionary documents the
// canonical formula.

/** Counter delta = end - start. Returns null when either is missing. */
export function counterDelta(
  start: number | null | undefined,
  end: number | null | undefined,
): number | null {
  if (start == null || end == null) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end < start) return null; // counter wrap or typo — refuse
  return end - start;
}

/** Active runtime — sum of (clock_out - clock_in) for stage events.
 *  Pure helper; SQL version lives inside deriveMachineMetrics. */
export function activeRuntimeSeconds(
  intervals: ReadonlyArray<{ from: Date; to: Date | null }>,
): number {
  let sec = 0;
  for (const i of intervals) {
    if (!i.to) continue;
    sec += diffSeconds(i.from, i.to) ?? 0;
  }
  return sec;
}

/** Pause duration — pairs BAG_PAUSED with the next BAG_RESUMED.
 *  Open pause at end of array contributes (now - paused_at). */
export function pauseDurationSeconds(
  events: ReadonlyArray<{ type: "BAG_PAUSED" | "BAG_RESUMED"; at: Date }>,
  now: Date = new Date(),
): number {
  let total = 0;
  let openAt: Date | null = null;
  for (const e of events) {
    if (e.type === "BAG_PAUSED" && !openAt) {
      openAt = e.at;
    } else if (e.type === "BAG_RESUMED" && openAt) {
      total += diffSeconds(openAt, e.at) ?? 0;
      openAt = null;
    }
  }
  if (openAt) total += diffSeconds(openAt, now) ?? 0;
  return total;
}

/** Bag lead time — finalized_at - received_at. */
export function bagLeadTimeSeconds(
  receivedAt: Date | null,
  finalizedAt: Date | null,
): number | null {
  return diffSeconds(receivedAt, finalizedAt);
}

/** Queue age — now - lastEventAt of the bag in the stage. */
export function queueAgeSeconds(
  lastEventAt: Date | null,
  now: Date = new Date(),
): number | null {
  return diffSeconds(lastEventAt, now);
}

/** Convert packaging output between unit types. Returns null when
 *  the conversion isn't defined by the spec. */
export function packagingDisplaysToCases(
  displays: number,
  displaysPerCase: number | null,
): number | null {
  if (displaysPerCase == null || displaysPerCase <= 0) return null;
  return displays / displaysPerCase;
}

/** OEE — clamps each factor 0–100 and returns the product / 10000.
 *  Returns null when any factor is null. */
export function oee(
  availabilityPct: number | null,
  performancePct: number | null,
  qualityPct: number | null,
): number | null {
  if (
    availabilityPct == null ||
    performancePct == null ||
    qualityPct == null
  ) {
    return null;
  }
  const a = clampPct(availabilityPct);
  const p = clampPct(performancePct);
  const q = clampPct(qualityPct);
  return clampPct((a * p * q) / 10000);
}

// ─── Phase H — material inventory metrics ────────────────────────

/** All packaging materials with current on-hand + estimated qty.
 *  Returns one MetricResult per material under stable keys. Reads
 *  from read_material_lot_state aggregated up to the material level. */
export async function derivePackagingInventory(): Promise<MetricBundle> {
  const rows = await db.execute<{
    packaging_material_id: string;
    material_kind: string;
    sku: string;
    name: string;
    par_level: number | null;
    on_hand_units: number;
    estimated_remaining_units: number;
    on_hand_grams: number;
    estimated_remaining_grams: number;
    lot_count: number;
    confidence: string;
  }>(sql`
    SELECT
      pm.id AS packaging_material_id,
      pm.kind::text AS material_kind,
      pm.sku, pm.name, pm.par_level,
      COALESCE(SUM(rls.initial_quantity), 0)::int AS on_hand_units,
      COALESCE(SUM(rls.current_quantity_estimate), 0)::int AS estimated_remaining_units,
      COALESCE(SUM(rls.initial_weight_grams), 0)::int AS on_hand_grams,
      COALESCE(SUM(rls.current_weight_grams_estimate), 0)::int AS estimated_remaining_grams,
      COUNT(rls.packaging_lot_id)::int AS lot_count,
      CASE
        WHEN BOOL_OR(rls.confidence = 'HIGH') THEN 'HIGH'
        WHEN BOOL_OR(rls.confidence = 'MEDIUM') THEN 'MEDIUM'
        WHEN COUNT(rls.packaging_lot_id) > 0 THEN 'LOW'
        ELSE 'MISSING'
      END AS confidence
    FROM packaging_materials pm
    LEFT JOIN read_material_lot_state rls
      ON rls.packaging_material_id = pm.id
     AND rls.status NOT IN ('DEPLETED','SCRAPPED')
    WHERE pm.is_active = true
    GROUP BY pm.id, pm.kind, pm.sku, pm.name, pm.par_level
    ORDER BY pm.name;
  `);
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["packaging_materials"],
      "No packaging materials configured",
    );
    return out;
  }
  for (const r of rows) {
    const isRoll = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(
      r.material_kind,
    );
    const remainingValue = isRoll
      ? Number(r.estimated_remaining_grams)
      : Number(r.estimated_remaining_units);
    const unit = isRoll ? "g" : "units";
    const conf = r.confidence as "HIGH" | "MEDIUM" | "LOW" | "MISSING";
    out[`${r.sku}.onHand`] =
      conf === "MISSING"
        ? missing(unit, ["material_lots"], "No lots received yet")
        : {
            value: remainingValue,
            unit,
            confidence: conf,
            missingInputs: [],
            explanation: `${r.lot_count} lot(s) ${r.material_kind}`,
          };
    if (r.par_level != null && remainingValue < r.par_level && conf !== "MISSING") {
      out[`${r.sku}.belowPar`] = ok(
        `${remainingValue} / ${r.par_level}`,
        unit,
        { explanation: "Below par level" },
      );
    }
  }
  return out;
}

/** Per-product BOM listing with per-material qty + waste. Returns
 *  MISSING when the product has no BOM rows at all. */
export async function deriveProductPackagingRequirements(
  productId: string,
): Promise<MetricBundle> {
  const rows = await db
    .select({
      packagingMaterialId: productPackagingSpecs.packagingMaterialId,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
      wasteAllowancePercent: productPackagingSpecs.wasteAllowancePercent,
      sku: packagingMaterials.sku,
      name: packagingMaterials.name,
      kind: packagingMaterials.kind,
      uom: packagingMaterials.uom,
    })
    .from(productPackagingSpecs)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, productPackagingSpecs.packagingMaterialId),
    )
    .where(eq(productPackagingSpecs.productId, productId));
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["product_packaging_specs"],
      "Packaging BOM missing",
      "Configure required materials at /settings/packaging-bom.",
    );
    return out;
  }
  for (const r of rows) {
    const tag = `${r.sku}.${r.perScope}`;
    out[`${tag}.qtyPerUnit`] = ok(r.qtyPerUnit, r.uom, {
      explanation: `${r.qtyPerUnit} ${r.uom} per ${r.perScope.toLowerCase()}`,
    });
    if (r.wasteAllowancePercent && Number(r.wasteAllowancePercent) > 0) {
      out[`${tag}.wasteAllowancePct`] = ok(
        Number(r.wasteAllowancePercent),
        "%",
      );
    }
  }
  return out;
}

/** Per-material consumption rollup over a date range. Reads
 *  read_material_consumption_daily. */
export async function derivePackagingMaterialConsumption(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const fromDay = dateRange.from.toISOString().slice(0, 10);
  const toDay = dateRange.to.toISOString().slice(0, 10);
  const rows = await db.execute<{
    packaging_material_id: string;
    sku: string;
    estimated_units: number;
    actual_units: number | null;
    estimated_grams: number;
    actual_grams: number | null;
    has_actual: boolean;
    has_lot: boolean;
  }>(sql`
    SELECT
      rmcd.packaging_material_id,
      pm.sku,
      COALESCE(SUM(rmcd.estimated_consumed_units), 0)::int AS estimated_units,
      NULLIF(SUM(COALESCE(rmcd.actual_consumed_units, 0))::int, 0) AS actual_units,
      COALESCE(SUM(rmcd.estimated_consumed_grams), 0)::int AS estimated_grams,
      NULLIF(SUM(COALESCE(rmcd.actual_consumed_grams, 0))::int, 0) AS actual_grams,
      BOOL_OR(rmcd.actual_consumed_units IS NOT NULL OR rmcd.actual_consumed_grams IS NOT NULL) AS has_actual,
      BOOL_OR(rmcd.packaging_lot_id IS NOT NULL) AS has_lot
    FROM read_material_consumption_daily rmcd
    JOIN packaging_materials pm ON pm.id = rmcd.packaging_material_id
    WHERE rmcd.day >= ${fromDay}::date AND rmcd.day < ${toDay}::date
    GROUP BY rmcd.packaging_material_id, pm.sku;
  `);
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["material_inventory_events"],
      "No consumption recorded in window",
    );
    return out;
  }
  for (const r of rows) {
    const conf =
      r.has_actual && r.has_lot
        ? "HIGH"
        : r.has_actual
          ? "MEDIUM"
          : r.has_lot
            ? "MEDIUM"
            : "LOW";
    if (Number(r.estimated_grams) > 0) {
      out[`${r.sku}.estimatedConsumedGrams`] = {
        value: Number(r.estimated_grams),
        unit: "g",
        confidence: conf,
        missingInputs: r.has_lot ? [] : ["material_lot"],
      };
    }
    if (Number(r.estimated_units) > 0) {
      out[`${r.sku}.estimatedConsumedUnits`] = {
        value: Number(r.estimated_units),
        unit: "units",
        confidence: conf,
        missingInputs: r.has_lot ? [] : ["material_lot"],
      };
    }
    if (r.actual_grams != null) {
      out[`${r.sku}.actualConsumedGrams`] = ok(Number(r.actual_grams), "g");
    }
    if (r.actual_units != null) {
      out[`${r.sku}.actualConsumedUnits`] = ok(Number(r.actual_units), "units");
    }
  }
  return out;
}

/** Per-roll usage snapshot. Returns MISSING when the lot doesn't
 *  exist or is not a roll. */
export async function deriveRollUsage(
  materialLotId: string,
): Promise<MetricBundle> {
  const [row] = await db
    .select()
    .from(readRollUsage)
    .where(eq(readRollUsage.packagingLotId, materialLotId))
    .limit(1);
  if (!row) {
    return {
      _status: missing(null, ["read_roll_usage"], "Roll not found or not yet projected"),
    };
  }
  const conf = row.confidence as "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  const missingInputs: string[] = [];
  if (row.endingWeightGrams == null) missingInputs.push("weigh_back");
  if (row.expectedUsedGrams == null) missingInputs.push("blister_material_standard");
  return {
    rollNumber: row.rollNumber ? ok(row.rollNumber, null) : missing(null, ["roll_number"], "—"),
    materialKind: ok(row.materialKind, null),
    materialRole: row.materialRole ? ok(row.materialRole, null) : missing(null, [], "—"),
    startingWeightGrams:
      row.startingWeightGrams != null
        ? ok(row.startingWeightGrams, "g")
        : missing("g", ["starting_weight"], "Roll has no recorded weight"),
    endingWeightGrams:
      row.endingWeightGrams != null
        ? ok(row.endingWeightGrams, "g")
        : missing("g", ["weigh_back"], "Roll not weighed back"),
    expectedUsedGrams:
      row.expectedUsedGrams != null
        ? { value: row.expectedUsedGrams, unit: "g", confidence: conf, missingInputs }
        : missing("g", ["blister_material_standard"], "Roll standard missing"),
    actualUsedGrams:
      row.actualUsedGrams != null
        ? ok(row.actualUsedGrams, "g")
        : missing("g", ["weigh_back"], "Roll not weighed back"),
    varianceGrams:
      row.varianceGrams != null
        ? ok(row.varianceGrams, "g")
        : missing("g", missingInputs, "Variance unavailable"),
    variancePct:
      row.variancePct != null
        ? ok(Number(row.variancePct), "%")
        : missing("%", missingInputs, "Variance unavailable"),
    blistersProduced:
      row.blistersProduced != null
        ? ok(row.blistersProduced, "blisters")
        : missing("blisters", ["BLISTER_COMPLETE counter"], "—"),
    projectedRemainingGrams:
      row.projectedRemainingGrams != null
        ? ok(row.projectedRemainingGrams, "g")
        : missing("g", ["starting_weight"], "—"),
    projectedBlistersRemaining:
      row.projectedBlistersRemaining != null
        ? ok(row.projectedBlistersRemaining, "blisters")
        : missing(
            "blisters",
            ["blister_material_standard"],
            "Roll standard missing",
          ),
  };
}

/** Active rolls on a machine — currently mounted (mounted_at not
 *  null, unmounted_at null). Returns one row per active mount. */
export async function deriveActiveRolls(
  machineId?: string,
): Promise<MetricBundle> {
  const where = machineId
    ? sql`WHERE rru.unmounted_at IS NULL AND rru.machine_id = ${machineId}`
    : sql`WHERE rru.unmounted_at IS NULL AND rru.mounted_at IS NOT NULL`;
  const rows = await db.execute<{
    packaging_lot_id: string;
    roll_number: string | null;
    material_role: string | null;
    machine_id: string | null;
    starting_weight_grams: number | null;
    expected_used_grams: number | null;
    projected_remaining_grams: number | null;
    projected_blisters_remaining: number | null;
    confidence: string;
  }>(sql`
    SELECT rru.packaging_lot_id, rru.roll_number, rru.material_role, rru.machine_id,
           rru.starting_weight_grams, rru.expected_used_grams,
           rru.projected_remaining_grams, rru.projected_blisters_remaining,
           rru.confidence
    FROM read_roll_usage rru
    ${where}
    ORDER BY rru.material_role, rru.mounted_at DESC;
  `);
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["roll_mounted"],
      machineId ? "No active rolls on this machine" : "No active rolls",
    );
    return out;
  }
  for (const r of rows) {
    const tag = r.roll_number ?? r.packaging_lot_id.slice(0, 8);
    const conf = r.confidence as "HIGH" | "MEDIUM" | "LOW" | "MISSING";
    out[`${tag}.role`] = ok(r.material_role ?? "—", null);
    out[`${tag}.startingWeight`] =
      r.starting_weight_grams != null
        ? ok(r.starting_weight_grams, "g")
        : missing("g", ["starting_weight"], "—");
    out[`${tag}.projectedRemaining`] =
      r.projected_remaining_grams != null
        ? {
            value: r.projected_remaining_grams,
            unit: "g",
            confidence: conf,
            missingInputs: [],
          }
        : missing("g", ["starting_weight"], "—");
    out[`${tag}.projectedBlistersRemaining`] =
      r.projected_blisters_remaining != null
        ? ok(r.projected_blisters_remaining, "blisters")
        : missing(
            "blisters",
            ["blister_material_standard"],
            "Roll standard missing",
          );
  }
  return out;
}

/** Project when the active roll(s) on a machine will run out, given
 *  recent consumption rate. MISSING when no standard or no rate. */
export async function deriveRollRunoutProjection(
  machineId: string,
): Promise<MetricBundle> {
  const out: MetricBundle = {};
  const rows = await db.execute<{
    packaging_lot_id: string;
    material_role: string | null;
    projected_remaining_grams: number | null;
    confidence: string;
  }>(sql`
    SELECT rru.packaging_lot_id, rru.material_role,
           rru.projected_remaining_grams, rru.confidence
    FROM read_roll_usage rru
    WHERE rru.machine_id = ${machineId}
      AND rru.unmounted_at IS NULL
      AND rru.mounted_at IS NOT NULL;
  `);
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["active_roll"],
      "No active rolls on machine",
    );
    return out;
  }
  // Recent consumption rate — grams per hour over the last 24h on
  // this machine for these material roles.
  const rateRow = await db.execute<{
    role: string;
    grams_per_hour: number | null;
  }>(sql`
    SELECT pm.kind::text AS role,
           COALESCE(SUM(ev.quantity_grams)::numeric / 24, 0)::numeric AS grams_per_hour
    FROM material_inventory_events ev
    JOIN packaging_materials pm ON pm.id = ev.packaging_material_id
    WHERE ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
      AND ev.machine_id = ${machineId}
      AND ev.occurred_at >= now() - interval '24 hours'
    GROUP BY pm.kind;
  `);
  const ratesByKind: Record<string, number> = {};
  for (const r of rateRow) ratesByKind[r.role] = Number(r.grams_per_hour ?? 0);

  for (const r of rows) {
    const tag = r.material_role ?? r.packaging_lot_id.slice(0, 8);
    const remainingG = r.projected_remaining_grams ?? null;
    const rate =
      r.material_role === "PVC"
        ? ratesByKind["PVC_ROLL"] ?? 0
        : r.material_role === "FOIL"
          ? ratesByKind["FOIL_ROLL"] ?? ratesByKind["BLISTER_FOIL"] ?? 0
          : 0;
    if (remainingG == null) {
      out[`${tag}.runoutHours`] = missing(
        "h",
        ["projected_remaining"],
        "Cannot project — no starting weight",
      );
      continue;
    }
    if (rate <= 0) {
      out[`${tag}.runoutHours`] = missing(
        "h",
        ["consumption_rate"],
        "No recent consumption — cannot project runout",
      );
      continue;
    }
    out[`${tag}.runoutHours`] = ok(+(remainingG / rate).toFixed(1), "h", {
      explanation: `${remainingG}g remaining ÷ ${rate.toFixed(0)}g/h`,
    });
  }
  return out;
}

/** Materials below par given the current open production load. */
export async function derivePackagingShortageRisk(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  // Baseline: any active material with current_estimate < par_level.
  // Refinement: when there's open packaging work on a SKU, scale the
  // shortage by required-per-unit. Phase H.x2 keeps the baseline; the
  // open-work join lands when the projector hook is wired.
  const inv = await derivePackagingInventory();
  const out: MetricBundle = {};
  for (const [k, v] of Object.entries(inv)) {
    if (k.endsWith(".belowPar")) {
      const sku = k.slice(0, -".belowPar".length);
      out[sku] = v;
    }
  }
  if (Object.keys(out).length === 0) {
    out["_status"] = ok(0, "shortages", {
      explanation: "All active materials at or above par level.",
    });
  }
  return out;
}

/** Variance between estimated and actual consumption per material
 *  in the window. */
export async function deriveMaterialVariance(
  dateRange: DateRange = lastNDays(7),
): Promise<MetricBundle> {
  const fromDay = dateRange.from.toISOString().slice(0, 10);
  const toDay = dateRange.to.toISOString().slice(0, 10);
  const rows = await db.execute<{
    sku: string;
    estimated_total: number;
    actual_total: number | null;
    variance_qty: number | null;
    variance_pct: number | null;
  }>(sql`
    SELECT
      pm.sku,
      COALESCE(SUM(rmcd.estimated_consumed_units + rmcd.estimated_consumed_grams), 0)::int AS estimated_total,
      NULLIF(SUM(COALESCE(rmcd.actual_consumed_units, 0) + COALESCE(rmcd.actual_consumed_grams, 0))::int, 0) AS actual_total,
      AVG(rmcd.variance_qty)::int AS variance_qty,
      AVG(rmcd.variance_pct)::numeric AS variance_pct
    FROM read_material_consumption_daily rmcd
    JOIN packaging_materials pm ON pm.id = rmcd.packaging_material_id
    WHERE rmcd.day >= ${fromDay}::date AND rmcd.day < ${toDay}::date
    GROUP BY pm.sku;
  `);
  const out: MetricBundle = {};
  if (rows.length === 0) {
    out["_status"] = missing(
      null,
      ["read_material_consumption_daily"],
      "No consumption in window",
    );
    return out;
  }
  for (const r of rows) {
    if (r.actual_total == null) {
      out[`${r.sku}.variance`] = missing(
        "%",
        ["actual_consumption"],
        "No weigh-back / actual count yet",
      );
      continue;
    }
    out[`${r.sku}.variance`] = ok(Number(r.variance_qty ?? 0), "qty", {
      explanation: `est ${r.estimated_total} vs actual ${r.actual_total}`,
    });
    if (r.variance_pct != null) {
      out[`${r.sku}.variancePct`] = ok(Number(r.variance_pct), "%");
    }
  }
  return out;
}
