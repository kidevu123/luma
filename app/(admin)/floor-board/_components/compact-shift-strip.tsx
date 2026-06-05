"use client";

import type { ShiftActivityMetrics } from "@/lib/production/shift-throughput";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import { formatWait } from "@/lib/floor-command/floor-display";
import { cn } from "@/lib/utils";

function Cell({
  label,
  value,
  sub,
  accent = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "good" | "warn" | "crit" | "neutral" | "live";
}) {
  const valueClass =
    accent === "live"
      ? "text-emerald-300"
      : accent === "warn"
        ? "text-amber-300"
        : accent === "crit"
          ? "text-red-300"
          : accent === "good"
            ? "text-sky-300"
            : "text-slate-100";

  return (
    <div className="min-w-[72px] flex-1 px-2 py-1">
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500 truncate">
        {label}
      </div>
      <div className={cn("text-lg font-bold tabular-nums leading-tight", valueClass)}>
        {value}
      </div>
      {sub && (
        <div className="text-[9px] text-slate-600 truncate leading-tight">{sub}</div>
      )}
    </div>
  );
}

type Props = {
  activity: ShiftActivityMetrics;
  snapshot: FloorManagerSnapshot;
  intelligence: FloorProductionIntelligence;
};

/** One dense strip — shift activity from live events, not empty throughput rollups. */
export function CompactShiftStrip({
  activity,
  snapshot,
  intelligence,
}: Props) {
  const { plant } = snapshot;
  const oldestRaw = intelligence.bottleneck.oldestAgeMinutes.value;
  const oldestMin =
    typeof oldestRaw === "number" ? oldestRaw : Number(oldestRaw) || null;
  const bottleneck =
    intelligence.bottleneck.stageKey.confidence !== "MISSING" &&
    typeof intelligence.bottleneck.stageKey.value === "string"
      ? intelligence.bottleneck.stageKey.value.replace(/_/g, " ").toLowerCase()
      : null;

  const worstWip = [...snapshot.wipByStage].sort(
    (a, b) => b.oldestMinutes - a.oldestMinutes,
  )[0];

  const hasStageActivity =
    activity.blisteredShift > 0 ||
    activity.sealedShift > 0 ||
    activity.packagedShift > 0;

  return (
    <div
      className="shrink-0 border-b border-white/[0.06] bg-[#0a0d12]"
      aria-label="Shift activity"
    >
      <div className="flex divide-x divide-white/[0.06] overflow-x-auto">
        <Cell
          label="In flow"
          value={String(activity.bagsInFlow)}
          sub={`${activity.atStation} at station`}
          accent="live"
        />
        <Cell
          label="Blistered"
          value={String(activity.blisteredShift)}
          sub="shift completions"
          accent={activity.blisteredShift > 0 ? "good" : "neutral"}
        />
        <Cell
          label="Sealed"
          value={String(activity.sealedShift)}
          sub="shift completions"
          accent={activity.sealedShift > 0 ? "good" : "neutral"}
        />
        <Cell
          label="Packaged"
          value={String(activity.packagedShift)}
          sub="shift completions"
          accent={activity.packagedShift > 0 ? "good" : "neutral"}
        />
        <Cell
          label="Finalized"
          value={
            activity.unitsFinalizedShift > 0
              ? `${activity.unitsFinalizedShift.toLocaleString()} u`
              : String(activity.finalizedShift)
          }
          sub={
            activity.finalizedShift > 0
              ? `${activity.finalizedShift} bag${activity.finalizedShift === 1 ? "" : "s"} · ${activity.displaysShift} disp`
              : hasStageActivity
                ? "in progress — not finalized yet"
                : "no completions this shift"
          }
          accent={activity.finalizedShift > 0 ? "good" : hasStageActivity ? "warn" : "neutral"}
        />
        <Cell
          label="Cases"
          value={String(activity.casesShift)}
          sub="from finalized"
        />
        <Cell
          label="Bottleneck"
          value={bottleneck ?? "—"}
          {...(oldestMin != null && typeof oldestMin === "number"
            ? { sub: `oldest ${formatWait(oldestMin)}` }
            : worstWip
              ? { sub: `${worstWip.count} @ ${worstWip.label}` }
              : {})}
          accent={
            oldestMin != null && oldestMin > 120
              ? "crit"
              : oldestMin != null && oldestMin > 60
                ? "warn"
                : "neutral"
          }
        />
        <Cell
          label="Pause"
          value={plant.pauseMinutesToday > 0 ? `${plant.pauseMinutesToday}m` : "0"}
          sub={
            plant.materialRunwayDays != null && plant.materialRunwayDays < 1
              ? `runway ${Math.round(plant.materialRunwayDays * 24)}h`
              : "shift"
          }
          accent={plant.pauseMinutesToday > 30 ? "warn" : "neutral"}
        />
      </div>
    </div>
  );
}
