"use client";

import { MetricCard } from "@/components/production/metric-card";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { MetricResult } from "@/lib/production/types";

const FALLBACK: MetricResult = {
  value: null,
  unit: null,
  confidence: "MISSING",
  missingInputs: [],
  label: "—",
};

function pick(bundle: Record<string, MetricResult | undefined>, key: string): MetricResult {
  return bundle[key] ?? FALLBACK;
}

const STAGES = [
  { label: "Blister WIP", wipKey: "BLISTER_QUEUE.wip", ageKey: "BLISTER_QUEUE.oldestAgeMinutes" },
  { label: "Sealing WIP", wipKey: "SEALING_QUEUE.wip", ageKey: "SEALING_QUEUE.oldestAgeMinutes" },
  { label: "Packaging WIP", wipKey: "PACKAGING_QUEUE.wip", ageKey: "PACKAGING_QUEUE.oldestAgeMinutes" },
  { label: "Finished WIP", wipKey: "FINISHED_GOODS_QUEUE.wip", ageKey: "FINISHED_GOODS_QUEUE.oldestAgeMinutes" },
] as const;

type Props = {
  intelligence: FloorProductionIntelligence;
  onSelect?: () => void;
};

/** Compact queue depth row — legacy "out of packaging" visibility. */
export function QueueWipRail({ intelligence, onSelect }: Props) {
  const { queues } = intelligence;

  return (
    <div className="grid grid-cols-4 gap-px border-t border-white/[0.04] bg-white/[0.04]">
      {STAGES.map(({ label, wipKey, ageKey }) => {
        const wip = pick(queues, wipKey);
        const age = pick(queues, ageKey);
        const hint =
          age.confidence !== "MISSING" && age.value != null
            ? `oldest ${age.value}m`
            : undefined;
        return (
          <button
            key={wipKey}
            type="button"
            onClick={onSelect}
            className="text-left hover:bg-white/[0.03] transition-colors"
          >
            <MetricCard
              label={label}
              metric={wip}
              size="sm"
              showConfidence={false}
              className="min-h-[2.75rem] rounded-none border-0 pointer-events-none"
              {...(hint ? { hint } : {})}
            />
          </button>
        );
      })}
    </div>
  );
}
