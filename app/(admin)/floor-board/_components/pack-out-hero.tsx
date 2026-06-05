"use client";

import { MetricCard } from "@/components/production/metric-card";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { MetricResult } from "@/lib/production/types";
import {
  formatCycleSec,
  trustedCycleSec,
} from "@/lib/floor-command/floor-display";
import type { FloorLiveStatus } from "@/app/(admin)/floor-board/_hooks/use-floor-live-refresh";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

const FALLBACK: MetricResult = {
  value: null,
  unit: null,
  confidence: "MISSING",
  missingInputs: [],
  label: "Insufficient data",
};

function pick(bundle: Record<string, MetricResult | undefined>, key: string): MetricResult {
  return bundle[key] ?? FALLBACK;
}

function sumProducts(
  products: FloorManagerSnapshot["products"],
  field: "displaysMade" | "casesMade",
): number {
  return products.reduce((sum, p) => sum + (p[field] ?? 0), 0);
}

function formatBottleneck(intelligence: FloorProductionIntelligence): MetricResult {
  const { bottleneck } = intelligence;
  const stage = bottleneck.stageKey;
  if (stage.confidence === "MISSING" || typeof stage.value !== "string") {
    return FALLBACK;
  }
  const age = bottleneck.oldestAgeMinutes;
  const wip = bottleneck.wip;
  const label = stage.value.replace(/_/g, " ").toLowerCase();
  const hint =
    age.confidence !== "MISSING" && age.value != null
      ? `${age.value}m oldest · ${wip.value ?? 0} WIP`
      : undefined;
  return {
    value: label,
    unit: null,
    confidence: "HIGH",
    missingInputs: [],
    label: hint ?? label,
  };
}

type Props = {
  intelligence: FloorProductionIntelligence;
  snapshot: FloorManagerSnapshot;
  kpiData: KpiStripData;
  liveStatus?: FloorLiveStatus;
  lastUpdatedAt?: number | null;
};

/** Legacy top-row density: bags, units, displays, cases, cycle, bottleneck. */
export function PackOutHero({
  intelligence,
  snapshot,
  kpiData,
  liveStatus = "live",
  lastUpdatedAt = null,
}: Props) {
  const { dashboard } = intelligence;
  const { plant, products } = snapshot;
  const flashRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastUpdatedAt == null || !flashRef.current) return;
    const el = flashRef.current;
    el.classList.add("opacity-60");
    const t = setTimeout(() => el.classList.remove("opacity-60"), 180);
    return () => clearTimeout(t);
  }, [lastUpdatedAt]);

  const bagsMetric = pick(dashboard, "bagsFinalizedToday");
  const bagsFallback =
    bagsMetric.confidence === "MISSING" && plant.bagsFinalizedShift > 0
      ? {
          value: plant.bagsFinalizedShift,
          unit: "bags",
          confidence: "MEDIUM" as const,
          missingInputs: [],
          label: "from shift snapshot",
        }
      : bagsMetric.confidence === "MISSING" && kpiData.bagsToday > 0
        ? {
            value: kpiData.bagsToday,
            unit: "bags",
            confidence: "MEDIUM" as const,
            missingInputs: [],
            label: "from throughput",
          }
        : bagsMetric;

  const unitsMetric = pick(dashboard, "goodUnitsToday");
  const unitsFallback =
    unitsMetric.confidence === "MISSING" && plant.unitsYieldedShift > 0
      ? {
          value: plant.unitsYieldedShift,
          unit: "units",
          confidence: "MEDIUM" as const,
          missingInputs: [],
          label: "from shift snapshot",
        }
      : unitsMetric.confidence === "MISSING" && kpiData.unitsOut > 0
        ? {
            value: kpiData.unitsOut,
            unit: "units",
            confidence: "MEDIUM" as const,
            missingInputs: [],
            label: "from throughput",
          }
        : unitsMetric;

  const displaysMetric = pick(dashboard, "displaysToday");
  const displaysFallback =
    displaysMetric.confidence === "MISSING"
      ? {
          value: sumProducts(products, "displaysMade") || null,
          unit: "displays",
          confidence: sumProducts(products, "displaysMade") > 0 ? ("MEDIUM" as const) : ("MISSING" as const),
          missingInputs: [],
          label: sumProducts(products, "displaysMade") > 0 ? "from finalized bags" : "Insufficient data",
        }
      : displaysMetric;

  const casesMetric = pick(dashboard, "casesToday");
  const casesFallback =
    casesMetric.confidence === "MISSING"
      ? {
          value: sumProducts(products, "casesMade") || null,
          unit: "cases",
          confidence: sumProducts(products, "casesMade") > 0 ? ("MEDIUM" as const) : ("MISSING" as const),
          missingInputs: [],
          label: sumProducts(products, "casesMade") > 0 ? "from finalized bags" : "Insufficient data",
        }
      : casesMetric;

  const avgCycle = trustedCycleSec(plant.avgCycleSecShift) ?? trustedCycleSec(kpiData.avgCycleSeconds);
  const cycleMetric: MetricResult = avgCycle != null
    ? {
        value: formatCycleSec(avgCycle),
        unit: null,
        confidence: "HIGH",
        missingInputs: [],
        label: `${plant.bagsFinalizedShift} finalized this shift`,
      }
    : FALLBACK;

  const bottleneckMetric = formatBottleneck(intelligence);

  return (
    <div
      ref={flashRef}
      className={cn(
        "shrink-0 border-b border-white/[0.06] bg-[#0a0d12] transition-opacity duration-150",
        liveStatus === "stale" && "border-t-2 border-t-red-500/60",
      )}
    >
      {liveStatus === "stale" && (
        <p className="px-3 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-400/90">
          Data stale — refresh or check connection
        </p>
      )}
      <div className="grid grid-cols-3 gap-px bg-white/[0.04] sm:grid-cols-6">
        <MetricCard label="Bags completed" metric={bagsFallback} size="sm" showConfidence={false} className="min-h-[3.5rem] rounded-none border-0" />
        <MetricCard label="Units out" metric={unitsFallback} size="sm" showConfidence={false} className="min-h-[3.5rem] rounded-none border-0" />
        <MetricCard label="Displays" metric={displaysFallback} size="sm" showConfidence={false} className="min-h-[3.5rem] rounded-none border-0" />
        <MetricCard label="Cases" metric={casesFallback} size="sm" showConfidence={false} className="min-h-[3.5rem] rounded-none border-0" />
        <MetricCard label="Avg cycle" metric={cycleMetric} size="sm" showConfidence={false} className="min-h-[3.5rem] rounded-none border-0" />
        <MetricCard
          label="Bottleneck"
          metric={bottleneckMetric}
          size="sm"
          showConfidence={false}
          className="min-h-[3.5rem] rounded-none border-0 border-l border-cyan-500/20"
        />
      </div>
    </div>
  );
}
