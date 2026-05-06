// Owner home — the five numbers that matter, plus the single prediction
// with the highest financial swing this week. Per metrics-strategy.md
// §13.1: every tile here must drive an action; vanity metrics are out.

import Link from "next/link";
import {
  ArrowRight,
  Activity,
  PackageCheck,
  Wallet,
  Hourglass,
  Gauge,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import { sql, and, isNull, lt, gte, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  workflowBags,
  workflowEvents,
  qrCards,
  readDailyThroughput,
  readBagState,
  products,
  tabletTypes,
} from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { requireSession } from "@/lib/auth-guards";

export const dynamic = "force-dynamic";

// ── Loaders ────────────────────────────────────────────────────────

/** Finalized today + delta vs 7-day average + 7-day total. */
async function getFinalizedToday() {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [todayRow] = await db
    .select({
      n: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(eq(readDailyThroughput.day, today));
  const [last7Row] = await db
    .select({
      n: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
      days: sql<number>`COALESCE(COUNT(DISTINCT ${readDailyThroughput.day}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(
      and(
        sql`${readDailyThroughput.day} >= ${sevenDaysAgo}::date`,
        sql`${readDailyThroughput.day} < ${today}::date`,
      ),
    );
  const todayN = todayRow?.n ?? 0;
  const last7N = last7Row?.n ?? 0;
  const days = Math.max(last7Row?.days ?? 7, 1);
  const avg7 = last7N / days;
  return { todayN, last7N, avg7 };
}

/** Cash-on-floor (units approximation, since unit_cost_cents isn't
 *  captured yet — §15.2/15.3 in the strategy doc). Sum of pillCount
 *  across bags by lifecycle stage. */
async function getCashOnFloor() {
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
  // The largest stage is the bottleneck where cash is sitting.
  const stages: Array<{ label: string; units: number; bags: number }> = [
    { label: "Received", units: received?.units ?? 0, bags: received?.bags ?? 0 },
    { label: "In production", units: unfinalized?.units ?? 0, bags: unfinalized?.bags ?? 0 },
    { label: "In use", units: inUse?.units ?? 0, bags: inUse?.bags ?? 0 },
  ];
  stages.sort((a, b) => b.units - a.units);
  return { totalUnits: total, biggest: stages[0] };
}

/** Aged unfinalized (§7.5) — bags whose started_at < 30d ago and
 *  not finalized. The single highest-stakes owner number when it's
 *  non-zero — bags sitting on cash. */
async function getAgedUnfinalized() {
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

/** Forgotten bags — paused > 30 min, not finalized. Drives the
 *  "one prediction" line when count is non-zero. */
async function getForgottenBagCount() {
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

/** Predicted shippable units this week — extrapolate from today's
 *  finalized rate × business-days remaining + this-week-so-far.
 *  Falls back to "—" if no recent throughput. */
async function getPredictedShippableThisWeek() {
  // Compute Monday of current ET week.
  const now = new Date();
  const dow = now.getDay(); // 0 = Sun, 1 = Mon...
  const daysSinceMon = (dow + 6) % 7;
  const mondayMs = now.getTime() - daysSinceMon * 24 * 60 * 60 * 1000;
  const mondayStr = new Date(mondayMs).toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);
  const [thisWeek] = await db
    .select({
      n: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
      days: sql<number>`COALESCE(COUNT(DISTINCT ${readDailyThroughput.day}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(
      and(
        sql`${readDailyThroughput.day} >= ${mondayStr}::date`,
        sql`${readDailyThroughput.day} <= ${todayStr}::date`,
      ),
    );
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [last7Row] = await db
    .select({
      n: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
      days: sql<number>`COALESCE(COUNT(DISTINCT ${readDailyThroughput.day}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(sql`${readDailyThroughput.day} >= ${sevenDaysAgo}::date`);
  const dailyAvg = (last7Row?.n ?? 0) / Math.max(last7Row?.days ?? 7, 1);
  const businessDaysSoFar = Math.min(daysSinceMon + 1, 5); // Mon-Fri working
  const businessDaysRemaining = Math.max(5 - businessDaysSoFar, 0);
  const predictedExtra = Math.round(dailyAvg * businessDaysRemaining);
  return {
    thisWeekSoFar: thisWeek?.n ?? 0,
    predictedExtra,
    total: (thisWeek?.n ?? 0) + predictedExtra,
    dailyAvg7: Math.round(dailyAvg),
  };
}

/** Cash-flip ranking by flavor — top performer last 30d (§7.11
 *  approx, no $ yet). Returns top 3 flavors with most finalized
 *  bags + their unit total. */
async function getTopFlavorsByFinalized() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      tabletName: tabletTypes.name,
      productName: products.name,
      bagsFinalized: sql<number>`COUNT(*)::int`,
      unitsFinalized: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}),0)::int`,
    })
    .from(workflowBags)
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

/** Workflow events activity for last 24h, used in the "throughput
 *  today vs avg" sparkline-style summary. */
async function getActivityHeartbeat() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(workflowEvents)
    .where(gte(workflowEvents.occurredAt, since));
  return r?.n ?? 0;
}

// ── Page ───────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const me = await requireSession();
  void me;

  const [
    finalized,
    cash,
    aged,
    forgotten,
    predicted,
    topFlavors,
    eventsLast24h,
  ] = await Promise.all([
    getFinalizedToday(),
    getCashOnFloor(),
    getAgedUnfinalized(),
    getForgottenBagCount(),
    getPredictedShippableThisWeek(),
    getTopFlavorsByFinalized(),
    getActivityHeartbeat(),
  ]);

  // The "one prediction with the highest financial swing this week"
  // line per §13.1 — pick the highest-impact actionable signal.
  const prediction = pickPrediction({
    forgottenBags: forgotten,
    agedUnfinalizedBags: aged.count,
    agedUnfinalizedUnits: aged.units,
    predicted,
    finalizedToday: finalized.todayN,
    avg7: finalized.avg7,
  });

  const finalizedDelta = finalized.todayN - finalized.avg7;
  const finalizedPctDelta =
    finalized.avg7 > 0 ? (finalizedDelta / finalized.avg7) * 100 : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Today, at a glance"
        description="The five numbers that matter — and the one prediction worth acting on."
      />

      {/* Big-number row — the five owner numbers. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <BigTile
          icon={PackageCheck}
          label="Finalized today"
          value={finalized.todayN.toLocaleString()}
          hint={
            finalized.avg7 === 0
              ? "no 7-day baseline yet"
              : `${
                  finalizedDelta >= 0 ? "+" : ""
                }${Math.round(finalizedPctDelta)}% vs 7-day avg (${Math.round(finalized.avg7)})`
          }
          tone={
            finalized.avg7 > 0 && finalizedDelta < -finalized.avg7 * 0.3
              ? "warn"
              : "ok"
          }
          href="/floor-board"
        />
        <BigTile
          icon={Wallet}
          label="Tablets on the floor"
          value={cash.totalUnits.toLocaleString()}
          hint={
            cash.biggest && cash.biggest.units > 0
              ? `${cash.biggest.label} holds ${cash.biggest.bags} bags · ${cash.biggest.units.toLocaleString()} tablets`
              : "no inventory tracked"
          }
          tone="default"
          href="/inbound"
        />
        <BigTile
          icon={Gauge}
          label="Activity (24h)"
          value={eventsLast24h.toLocaleString()}
          hint={`${forgotten} forgotten bag${forgotten === 1 ? "" : "s"} right now`}
          tone={forgotten > 0 ? "danger" : "ok"}
          href="/floor-board"
        />
        <BigTile
          icon={TrendingUp}
          label="Predicted this week"
          value={predicted.total.toLocaleString()}
          hint={
            predicted.dailyAvg7 > 0
              ? `~${predicted.dailyAvg7}/day · ${predicted.thisWeekSoFar} so far · ${predicted.predictedExtra} more forecast`
              : "no recent throughput"
          }
          tone="default"
          href="/metrics"
        />
        <BigTile
          icon={Hourglass}
          label="Aged > 30 days"
          value={aged.count.toLocaleString()}
          hint={
            aged.count === 0
              ? "all inventory fresh"
              : `${aged.units.toLocaleString()} tablets sitting`
          }
          tone={aged.count > 0 ? "warn" : "ok"}
          href="/floor-board"
        />
      </div>

      {/* The one prediction with highest financial swing this week. */}
      <div
        className={
          "rounded-xl border p-4 flex items-start gap-3 " +
          (prediction.tone === "danger"
            ? "border-red-200 bg-red-50/50"
            : prediction.tone === "warn"
              ? "border-amber-200 bg-amber-50/50"
              : "border-brand-200 bg-brand-50/50")
        }
      >
        <AlertTriangle
          className={
            "h-5 w-5 mt-0.5 shrink-0 " +
            (prediction.tone === "danger"
              ? "text-red-700"
              : prediction.tone === "warn"
                ? "text-amber-700"
                : "text-brand-700")
          }
        />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-text-subtle font-semibold">
            The one prediction worth acting on
          </div>
          <div className="text-sm text-text font-medium">
            {prediction.headline}
          </div>
          {prediction.detail && (
            <div className="text-xs text-text-muted">{prediction.detail}</div>
          )}
          {prediction.cta && (
            <Link
              href={prediction.cta.href}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline mt-1"
            >
              {prediction.cta.label} <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>

      {/* Top flavors strip — secondary context. */}
      {topFlavors.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-surface p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">
              Top flavors finalized · last 30 days
            </h2>
            <Link
              href="/metrics"
              className="text-[11px] text-text-muted hover:underline"
            >
              all metrics →
            </Link>
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {topFlavors.map((f, i) => (
              <li
                key={(f.tabletName ?? "") + (f.productName ?? "") + i}
                className="rounded-lg border border-border/50 bg-surface-2 p-2.5"
              >
                <div className="text-xs font-medium truncate">
                  {f.productName ?? f.tabletName ?? "—"}
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {f.bagsFinalized}
                  <span className="text-[11px] font-normal text-text-muted ml-1">
                    bags
                  </span>
                </div>
                <div className="text-[11px] text-text-subtle">
                  {f.unitsFinalized.toLocaleString()} tablets
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Quick-access strip — secondary, smaller. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <QuickLink href="/floor-board" label="Live floor" />
        <QuickLink href="/inbound" label="POs &amp; receiving" />
        <QuickLink href="/batches" label="Batches" />
        <QuickLink href="/metrics" label="All metrics" />
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────

function BigTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "ok" | "warn" | "danger";
  href: string;
}) {
  const palette = (() => {
    switch (tone) {
      case "ok":     return { value: "text-emerald-700", iconBg: "bg-emerald-50", iconColor: "text-emerald-700", border: "border-border/70" };
      case "warn":   return { value: "text-amber-800",   iconBg: "bg-amber-50",   iconColor: "text-amber-700",   border: "border-amber-200" };
      case "danger": return { value: "text-red-800",     iconBg: "bg-red-50",     iconColor: "text-red-700",     border: "border-red-200" };
      default:       return { value: "",                 iconBg: "bg-brand-50",   iconColor: "text-brand-700",   border: "border-border/70" };
    }
  })();
  return (
    <Link
      href={href}
      className={`group rounded-xl border bg-surface p-4 hover:shadow-sm transition-all ${palette.border}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className={`h-8 w-8 rounded-md flex items-center justify-center ring-1 ring-inset ${palette.iconBg}`}
        >
          <Icon className={`h-4 w-4 ${palette.iconColor}`} aria-hidden />
        </div>
        <ArrowRight className="h-3.5 w-3.5 text-text-subtle group-hover:text-text-muted transition-colors" />
      </div>
      <div
        className={`text-3xl font-semibold tabular-nums tracking-tight ${palette.value}`}
      >
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-text-subtle mt-0.5 font-semibold">
        {label}
      </div>
      <div className="text-[11px] text-text-muted mt-1.5 leading-snug">
        {hint}
      </div>
    </Link>
  );
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-border/60 bg-surface px-3 py-2 hover:bg-surface-2 hover:border-border transition-colors text-text-muted hover:text-text inline-flex items-center justify-between gap-2"
    >
      <span>{label}</span>
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

// ── Prediction picker ──────────────────────────────────────────────

type Prediction = {
  headline: string;
  detail?: string;
  cta?: { label: string; href: string };
  tone: "default" | "warn" | "danger";
};

function pickPrediction(args: {
  forgottenBags: number;
  agedUnfinalizedBags: number;
  agedUnfinalizedUnits: number;
  predicted: { total: number; predictedExtra: number; dailyAvg7: number };
  finalizedToday: number;
  avg7: number;
}): Prediction {
  // Priority order: forgotten bags > aged unfinalized > behind pace > on track
  if (args.forgottenBags > 0) {
    return {
      headline:
        args.forgottenBags === 1
          ? "1 bag has been paused longer than 30 minutes — likely forgotten."
          : `${args.forgottenBags} bags have been paused longer than 30 minutes — likely forgotten.`,
      detail:
        "Each forgotten bag burns operator handoff cost and shifts your finalize-tonight count down. Sweep the floor.",
      cta: { label: "See forgotten bags", href: "/floor-board" },
      tone: "danger",
    };
  }
  if (args.agedUnfinalizedBags > 0) {
    return {
      headline: `$ tied up: ${args.agedUnfinalizedUnits.toLocaleString()} tablets across ${args.agedUnfinalizedBags} bags older than 30 days.`,
      detail:
        "These bags are sitting on cash. Either finalize them or open a write-down review with the accountant.",
      cta: { label: "List stuck bags", href: "/floor-board" },
      tone: "warn",
    };
  }
  if (args.avg7 > 0 && args.finalizedToday < args.avg7 * 0.7) {
    const gap = Math.round(args.avg7 - args.finalizedToday);
    return {
      headline: `Today's pace is ${Math.round(
        (args.finalizedToday / args.avg7) * 100,
      )}% of 7-day average. ${gap} bags behind.`,
      detail:
        "Pull a packager from sealing, push the bottleneck stage, or accept the slip and adjust commitments.",
      cta: { label: "Open live floor", href: "/floor-board" },
      tone: "warn",
    };
  }
  return {
    headline: `Floor's clean. Predicted ${args.predicted.total.toLocaleString()} bags shippable this week at current pace.`,
    detail:
      args.predicted.dailyAvg7 > 0
        ? `Pace is ~${args.predicted.dailyAvg7}/day. Push tomorrow morning's first hour to add ${Math.max(Math.round(args.predicted.dailyAvg7 * 0.1), 1)} bags by Friday.`
        : "Run the importer + Rebuild read models if you expected metrics here.",
    cta: { label: "See breakdown", href: "/metrics" },
    tone: "default",
  };
}
