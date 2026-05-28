// Dashboard owner-home loaders.
//
// Finalized-bag counts and tablet totals come from workflow_bags +
// read_bag_metrics — not read_daily_throughput. The throughput projector
// skips events when the firing station has no machine_id (e.g. packaging
// stations), so aggregate rows under-count finalized bags and never carry
// units_yielded. metrics-strategy.md §1.1–1.2.

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
  const dow = now.getDay();
  const daysSinceMon = (dow + 6) % 7;
  const dailyAvg = (last7Row?.n ?? 0) / Math.max(last7Row?.days ?? 7, 1);
  const businessDaysSoFar = Math.min(daysSinceMon + 1, 5);
  const businessDaysRemaining = Math.max(5 - businessDaysSoFar, 0);
  const predictedExtra = Math.round(dailyAvg * businessDaysRemaining);
  return {
    thisWeekSoFar: thisWeek?.n ?? 0,
    predictedExtra,
    total: (thisWeek?.n ?? 0) + predictedExtra,
    dailyAvg7: Math.round(dailyAvg),
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
