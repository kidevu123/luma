// LUMA-UI-REBUILD-1 v3 — Owner home, rebuilt on the standard design system.
//
// Five owner numbers in a stat card grid, the highest-stakes prediction
// surfaced as a tone panel, top finalized flavors in a standard section
// div, quick-links as simple bordered Link divs.
// Per metrics-strategy.md §13.1 every number drives an action; vanity
// metrics are out. Finalized counts/tablets load from ./loaders.ts.

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
import { PageHeader } from "@/components/ui/page-header";
import { requireSession } from "@/lib/auth-guards";
import {
  getFinalizedToday,
  getCashOnFloor,
  getAgedUnfinalized,
  getForgottenBagCount,
  getPredictedShippableThisWeek,
  getTopFlavorsByFinalized,
  getActivityHeartbeat,
  getActiveQrCardCount,
  getActionCenterCounts,
  type ActionCenterCounts,
} from "./loaders";
import { buildWeeklyPredictionDetail } from "./prediction-copy";
import { getFloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot";
import { LUMA_TIMEZONE } from "@/lib/ui/luma-display";

export const dynamic = "force-dynamic";

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
    actionCenter,
    floorSnapshot,
  ] = await Promise.all([
    getFinalizedToday(),
    getCashOnFloor(),
    getAgedUnfinalized(),
    getForgottenBagCount(),
    getPredictedShippableThisWeek(),
    getTopFlavorsByFinalized(),
    getActivityHeartbeat(),
    getActiveQrCardCount(),
    getActionCenterCounts(),
    getFloorManagerSnapshot(LUMA_TIMEZONE),
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

      {/* P4-DASHBOARD · Action Center — every queue that needs a human,
          one glance, one click. Green tiles mean nothing is waiting. */}
      <ActionCenter counts={actionCenter} />

      {/* P4-DASHBOARD · Floor now — which bag is where, who's on it,
          what's blocked, which rolls are mounted. */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-text-subtle">Floor now</p>
            <p className="text-sm font-semibold text-text-strong mt-0.5">
              Which bag is where
            </p>
          </div>
          <Link
            href="/floor-board"
            className="text-[11px] font-medium text-text-muted hover:text-text underline-offset-2 hover:underline shrink-0"
          >
            Full command center →
          </Link>
        </div>
        <div className="px-4 py-3">
          {floorSnapshot.stationCommandRows.length === 0 ? (
            <p className="text-sm text-text-muted py-2">No stations configured.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {floorSnapshot.stationCommandRows.map((s) => {
                const blocked = s.isPaused || s.isOnHold;
                const idle = s.workflowBagId == null;
                return (
                  <div
                    key={s.stationId}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      blocked
                        ? "border-amber-300 bg-amber-50/60"
                        : idle
                          ? "border-border bg-surface-2/40"
                          : "border-emerald-200 bg-emerald-50/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-text-strong truncate">
                        {s.stationLabel}
                      </span>
                      <span
                        className={`inline-flex shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                          blocked
                            ? "border-amber-400 bg-amber-100 text-amber-900"
                            : idle
                              ? "border-border bg-surface text-text-muted"
                              : "border-emerald-300 bg-emerald-100 text-emerald-800"
                        }`}
                      >
                        {s.isOnHold
                          ? "On hold"
                          : s.isPaused
                            ? "Paused"
                            : idle
                              ? "Idle"
                              : (s.stage ?? "Running")}
                      </span>
                    </div>
                    {idle ? (
                      <p className="text-text-muted mt-1">No bag at this station.</p>
                    ) : (
                      <>
                        <p className="mt-1 truncate text-text-strong">
                          {s.bagLabel ?? s.cardLabel ?? s.receiptNumber ?? "—"}
                          {s.productName ? (
                            <span className="text-text-muted"> · {s.productName}</span>
                          ) : null}
                        </p>
                        <p className="text-[10.5px] text-text-muted mt-0.5 truncate">
                          {s.activeOperatorName ?? s.operatorName ?? "no operator"}
                          {s.activeRolls.length > 0
                            ? ` · rolls: ${s.activeRolls
                                .map((r) => r.rollNumber ?? r.materialRole ?? "?")
                                .join(", ")}`
                            : ""}
                        </p>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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

/** P4-DASHBOARD — every actionable queue as a tile: count, tone, and a
 *  direct link. Anyone can answer "what needs a human?" at a glance. */
function ActionCenter({ counts }: { counts: ActionCenterCounts }) {
  const tiles: Array<{
    label: string;
    count: number;
    href: string;
    detail: string;
    tone: "crit" | "warn" | "ok";
  }> = [
    {
      label: "Needs lot review",
      count: counts.needsLotReview,
      // Deep link straight to the queue section so the user lands on
      // the actual list, not the top of the long page. The
      // #output-queue anchor lives on /packaging-output.
      href: "/packaging-output#output-queue",
      detail: "Finalized bags without a finished lot — auto-issue or review.",
      tone: counts.needsLotReview > 0 ? "warn" : "ok",
    },
    {
      label: "Runs missing allocation",
      count: counts.runsMissingAllocation,
      href: "/partial-bags",
      detail: "In-flight runs with no source allocation — lead repair.",
      tone: counts.runsMissingAllocation > 0 ? "crit" : "ok",
    },
    {
      label: "Partials need closeout",
      count: counts.partialsNeedCloseout,
      href: "/partial-bags",
      detail: "Partial bags with no trusted remaining count.",
      tone: counts.partialsNeedCloseout > 0 ? "warn" : "ok",
    },
    {
      label: "Partials ready to reuse",
      count: counts.partialsReady,
      href: "/partial-bags",
      detail: "Trusted remaining quantity — can start a run.",
      tone: "ok",
    },
    {
      label: "Bags on hold",
      count: counts.bagsOnHold,
      href: "/partial-bags",
      detail: "Quarantined raw bags awaiting QA review.",
      tone: counts.bagsOnHold > 0 ? "warn" : "ok",
    },
    {
      label: "Batches blocked",
      count: counts.quarantinedBatches,
      href: "/batches",
      detail: "Input lots in quarantine — release or investigate.",
      tone: counts.quarantinedBatches > 0 ? "warn" : "ok",
    },
    {
      label: "Zoho failed",
      count: counts.zohoFailed,
      href: "/zoho-production-operations",
      detail: "Production-output commits that errored — inspect, never blind-retry.",
      tone: counts.zohoFailed > 0 ? "crit" : "ok",
    },
    {
      label: "Zoho queued / unmapped",
      count: counts.zohoQueued + counts.zohoNeedsMapping,
      href: "/zoho-production-operations",
      detail: `${counts.zohoQueued} queued · ${counts.zohoNeedsMapping} need mapping.`,
      tone: counts.zohoNeedsMapping > 0 ? "warn" : "ok",
    },
  ];
  const anyWork = tiles.some((t) => t.tone !== "ok" && t.count > 0);

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-[10px] uppercase tracking-wider text-text-subtle">Action center</p>
        <p className="text-sm font-semibold text-text-strong mt-0.5">
          {anyWork ? "What needs a human right now" : "All queues clear"}
        </p>
      </div>
      <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className={`rounded-lg border px-3 py-2.5 transition-colors hover:border-brand-300 ${
              tile.count > 0 && tile.tone === "crit"
                ? "border-red-300 bg-red-50/60"
                : tile.count > 0 && tile.tone === "warn"
                  ? "border-amber-300 bg-amber-50/60"
                  : "border-border bg-surface-2/30"
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-text-muted leading-tight">
                {tile.label}
              </span>
              <span
                className={`text-xl font-mono tabular-nums ${
                  tile.count > 0 && tile.tone === "crit"
                    ? "text-red-700"
                    : tile.count > 0 && tile.tone === "warn"
                      ? "text-amber-700"
                      : "text-text-strong"
                }`}
              >
                {tile.count.toLocaleString()}
              </span>
            </div>
            <p className="text-[10px] text-text-subtle mt-1 leading-snug">
              {tile.detail}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

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
  predicted: {
    total: number;
    predictedExtra: number;
    dailyAvg7: number;
    businessDaysRemaining: number;
    weekdayEt: number;
  };
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
        ? buildWeeklyPredictionDetail({
            dailyAvg7: args.predicted.dailyAvg7,
            predictedExtra: args.predicted.predictedExtra,
            businessDaysRemaining: args.predicted.businessDaysRemaining,
            weekdayEt: args.predicted.weekdayEt,
          })
        : "Limited recent finalize data — run the importer and rebuild read models if you expected metrics here.",
    cta: { label: "See breakdown", href: "/metrics" },
    tone: "info",
  };
}
