// Phase D — honest KPI strip. Reads exclusively from the production
// intelligence API (lib/production/metrics.ts). UI never recomputes.
//
// Lives alongside the legacy 12-tile strip until the rest of the
// floor-board is wired through the metric API in a future pass.
// The two strips are intentionally side-by-side so the operations
// lead can compare what the canonical layer reports vs what the
// existing ad-hoc queries report — divergences are signal.

import {
  deriveDashboardMetrics,
  deriveBottleneck,
  deriveQueueAging,
} from "@/lib/production/metrics";
import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";

export async function HonestKpiStrip() {
  const [dashboard, bottleneck, queues] = await Promise.all([
    deriveDashboardMetrics(),
    deriveBottleneck(),
    deriveQueueAging(),
  ]);

  // Pull a couple of representative queue rows for the bottom strip.
  // The full queue map renders elsewhere; here we surface the worst.
  const blisterWip = queues["BLISTER_QUEUE.wip"];
  const sealingWip = queues["SEALING_QUEUE.wip"];
  const packagingWip = queues["PACKAGING_QUEUE.wip"];
  const finishedWip = queues["FINISHED_GOODS_QUEUE.wip"];

  return (
    <section
      aria-label="Production intelligence KPI strip"
      className="rounded-md border border-cyan-500/30 bg-slate-950/60 p-3 space-y-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[10px] uppercase tracking-[0.10em] text-cyan-300">
          Production intelligence
        </h2>
        <span className="text-[10px] text-slate-500">
          via lib/production/metrics.ts
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <MetricCard
          label="Bags in flow"
          metric={dashboard.bagsInFlow ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Good units today"
          metric={dashboard.goodUnitsToday ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Displays today"
          metric={dashboard.displaysToday ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Cases today"
          metric={dashboard.casesToday ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Oldest queue age"
          metric={dashboard.oldestQueueAgeMinutes ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Paused > 30m"
          metric={dashboard.pausedBagsOverThreshold ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Bottleneck stage"
          metric={bottleneck.stageKey}
          size="sm"
        />
        <MetricCard
          label="Schedule gap"
          metric={dashboard.scheduleGap ?? FALLBACK}
          size="sm"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MetricCard
          label="Blister queue WIP"
          metric={blisterWip ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Sealing queue WIP"
          metric={sealingWip ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Packaging queue WIP"
          metric={packagingWip ?? FALLBACK}
          size="sm"
        />
        <MetricCard
          label="Finished goods WIP"
          metric={finishedWip ?? FALLBACK}
          size="sm"
        />
      </div>

      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <ConfidenceBadge confidence="HIGH" />
        Bottleneck: {String(bottleneck.stageKey.value ?? bottleneck.stageKey.label ?? "—")}
        {bottleneck.oldestAgeMinutes.value != null && (
          <> · oldest {String(bottleneck.oldestAgeMinutes.value)}m</>
        )}
        {bottleneck.cycleVsStandardPct.confidence === "MISSING" && (
          <span className="ml-2 text-slate-600">
            ({bottleneck.cycleVsStandardPct.label})
          </span>
        )}
      </div>
    </section>
  );
}

const FALLBACK = {
  value: null,
  unit: null,
  confidence: "MISSING" as const,
  missingInputs: ["metric_api"],
  label: "No data",
};
