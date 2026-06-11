// Dashboard owner-home loaders.
//
// Finalized-bag counts and tablet totals come from workflow_bags +
// read_bag_metrics. read_daily_throughput is a rollup for floor pace,
// while this owner dashboard keeps finalized output tied directly to
// the per-bag source metric rows. metrics-strategy.md §1.1–1.2.

import { sql, and, gte, eq, isNotNull, lt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  workflowBags,
  workflowEvents,
  qrCards,
  readBagState,
  readBagMetrics,
  products,
  tabletTypes,
} from "@/lib/db/schema";

/** Company display timezone — matches company.timezone default. */
export const DASHBOARD_TZ = "America/New_York";

/** ET calendar day bucket for a finalized_at timestamptz. */
export function finalizedDayEtSql() {
  return sql`(${workflowBags.finalizedAt} AT TIME ZONE ${DASHBOARD_TZ})::date`;
}

/** Today's date in ET as a YYYY-MM-DD string (for tests / comparisons). */
export function todayEtDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DASHBOARD_TZ }).format(now);
}

const WEEKDAY_ET: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** ISO weekday 1=Mon … 7=Sun in company timezone. */
export function weekdayEt(now = new Date()): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: DASHBOARD_TZ,
    weekday: "short",
  }).format(now);
  return WEEKDAY_ET[short] ?? 1;
}

/** Mon–Fri production days left in the current week (including today). */
export function businessDaysRemainingInWeekEt(now = new Date()): number {
  const wd = weekdayEt(now);
  if (wd >= 6) return 0;
  return Math.max(5 - wd, 0);
}

export async function getFinalizedToday() {
  const [todayRow] = await db
    .select({
      n: sql<number>`COUNT(*)::int`,
    })
    .from(workflowBags)
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        sql`${finalizedDayEtSql()} = (now() AT TIME ZONE ${DASHBOARD_TZ})::date`,
      ),
    );

  const [last7Row] = await db
    .select({
      n: sql<number>`COUNT(*)::int`,
      days: sql<number>`COUNT(DISTINCT ${finalizedDayEtSql()})::int`,
    })
    .from(workflowBags)
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        sql`${finalizedDayEtSql()} >= (now() AT TIME ZONE ${DASHBOARD_TZ})::date - 7`,
        sql`${finalizedDayEtSql()} < (now() AT TIME ZONE ${DASHBOARD_TZ})::date`,
      ),
    );

  const todayN = todayRow?.n ?? 0;
  const last7N = last7Row?.n ?? 0;
  const days = Math.max(last7Row?.days ?? 7, 1);
  const avg7 = last7N / days;
  return { todayN, last7N, avg7 };
}

export async function getCashOnFloor() {
  const [received] = await db
    .select({
      bags: sql<number>`COUNT(*)::int`,
      units: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}),0)::int`,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.status, "AVAILABLE"));
  const [inUse] = await db
    .select({
      bags: sql<number>`COUNT(*)::int`,
      units: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}),0)::int`,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.status, "IN_USE"));
  const [unfinalized] = await db
    .select({
      bags: sql<number>`COUNT(*)::int`,
      units: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}),0)::int`,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(workflowBags.inventoryBagId, inventoryBags.id))
    .where(isNull(workflowBags.finalizedAt));
  const total =
    (received?.units ?? 0) + (inUse?.units ?? 0) + (unfinalized?.units ?? 0);
  const stages = [
    { label: "Received", units: received?.units ?? 0, bags: received?.bags ?? 0 },
    { label: "In production", units: unfinalized?.units ?? 0, bags: unfinalized?.bags ?? 0 },
    { label: "In use", units: inUse?.units ?? 0, bags: inUse?.bags ?? 0 },
  ];
  stages.sort((a, b) => b.units - a.units);
  return { totalUnits: total, biggest: stages[0] };
}

export async function getAgedUnfinalized() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [agg] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
      units: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}),0)::int`,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(workflowBags.inventoryBagId, inventoryBags.id))
    .where(
      and(
        isNull(workflowBags.finalizedAt),
        lt(workflowBags.startedAt, thirtyDaysAgo),
      ),
    );
  return { count: agg?.count ?? 0, units: agg?.units ?? 0 };
}

export async function getForgottenBagCount() {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(readBagState)
    .innerJoin(workflowBags, eq(workflowBags.id, readBagState.workflowBagId))
    .where(
      and(
        eq(readBagState.isPaused, true),
        isNotNull(readBagState.pausedAt),
        lt(readBagState.pausedAt, thirtyMinAgo),
        isNull(workflowBags.finalizedAt),
      ),
    );
  return r?.n ?? 0;
}

export async function getPredictedShippableThisWeek() {
  const [thisWeek] = await db
    .select({
      n: sql<number>`COUNT(*)::int`,
    })
    .from(workflowBags)
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        sql`${finalizedDayEtSql()} >= date_trunc('week', (now() AT TIME ZONE ${DASHBOARD_TZ})::date)::date`,
        sql`${finalizedDayEtSql()} <= (now() AT TIME ZONE ${DASHBOARD_TZ})::date`,
      ),
    );

  const [last7Row] = await db
    .select({
      n: sql<number>`COUNT(*)::int`,
      days: sql<number>`COUNT(DISTINCT ${finalizedDayEtSql()})::int`,
    })
    .from(workflowBags)
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        sql`${finalizedDayEtSql()} >= (now() AT TIME ZONE ${DASHBOARD_TZ})::date - 7`,
        sql`${finalizedDayEtSql()} <= (now() AT TIME ZONE ${DASHBOARD_TZ})::date`,
      ),
    );

  const now = new Date();
  const dailyAvg = (last7Row?.n ?? 0) / Math.max(last7Row?.days ?? 7, 1);
  const businessDaysRemaining = businessDaysRemainingInWeekEt(now);
  const predictedExtra = Math.round(dailyAvg * businessDaysRemaining);
  return {
    thisWeekSoFar: thisWeek?.n ?? 0,
    predictedExtra,
    total: (thisWeek?.n ?? 0) + predictedExtra,
    dailyAvg7: Math.round(dailyAvg),
    businessDaysRemaining,
    weekdayEt: weekdayEt(now),
  };
}

export async function getTopFlavorsByFinalized() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      tabletName: tabletTypes.name,
      productName: products.name,
      bagsFinalized: sql<number>`COUNT(*)::int`,
      unitsFinalized: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
    })
    .from(workflowBags)
    .innerJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(inventoryBags, eq(workflowBags.inventoryBagId, inventoryBags.id))
    .leftJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .where(
      and(
        gte(workflowBags.finalizedAt, thirtyDaysAgo),
        isNotNull(workflowBags.finalizedAt),
      ),
    )
    .groupBy(tabletTypes.name, products.name)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(3);
  return rows;
}

export async function getActivityHeartbeat() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(workflowEvents)
    .where(gte(workflowEvents.occurredAt, since));
  return r?.n ?? 0;
}

export async function getActiveQrCardCount() {
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(qrCards)
    .where(eq(qrCards.status, "ASSIGNED"));
  return r?.n ?? 0;
}

// ── P4-DASHBOARD · Action Center counts ─────────────────────────────
//
// One query answering "what needs a human right now?": lot-review
// backlog, runs missing source allocation, partial bags by state,
// holds, quarantined batches, and Zoho production-output queue health.
// Every count maps 1:1 to an actionable queue page.

export type ActionCenterCounts = {
  needsLotReview: number;
  runsMissingAllocation: number;
  partialsReady: number;
  partialsNeedCloseout: number;
  bagsOnHold: number;
  quarantinedBatches: number;
  zohoQueued: number;
  zohoFailed: number;
  zohoNeedsMapping: number;
};

export async function getActionCenterCounts(): Promise<ActionCenterCounts> {
  type Row = {
    needs_lot_review: number;
    runs_missing_allocation: number;
    partials_ready: number;
    partials_need_closeout: number;
    bags_on_hold: number;
    quarantined_batches: number;
    zoho_queued: number;
    zoho_failed: number;
    zoho_needs_mapping: number;
  };
  const rows = (await db.execute<Row>(sql`
    WITH latest_closed AS (
      SELECT DISTINCT ON (s.inventory_bag_id)
        s.inventory_bag_id, s.ending_balance_qty
      FROM raw_bag_allocation_sessions s
      WHERE s.allocation_status IN ('CLOSED','RETURNED_TO_STOCK')
      ORDER BY s.inventory_bag_id, s.closed_at DESC NULLS LAST
    ),
    open_bags AS (
      SELECT DISTINCT inventory_bag_id
      FROM raw_bag_allocation_sessions
      WHERE allocation_status = 'OPEN'
    ),
    partials AS (
      SELECT
        COUNT(*) FILTER (WHERE l.ending_balance_qty > 0)::int AS ready,
        COUNT(*) FILTER (
          WHERE l.ending_balance_qty IS NULL OR l.ending_balance_qty = 0
        )::int AS need_closeout
      FROM latest_closed l
      JOIN inventory_bags ib
        ON ib.id = l.inventory_bag_id AND ib.status = 'AVAILABLE'
      WHERE l.inventory_bag_id NOT IN (SELECT inventory_bag_id FROM open_bags)
    )
    SELECT
      (SELECT COUNT(*)
         FROM workflow_bags wb
         LEFT JOIN finished_lots fl ON fl.workflow_bag_id = wb.id
         LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
        WHERE wb.finalized_at IS NOT NULL
          AND fl.id IS NULL
          AND COALESCE(rbs.excluded_from_output, false) = false
      )::int AS needs_lot_review,
      (SELECT COUNT(*)
         FROM workflow_bags wb
         JOIN read_bag_state rbs
           ON rbs.workflow_bag_id = wb.id AND rbs.is_finalized = false
        WHERE wb.inventory_bag_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM raw_bag_allocation_sessions s
            WHERE s.workflow_bag_id = wb.id
          )
      )::int AS runs_missing_allocation,
      (SELECT ready FROM partials)            AS partials_ready,
      (SELECT need_closeout FROM partials)    AS partials_need_closeout,
      (SELECT COUNT(*) FROM inventory_bags WHERE status = 'QUARANTINED')::int AS bags_on_hold,
      (SELECT COUNT(*) FROM batches WHERE status = 'QUARANTINE')::int AS quarantined_batches,
      (SELECT COUNT(*) FROM zoho_production_output_ops
        WHERE status = 'QUEUED' AND voided_at IS NULL)::int AS zoho_queued,
      (SELECT COUNT(*) FROM zoho_production_output_ops
        WHERE status = 'FAILED' AND voided_at IS NULL)::int AS zoho_failed,
      (SELECT COUNT(*) FROM zoho_production_output_ops
        WHERE status = 'NEEDS_MAPPING' AND voided_at IS NULL)::int AS zoho_needs_mapping
  `)) as unknown as Row[];

  const r = rows[0];
  return {
    needsLotReview: Number(r?.needs_lot_review ?? 0),
    runsMissingAllocation: Number(r?.runs_missing_allocation ?? 0),
    partialsReady: Number(r?.partials_ready ?? 0),
    partialsNeedCloseout: Number(r?.partials_need_closeout ?? 0),
    bagsOnHold: Number(r?.bags_on_hold ?? 0),
    quarantinedBatches: Number(r?.quarantined_batches ?? 0),
    zohoQueued: Number(r?.zoho_queued ?? 0),
    zohoFailed: Number(r?.zoho_failed ?? 0),
    zohoNeedsMapping: Number(r?.zoho_needs_mapping ?? 0),
  };
}
