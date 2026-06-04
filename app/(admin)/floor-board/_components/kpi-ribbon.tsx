"use client";

import { SparkBars } from "@/components/charts/inline-charts";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { ThroughputDataPoint } from "@/lib/floor-command/types";
import {
  formatCycleSec,
  trustedCycleSec,
} from "@/lib/floor-command/floor-display";

function formatRunway(days: number | null): string {
  if (days == null) return "—";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${days.toFixed(1)}d`;
}

type CardProps = {
  label: string;
  value: string;
  sub?: string;
  accent?: "good" | "warn" | "crit" | "neutral";
  spark?: number[];
};

function KpiCard({
  label,
  value,
  sub,
  accent = "neutral",
  spark,
}: CardProps) {
  const accentBorder =
    accent === "good"
      ? "border-emerald-500/30"
      : accent === "warn"
        ? "border-amber-500/30"
        : accent === "crit"
          ? "border-red-500/30"
          : "border-white/[0.08]";
  return (
    <div
      className={`rounded-lg border ${accentBorder} bg-slate-900/60 px-3 py-2.5 min-w-[120px] flex-1`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div>
          <div className="text-xl font-semibold tabular-nums text-slate-50 leading-none">
            {value}
          </div>
          {sub && (
            <div className="text-[10px] text-slate-500 mt-1 leading-snug">{sub}</div>
          )}
        </div>
        {spark && spark.length > 0 && (
          <SparkBars data={spark} height={28} color="#34d399" />
        )}
      </div>
    </div>
  );
}

type Props = {
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  plant: FloorManagerSnapshot["plant"];
  throughputPoints: ThroughputDataPoint[];
};

export function KpiRibbon({ shiftStatus, kpiData, plant, throughputPoints }: Props) {
  const spark = throughputPoints.map((p) => p.bagsPerHour);
  const target = shiftStatus.target;
  const outputAccent =
    target.level === "crit"
      ? "crit"
      : target.level === "warn"
        ? "warn"
        : target.level === "good"
          ? "good"
          : "neutral";

  const avgCycle =
    trustedCycleSec(plant.avgCycleSecShift) ??
    trustedCycleSec(kpiData.avgCycleSeconds);
  const cycleSub =
    plant.avgCycleSecShift != null &&
    plant.avgCycleSecShift > 8 * 3600 &&
    avgCycle == null
      ? "skewed by stuck bag — see pulse"
      : "finalized bags this shift";

  const outputValue =
    kpiData.unitsOut > 0
      ? `${kpiData.unitsOut.toLocaleString()} units`
      : kpiData.bagsToday > 0
        ? `${kpiData.bagsToday} bags`
        : target.value;

  return (
    <div
      className="flex gap-2 px-3 py-2 overflow-x-auto border-b border-white/[0.06] bg-[#0b0e14]/95 shrink-0"
      aria-label="Shift KPIs"
    >
      <KpiCard
        label="Output today"
        value={outputValue}
        {...(target.detail ? { sub: target.detail } : {})}
        accent={outputAccent}
        {...(spark.length >= 2 ? { spark } : {})}
      />
      <KpiCard
        label="WIP bags"
        value={String(plant.bagsInFlow)}
        sub={`${plant.bagsFinalizedShift} finalized this shift`}
        accent={plant.bagsInFlow > 12 ? "warn" : "neutral"}
      />
      <KpiCard
        label="Avg cycle"
        value={avgCycle != null ? formatCycleSec(avgCycle) : "—"}
        sub={cycleSub}
        accent="neutral"
      />
      <KpiCard
        label="First-pass yield"
        value={
          kpiData.firstPassYieldPct != null
            ? `${kpiData.firstPassYieldPct}%`
            : "—"
        }
        {...(shiftStatus.quality.detail
          ? { sub: shiftStatus.quality.detail }
          : {})}
        accent={
          kpiData.firstPassYieldPct != null && kpiData.firstPassYieldPct < 95
            ? "warn"
            : "good"
        }
      />
      <KpiCard
        label="Pause today"
        value={
          plant.pauseMinutesToday > 0
            ? `${plant.pauseMinutesToday}m`
            : "0m"
        }
        sub={
          plant.pauseCostUsdToday > 0
            ? `~$${Math.round(plant.pauseCostUsdToday)} est.`
            : "no pauses"
        }
        accent={plant.pauseMinutesToday > 30 ? "warn" : "neutral"}
      />
      <KpiCard
        label="Material runway"
        value={formatRunway(plant.materialRunwayDays)}
        sub="PVC/foil at burn rate"
        accent={
          plant.materialRunwayDays != null && plant.materialRunwayDays < 3
            ? "crit"
            : plant.materialRunwayDays != null && plant.materialRunwayDays < 7
              ? "warn"
              : "neutral"
        }
      />
    </div>
  );
}
