// Canonical production metrics for the live floor board. Values come
// from lib/production/metrics.ts via getFloorProductionIntelligence —
// this component only formats.

"use client";

import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { MetricBundle, MetricResult } from "@/lib/production/types";

const FALLBACK: MetricResult = {
  value: null,
  unit: null,
  confidence: "MISSING",
  missingInputs: ["metric_api"],
  label: "No data",
};

function pickMetric(bundle: MetricBundle, key: string): MetricResult {
  return bundle[key] ?? FALLBACK;
}

const PRIMARY: Array<{ label: string; key: string }> = [
  { label: "Bags in flow", key: "bagsInFlow" },
  { label: "Finalized today", key: "bagsFinalizedToday" },
  { label: "Units today", key: "goodUnitsToday" },
  { label: "Displays", key: "displaysToday" },
  { label: "Cases", key: "casesToday" },
  { label: "Oldest queue", key: "oldestQueueAgeMinutes" },
  { label: "Paused > 30m", key: "pausedBagsOverThreshold" },
  { label: "Schedule gap", key: "scheduleGap" },
];

const QUEUE_STAGES = [
  { label: "Blister WIP", key: "BLISTER_QUEUE.wip" },
  { label: "Sealing WIP", key: "SEALING_QUEUE.wip" },
  { label: "Packaging WIP", key: "PACKAGING_QUEUE.wip" },
  { label: "Finished WIP", key: "FINISHED_GOODS_QUEUE.wip" },
] as const;

function formatStageKey(metric: MetricResult): string {
  if (metric.confidence === "MISSING") {
    return metric.label ?? "—";
  }
  const raw = metric.value;
  if (typeof raw !== "string" || !raw) return String(raw ?? "—");
  return raw.replace(/_/g, " ").toLowerCase();
}

export function ProductionIntelligenceStrip({
  data,
}: {
  data: FloorProductionIntelligence;
}) {
  const { dashboard, bottleneck, queues } = data;

  const bottleneckStage: MetricResult =
    bottleneck.stageKey.confidence === "MISSING"
      ? bottleneck.stageKey
      : {
          ...bottleneck.stageKey,
          value: formatStageKey(bottleneck.stageKey),
          unit: null,
        };

  return (
    <section
      aria-label="Production intelligence metrics"
      className="flex-shrink-0 border-t border-cyan-500/25 bg-slate-950/95"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-white/5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-cyan-300/90">
          Production metrics
        </span>
        <span className="text-[10px] text-slate-500 hidden sm:inline">
          lib/production/metrics · refreshes on floor events
        </span>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-px bg-white/5 p-1">
        {PRIMARY.map(({ label, key }) => (
          <MetricCard
            key={key}
            label={label}
            metric={pickMetric(dashboard, key)}
            size="sm"
            className="min-h-[4.5rem]"
          />
        ))}
        <MetricCard
          label="Bottleneck"
          metric={bottleneckStage}
          size="sm"
          className="min-h-[4.5rem] border-cyan-500/20"
          {...(bottleneck.oldestAgeMinutes.value != null
            ? {
                hint: `oldest ${bottleneck.oldestAgeMinutes.value}m · ${bottleneck.wip.value ?? 0} WIP`,
              }
            : {})}
        />
      </div>

      <div className="grid grid-cols-4 gap-px bg-white/5 px-1 pb-1">
        {QUEUE_STAGES.map(({ label, key }) => (
          <MetricCard
            key={key}
            label={label}
            metric={queues[key] ?? FALLBACK}
            size="sm"
            className="min-h-[3.75rem]"
          />
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-slate-500 border-t border-white/5">
        <ConfidenceBadge confidence="HIGH" />
        <span>
          Bottleneck: {formatStageKey(bottleneck.stageKey)}
          {bottleneck.reason.value != null && (
            <> · {String(bottleneck.reason.value)}</>
          )}
        </span>
        {bottleneck.cycleVsStandardPct.confidence === "MISSING" &&
          bottleneck.cycleVsStandardPct.label && (
            <span className="text-slate-600">
              ({bottleneck.cycleVsStandardPct.label})
            </span>
          )}
      </div>
    </section>
  );
}
