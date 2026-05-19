// LUMA-UI-REBUILD-1 v3 — Owner home, rebuilt on the standard design system.
//
// Five owner numbers in a stat card grid, the highest-stakes prediction
// surfaced as a tone panel, top finalized flavors in a standard section
// div, quick-links as simple bordered Link divs.
// Per metrics-strategy.md §13.1 every number drives an action; vanity
// metrics are out. Data loading logic unchanged from the prior page.

import Link from "next/link";
import {
  ArrowRight,
  AlertTriangle,
  PackageCheck,
  Wallet,
  Hourglass,
  Gauge,
  TrendingUp,
  Sparkles,
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

// ── Loaders (unchanged) ───────────────────────────────────────────

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
  const stages = [
    { label: "Received",      units: received?.units    ?? 0, bags: received?.bags    ?? 0 },
    { label: "In production", units: unfinalized?.units ?? 0, bags: unfinalized?.bags ?? 0 },
    { label: "In use",        units: inUse?.units       ?? 0, bags: inUse?.bags       ?? 0 },
  ];
  stages.sort((a, b) => b.units - a.units);
  return { totalUnits: total, biggest: stages[0] };
}

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

async function getPredictedShippableThisWeek() {
  const now = new Date();
  const dow = now.getDay();
  const daysSinceMon = (dow + 6) % 7;
  const mondayMs = now.getTime() - daysSinceMon * 24 * 60 * 60 * 1000;
  const mondayStr = new Date(mondayMs).toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);
  const [thisWeek] = await db
    .select({
      n: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
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

async function getTopFlavorsByFinalized() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      tabletName:    tabletTypes.name,
      productName:   products.name,
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

async function getActivityHeartbeat() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(workflowEvents)
    .where(gte(workflowEvents.occurredAt, since));
  return r?.n ?? 0;
}

async function getActiveQrCardCount() {
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(qrCards)
    .where(eq(qrCards.status, "ASSIGNED"));
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
    activeCards,
  ] = await Promise.all([
    getFinalizedToday(),
    getCashOnFloor(),
    getAgedUnfinalized(),
    getForgottenBagCount(),
    getPredictedShippableThisWeek(),
    getTopFlavorsByFinalized(),
    getActivityHeartbeat(),
    getActiveQrCardCount(),
  ]);

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

  const finalizedHint =
    finalized.avg7 === 0
      ? "no 7-day baseline yet"
      : `${finalizedDelta >= 0 ? "+" : ""}${Math.round(finalizedPctDelta)}% vs 7-day avg (${Math.round(finalized.avg7)})`;

  const cashHint =
    cash.biggest && cash.biggest.units > 0
      ? `${cash.biggest.label} holds ${cash.biggest.bags} bags · ${cash.biggest.units.toLocaleString()} tablets`
      : "no inventory tracked";

  const activityHint = `${forgotten} forgotten bag${forgotten === 1 ? "" : "s"} right now`;

  const predictedHint =
    predicted.dailyAvg7 > 0
      ? `~${predicted.dailyAvg7}/day · ${predicted.thisWeekSoFar} so far`
      : "no recent throughput";

  const agedHint =
    aged.count === 0
      ? "all inventory fresh"
      : `${aged.units.toLocaleString()} tablets sitting`;

  const PanelIcon = prediction.tone === "crit" ? AlertTriangle : Sparkles;

  const panelClass =
    prediction.tone === "crit"
      ? "rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 text-[12px] text-red-800 flex items-start gap-2.5"
      : prediction.tone === "warn"
        ? "rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] text-amber-800 flex items-start gap-2.5"
        : "rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-[12px] text-sky-800 flex items-start gap-2.5";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Today, at a glance."
        description="Five numbers that matter. One prediction worth acting on. Everything else is a click away."
      />

      {/* Badge strip */}
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center h-6 px-2.5 rounded-md border border-border bg-surface-2/60 text-[11px] font-mono text-text-muted">
          {eventsLast24h.toLocaleString()} events 24h
        </span>
        <span className="inline-flex items-center h-6 px-2.5 rounded-md border border-border bg-surface-2/60 text-[11px] font-mono text-text-muted">
          {activeCards} active QR cards
        </span>
        {forgotten > 0 && (
          <span className="inline-flex items-center h-6 px-2.5 rounded-md border border-red-200 bg-red-50 text-[11px] font-mono text-red-700">
            {forgotten} forgotten bag{forgotten === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* Five owner numbers — stat card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <PackageCheck className="h-3.5 w-3.5 text-text-subtle" />
            <span className="text-[10px] uppercase tracking-wider text-text-subtle">Finalized today</span>
          </div>
          <div className="text-2xl font-mono tabular-nums text-text-strong">
            {finalized.todayN.toLocaleString()}
          </div>
          <div className="text-[11px] text-text-subtle mt-1">{finalizedHint}</div>
        </div>

        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Wallet className="h-3.5 w-3.5 text-text-subtle" />
            <span className="text-[10px] uppercase tracking-wider text-text-subtle">Tablets on the floor</span>
          </div>
          <div className="text-2xl font-mono tabular-nums text-text-strong">
            {cash.totalUnits.toLocaleString()}
          </div>
          <div className="text-[11px] text-text-subtle mt-1">{cashHint}</div>
        </div>

        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Gauge className="h-3.5 w-3.5 text-text-subtle" />
            <span className="text-[10px] uppercase tracking-wider text-text-subtle">Activity (24h)</span>
          </div>
          <div className="text-2xl font-mono tabular-nums text-text-strong">
            {eventsLast24h.toLocaleString()}
          </div>
          <div className="text-[11px] text-text-subtle mt-1">{activityHint}</div>
        </div>

        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp className="h-3.5 w-3.5 text-text-subtle" />
            <span className="text-[10px] uppercase tracking-wider text-text-subtle">Predicted this week</span>
          </div>
          <div className="text-2xl font-mono tabular-nums text-text-strong">
            {predicted.total.toLocaleString()}
          </div>
          <div className="text-[11px] text-text-subtle mt-1">{predictedHint}</div>
        </div>

        <div className="rounded-xl border border-border bg-surface px-4 py-3 col-span-2 sm:col-span-4">
          <div className="flex items-center gap-1.5 mb-1">
            <Hourglass className="h-3.5 w-3.5 text-text-subtle" />
            <span className="text-[10px] uppercase tracking-wider text-text-subtle">Aged &gt; 30 days</span>
          </div>
          <div className="text-2xl font-mono tabular-nums text-text-strong">
            {aged.count.toLocaleString()}
          </div>
          <div className="text-[11px] text-text-subtle mt-1">{agedHint}</div>
        </div>
      </div>

      {/* Prediction panel */}
      <div className={panelClass}>
        <PanelIcon className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-[12px]">{prediction.headline}</p>
          {prediction.detail ? (
            <p className="mt-1 text-[12px]">{prediction.detail}</p>
          ) : null}
          {prediction.cta ? (
            <Link
              href={prediction.cta.href}
              className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold underline-offset-2 hover:underline"
            >
              {prediction.cta.label} <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
      </div>

      {/* Top finalized flavors */}
      {topFlavors.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-text-subtle">
                Top flavors finalized · last 30 days
              </p>
              <p className="text-sm font-semibold text-text-strong mt-0.5">
                Where the throughput went
              </p>
              <p className="text-[12px] text-text-muted mt-0.5">
                The three SKUs with the most finalized bags. Use these to spot which lines are pulling weight.
              </p>
            </div>
            <Link
              href="/metrics"
              className="text-[11px] font-medium text-text-muted hover:text-text underline-offset-2 hover:underline shrink-0"
            >
              All metrics →
            </Link>
          </div>
          <div className="px-4 py-4">
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {topFlavors.map((f, i) => (
                <li
                  key={(f.tabletName ?? "") + (f.productName ?? "") + i}
                  className="rounded-xl border border-border bg-surface px-4 py-3.5 flex flex-col gap-1.5"
                >
                  <div className="text-[12px] font-semibold tracking-tight text-text-strong truncate">
                    {f.productName ?? f.tabletName ?? "—"}
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-mono tabular-nums text-text-strong">
                      {f.bagsFinalized.toLocaleString()}
                    </span>
                    <span className="text-[11px] text-text-muted">bags</span>
                  </div>
                  <div className="text-[11px] text-text-subtle font-mono tabular-nums">
                    {f.unitsFinalized.toLocaleString()} tablets
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* Quick-access strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <QuickLink href="/floor-board" label="Live floor" eyebrow="Operations" />
        <QuickLink href="/inbound" label="POs & receiving" eyebrow="Logistics" />
        <QuickLink href="/batches" label="Batches" eyebrow="Production" />
        <QuickLink href="/metrics" label="All metrics" eyebrow="Reports" />
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────

function QuickLink({
  href,
  label,
  eyebrow,
}: {
  href: string;
  label: string;
  eyebrow: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-border bg-surface px-4 py-3.5 group flex flex-col gap-1 hover:border-brand-300 transition-colors"
    >
      <div className="text-[10px] uppercase tracking-wider text-text-subtle">
        {eyebrow}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13.5px] font-semibold tracking-tight text-text-strong">
          {label}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-text-subtle group-hover:text-brand-800 transition-colors" />
      </div>
    </Link>
  );
}

// ── Prediction picker (unchanged) ─────────────────────────────────

type Tone = "crit" | "warn" | "info" | "good";

type Prediction = {
  headline: string;
  detail?: string;
  cta?: { label: string; href: string };
  tone: Tone;
};

function pickPrediction(args: {
  forgottenBags: number;
  agedUnfinalizedBags: number;
  agedUnfinalizedUnits: number;
  predicted: { total: number; predictedExtra: number; dailyAvg7: number };
  finalizedToday: number;
  avg7: number;
}): Prediction {
  if (args.forgottenBags > 0) {
    return {
      headline:
        args.forgottenBags === 1
          ? "1 bag has been paused longer than 30 minutes — likely forgotten."
          : `${args.forgottenBags} bags have been paused longer than 30 minutes — likely forgotten.`,
      detail:
        "Each forgotten bag burns operator handoff cost and shifts your finalize-tonight count down. Sweep the floor.",
      cta: { label: "See forgotten bags", href: "/floor-board" },
      tone: "crit",
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
    tone: "info",
  };
}
