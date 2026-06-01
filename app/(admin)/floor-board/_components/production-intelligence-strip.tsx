"use client";

import { MetricCard } from "@/components/production/metric-card";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { MetricBundle, MetricResult } from "@/lib/production/types";
import { FloorLiveIndicator } from "./floor-board-ui";

const FALLBACK: MetricResult = {
  value: null,
  unit: null,
  confidence: "MISSING",
  missingInputs: ["metric_api"],
  label: "No data",
};

function pick(bundle: MetricBundle, key: string): MetricResult {
  return bundle[key] ?? FALLBACK;
}

const PRIMARY: Array<{ label: string; key: string }> = [
  { label: "Bags in flow", key: "bagsInFlow" },
  { label: "Finalized today", key: "bagsFinalizedToday" },
  { label: "Units today", key: "goodUnitsToday" },
  { label: "Oldest queue", key: "oldestQueueAgeMinutes" },
  { label: "Paused > 30m", key: "pausedBagsOverThreshold" },
  { label: "Displays", key: "displaysToday" },
  { label: "Cases", key: "casesToday" },
  { label: "Schedule gap", key: "scheduleGap" },
];

const QUEUE_STAGES = [
  { label: "Blister WIP", key: "BLISTER_QUEUE.wip" },
  { label: "Sealing WIP", key: "SEALING_QUEUE.wip" },
  { label: "Packaging WIP", key: "PACKAGING_QUEUE.wip" },
  { label: "Finished WIP", key: "FINISHED_GOODS_QUEUE.wip" },
] as const;

function formatStageKey(metric: MetricResult): string {
  if (metric.confidence === "MISSING") return metric.label ?? "—";
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
      aria-label="Production metrics"
      className="flex-shrink-0 border-t border-white/10 bg-slate-950"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-white/5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Production metrics
        </span>
        <FloorLiveIndicator />
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-px bg-white/5">
        {PRIMARY.map(({ label, key }) => (
          <MetricCard
            key={key}
            label={label}
            metric={pick(dashboard, key)}
            size="sm"
            showConfidence={false}
            className="min-h-[3.75rem] rounded-none border-0"
          />
        ))}
        <MetricCard
          label="Bottleneck"
          metric={bottleneckStage}
          size="sm"
          showConfidence={false}
          className="min-h-[3.75rem] rounded-none border-0 border-l border-cyan-500/20"
          {...(bottleneck.oldestAgeMinutes.value != null
            ? {
                hint: `${bottleneck.oldestAgeMinutes.value}m · ${bottleneck.wip.value ?? 0} WIP`,
              }
            : {})}
        />
      </div>

      <div className="grid grid-cols-4 gap-px bg-white/5 border-t border-white/5">
        {QUEUE_STAGES.map(({ label, key }) => (
          <MetricCard
            key={key}
            label={label}
            metric={queues[key] ?? FALLBACK}
            size="sm"
            showConfidence={false}
            className="min-h-[3.25rem] rounded-none border-0"
          />
        ))}
      </div>
    </section>
  );
}
