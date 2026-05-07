// Phase E.5 — workflow health + activity-signals + blocked-metrics
// diagnostics. Answers the question "why does the command center
// show zeros even though there's activity?"
//
// Honest-data discipline (locked):
//   • Activity signals (raw event counts) are NEVER reported as
//     output / yield / OEE / good units. They live in their own
//     panel labelled clearly.
//   • Blocked metrics list each KPI that can't be computed today,
//     plus the specific data gap and the action needed.
//   • Workflow health surfaces the % of bags that finalize, % with
//     operator capture, % with product mapping — so the floor lead
//     can see what's broken in the operator workflow.

import { sql, eq, isNull, isNotNull, and, gte, count } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  workflowEvents,
  workflowBags,
  readBagState,
  readBagMetrics,
  inventoryBags,
  productionCalendars,
  stationStandards,
  laborRates,
  dueTargets,
} from "@/lib/db/schema";

// ─── 1. Workflow health ───────────────────────────────────────────

export interface WorkflowHealth {
  totalEvents: number;
  totalBags: number;
  activeBags: number;       // not finalized
  finalizedBags: number;
  pausedBags: number;
  bagsByStage: Record<string, number>;
  /** Bags with stage events but no BAG_FINALIZED — the gap that
   *  blocks read_sku_daily / read_material_reconciliation. */
  bagsMissingFinalization: number;
  /** Bags that have started but never reached BLISTERED/SEALED. */
  bagsStuckAtStart: number;
  /** Bags blistered but never sealed. */
  bagsStuckAtBlister: number;
  /** Bags sealed but never packaged. */
  bagsStuckAtSeal: number;
  /** Bags packaged but never finalized. */
  bagsPackagedNotFinalized: number;
  /** Operator-code capture: count of in-flight bags that have a
   *  current_operator_code set. */
  operatorCodeCaptureCount: number;
  /** Product-mapping capture: count of bags with a product_id. */
  productMappingCount: number;
  /** Inventory-bag mapping: count of bags with a received qty. */
  receivedQtyMappingCount: number;
  /** Completion rate, pct, only meaningful if totalBags > 0. */
  completionRatePct: number | null;
  forceReleaseCount: number;
  submissionCorrectionCount: number;
  packagingSnapshotCount: number;
  packagingCompleteCount: number;
  lastEventAt: Date | null;
}

export async function deriveWorkflowHealth(): Promise<WorkflowHealth> {
  const [
    totalEventsRow,
    totalBagsRow,
    finalizedRow,
    activeRow,
    pausedRow,
    bagsByStageRows,
    forceReleaseRow,
    correctionsRow,
    snapshotRow,
    completeRow,
    operatorCapRow,
    productMapRow,
    receivedQtyRow,
    lastEventRow,
  ] = await Promise.all([
    db.select({ n: count() }).from(workflowEvents),
    db.select({ n: count() }).from(workflowBags),
    db
      .select({ n: count() })
      .from(workflowBags)
      .where(isNotNull(workflowBags.finalizedAt)),
    db
      .select({ n: count() })
      .from(readBagState)
      .where(eq(readBagState.isFinalized, false)),
    db
      .select({ n: count() })
      .from(readBagState)
      .where(eq(readBagState.isPaused, true)),
    db
      .select({ stage: readBagState.stage, n: count() })
      .from(readBagState)
      .where(eq(readBagState.isFinalized, false))
      .groupBy(readBagState.stage),
    db
      .select({ n: count() })
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, "CARD_FORCE_RELEASED")),
    db
      .select({ n: count() })
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, "SUBMISSION_CORRECTED")),
    db
      .select({ n: count() })
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, "PACKAGING_SNAPSHOT")),
    db
      .select({ n: count() })
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, "PACKAGING_COMPLETE")),
    db
      .select({ n: count() })
      .from(readBagState)
      .where(
        and(
          eq(readBagState.isFinalized, false),
          isNotNull(readBagState.currentOperatorCode),
        ),
      ),
    db
      .select({ n: count() })
      .from(readBagState)
      .where(isNotNull(readBagState.productId)),
    db
      .select({ n: count() })
      .from(workflowBags)
      .innerJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
      .where(isNotNull(inventoryBags.pillCount)),
    db
      .select({
        last: sql<Date | null>`MAX(${workflowEvents.occurredAt})`,
      })
      .from(workflowEvents),
  ]);

  const totalBags = Number(totalBagsRow[0]?.n ?? 0);
  const finalizedBags = Number(finalizedRow[0]?.n ?? 0);
  const activeBags = Number(activeRow[0]?.n ?? 0);
  const pausedBags = Number(pausedRow[0]?.n ?? 0);

  const bagsByStage: Record<string, number> = {};
  for (const r of bagsByStageRows) {
    bagsByStage[r.stage] = Number(r.n);
  }

  return {
    totalEvents: Number(totalEventsRow[0]?.n ?? 0),
    totalBags,
    activeBags,
    finalizedBags,
    pausedBags,
    bagsByStage,
    bagsMissingFinalization: activeBags,
    bagsStuckAtStart: bagsByStage["STARTED"] ?? 0,
    bagsStuckAtBlister: bagsByStage["BLISTERED"] ?? 0,
    bagsStuckAtSeal: bagsByStage["SEALED"] ?? 0,
    bagsPackagedNotFinalized: bagsByStage["PACKAGED"] ?? 0,
    operatorCodeCaptureCount: Number(operatorCapRow[0]?.n ?? 0),
    productMappingCount: Number(productMapRow[0]?.n ?? 0),
    receivedQtyMappingCount: Number(receivedQtyRow[0]?.n ?? 0),
    completionRatePct:
      totalBags > 0 ? +((finalizedBags / totalBags) * 100).toFixed(1) : null,
    forceReleaseCount: Number(forceReleaseRow[0]?.n ?? 0),
    submissionCorrectionCount: Number(correctionsRow[0]?.n ?? 0),
    packagingSnapshotCount: Number(snapshotRow[0]?.n ?? 0),
    packagingCompleteCount: Number(completeRow[0]?.n ?? 0),
    lastEventAt: lastEventRow[0]?.last ?? null,
  };
}

// ─── 2. Activity signals (raw event counts, NEVER output) ─────────

export interface ActivitySignals {
  /** Stage events — these are NOT output. They prove the floor is
   *  scanning and machines are running. */
  blisterEvents30d: number;
  sealingEvents30d: number;
  packagingSnapshots30d: number;
  packagingComplete30d: number;
  bottleHandpack30d: number;
  bottleCapSeal30d: number;
  bottleSticker30d: number;
  cardAssigned30d: number;
  bagPaused30d: number;
  bagResumed30d: number;
  /** Per-station last activity timestamp — drives "is this station alive?" */
  lastEventByStation: Array<{
    stationId: string;
    stationLabel: string | null;
    machineName: string | null;
    machineKind: string | null;
    lastEventAt: Date;
    eventCount30d: number;
  }>;
  /** Total events in last 30d (for the headline number). */
  totalEvents30d: number;
}

export async function deriveActivitySignals(): Promise<ActivitySignals> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const sinceIso = since.toISOString();

  const stageCounts = await db.execute<{ event_type: string; n: number }>(sql`
    SELECT event_type, COUNT(*)::int AS n
    FROM workflow_events
    WHERE occurred_at >= ${sinceIso}::timestamptz
    GROUP BY event_type;
  `);
  const map: Record<string, number> = {};
  for (const r of stageCounts) {
    map[r.event_type] = Number(r.n);
  }
  const totalEvents30d = Object.values(map).reduce((s, n) => s + n, 0);

  const lastByStation = await db.execute<{
    station_id: string;
    station_label: string | null;
    machine_name: string | null;
    machine_kind: string | null;
    last_event_at: Date;
    event_count_30d: number;
  }>(sql`
    SELECT we.station_id,
           s.label AS station_label,
           m.name AS machine_name,
           m.kind::text AS machine_kind,
           MAX(we.occurred_at) AS last_event_at,
           COUNT(*)::int AS event_count_30d
    FROM workflow_events we
    LEFT JOIN stations s ON s.id = we.station_id
    LEFT JOIN machines m ON m.id = s.machine_id
    WHERE we.occurred_at >= ${sinceIso}::timestamptz
      AND we.station_id IS NOT NULL
    GROUP BY we.station_id, s.label, m.name, m.kind
    ORDER BY last_event_at DESC
    LIMIT 20;
  `);

  return {
    blisterEvents30d: map["BLISTER_COMPLETE"] ?? 0,
    sealingEvents30d: map["SEALING_COMPLETE"] ?? 0,
    packagingSnapshots30d: map["PACKAGING_SNAPSHOT"] ?? 0,
    packagingComplete30d: map["PACKAGING_COMPLETE"] ?? 0,
    bottleHandpack30d: map["BOTTLE_HANDPACK_COMPLETE"] ?? 0,
    bottleCapSeal30d: map["BOTTLE_CAP_SEAL_COMPLETE"] ?? 0,
    bottleSticker30d: map["BOTTLE_STICKER_COMPLETE"] ?? 0,
    cardAssigned30d: map["CARD_ASSIGNED"] ?? 0,
    bagPaused30d: map["BAG_PAUSED"] ?? 0,
    bagResumed30d: map["BAG_RESUMED"] ?? 0,
    totalEvents30d,
    lastEventByStation: lastByStation.map((r) => ({
      stationId: r.station_id,
      stationLabel: r.station_label,
      machineName: r.machine_name,
      machineKind: r.machine_kind,
      lastEventAt: new Date(r.last_event_at),
      eventCount30d: Number(r.event_count_30d),
    })),
  };
}

// ─── 3. Blocked metrics ───────────────────────────────────────────

export interface BlockedMetric {
  metric: string;
  reason: string;
  required: ReadonlyArray<string>;
  missing: ReadonlyArray<string>;
  action: string;
}

export async function deriveBlockedMetrics(): Promise<BlockedMetric[]> {
  // Existence checks for every gating input.
  const [
    finalizedRow,
    bagMetricsRow,
    rebagsWithOpRow,
    productionCalRow,
    stationStdRow,
    laborRow,
    dueRow,
    rejectsRow,
    reworkRow,
  ] = await Promise.all([
    db
      .select({ n: count() })
      .from(workflowBags)
      .where(isNotNull(workflowBags.finalizedAt)),
    db.select({ n: count() }).from(readBagMetrics),
    db
      .select({ n: count() })
      .from(readBagState)
      .where(isNotNull(readBagState.currentOperatorCode)),
    db.select({ n: count() }).from(productionCalendars),
    db
      .select({ n: count() })
      .from(stationStandards)
      .where(eq(stationStandards.isActive, true)),
    db.select({ n: count() }).from(laborRates),
    db.select({ n: count() }).from(dueTargets),
    db
      .select({ n: count() })
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, "PACKAGING_DAMAGE_RETURN")),
    db
      .select({ n: count() })
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, "REWORK_SENT")),
  ]);

  const finalized = Number(finalizedRow[0]?.n ?? 0);
  const bagMetrics = Number(bagMetricsRow[0]?.n ?? 0);
  const opCaptured = Number(rebagsWithOpRow[0]?.n ?? 0);
  const calendars = Number(productionCalRow[0]?.n ?? 0);
  const stdRows = Number(stationStdRow[0]?.n ?? 0);
  const labor = Number(laborRow[0]?.n ?? 0);
  const due = Number(dueRow[0]?.n ?? 0);
  const rejects = Number(rejectsRow[0]?.n ?? 0);
  const rework = Number(reworkRow[0]?.n ?? 0);

  const blocked: BlockedMetric[] = [];

  if (bagMetrics === 0) {
    blocked.push({
      metric: "Good units today / Displays / Cases",
      reason: "No bags have reached BAG_FINALIZED — output projector hasn't run.",
      required: ["workflow_events.BAG_FINALIZED", "read_bag_metrics rows"],
      missing: finalized === 0 ? ["BAG_FINALIZED events"] : ["read_bag_metrics rows"],
      action:
        finalized === 0
          ? "Operators must complete the full flow including the Finalize button on the floor station, OR map legacy activity into BAG_FINALIZED via the legacy synthesizer."
          : "Run npm run rebuild:read-models on the host to materialise read_bag_metrics from finalized bags.",
    });
  }

  if (calendars === 0 || stdRows === 0 || rejects === 0) {
    const missing: string[] = [];
    if (calendars === 0) missing.push("production_calendars");
    if (stdRows === 0) missing.push("station_standards");
    if (rejects === 0) missing.push("reject events (PACKAGING_DAMAGE_RETURN)");
    blocked.push({
      metric: "OEE (Availability × Performance × Quality)",
      reason: "OEE refuses to compute without all three input families.",
      required: [
        "production_calendars (planned production minutes)",
        "station_standards (ideal cycle / target rate)",
        "reject/scrap events (Quality factor)",
      ],
      missing,
      action: `Configure missing standards at /standards. ${
        rejects === 0 ? "Reject capture flow lands in Phase F." : ""
      }`.trim(),
    });
  }

  if (due === 0) {
    blocked.push({
      metric: "Schedule gap / On-time completion",
      reason: "No due targets configured.",
      required: ["due_targets"],
      missing: ["due_targets"],
      action: "Add due targets at /standards/due-targets.",
    });
  }

  if (labor === 0) {
    blocked.push({
      metric: "Labor cost per case / per operator-hour",
      reason: "No labor rates configured.",
      required: ["labor_rates"],
      missing: ["labor_rates"],
      action: "Add hourly + burden at /standards/labor-rates.",
    });
  }

  if (opCaptured === 0) {
    blocked.push({
      metric: "Operator productivity per individual",
      reason: "No bag has a currentOperatorCode set on read_bag_state.",
      required: ["operator_code on stage events"],
      missing: ["read_bag_state.current_operator_code"],
      action:
        "Operators must enter their 4-digit code at the start of a run. Check the floor station UI's operator-code prompt.",
    });
  }

  if (rework === 0) {
    blocked.push({
      metric: "Rework rate",
      reason: "REWORK_SENT events are not yet emitted by any flow.",
      required: ["REWORK_SENT events"],
      missing: ["REWORK_SENT emission path"],
      action:
        "Phase F task — wire a 'send back to sealing' button into the packaging-complete form so REWORK_SENT fires.",
    });
  }

  if (finalized === 0) {
    blocked.push({
      metric: "Material reconciliation",
      reason: "Per-bag reconciliation is computed at BAG_FINALIZED time — no finalised bags yet.",
      required: ["BAG_FINALIZED + inventory_bag.pill_count + read_bag_metrics"],
      missing: ["BAG_FINALIZED"],
      action: "See Good units blocker above — same root cause.",
    });
  }

  return blocked;
}
