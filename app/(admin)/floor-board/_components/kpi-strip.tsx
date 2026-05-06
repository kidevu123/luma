// Dense KPI strip — 12 compact tiles in a horizontal-scrolling row.
// Each tile is small (icon + label + big number + 1-line context).
// Color-coded: red = act now, amber = watch, green = ok, gray =
// neutral. The strip never wraps to multiple rows — overflow scrolls.

import * as React from "react";
import {
  Activity,
  Hourglass,
  PackageCheck,
  Boxes,
  Layers,
  Clock,
  Gauge,
  Pill,
  AlertTriangle,
  Package,
  TrendingUp,
  Wrench,
} from "lucide-react";

type Tone = "default" | "ok" | "warn" | "danger" | "neutral";

export type KpiTileProps = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
};

function CompactTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: KpiTileProps) {
  const palette = (() => {
    switch (tone) {
      case "ok":
        return {
          bg: "bg-emerald-50",
          border: "border-emerald-200/60",
          icon: "text-emerald-700",
          value: "text-emerald-800",
        };
      case "warn":
        return {
          bg: "bg-amber-50",
          border: "border-amber-200",
          icon: "text-amber-700",
          value: "text-amber-800",
        };
      case "danger":
        return {
          bg: "bg-red-50",
          border: "border-red-200",
          icon: "text-red-700",
          value: "text-red-800",
        };
      case "neutral":
        return {
          bg: "bg-surface-2/40",
          border: "border-border/70",
          icon: "text-text-muted",
          value: "text-text-muted",
        };
      default:
        return {
          bg: "bg-brand-50",
          border: "border-border/70",
          icon: "text-brand-700",
          value: "text-text",
        };
    }
  })();
  return (
    <div
      className={`min-w-[140px] flex-shrink-0 rounded-lg border ${palette.border} ${palette.bg} px-2.5 py-2`}
    >
      <div className="flex items-center justify-between gap-1.5 mb-0.5">
        <span className="text-[9px] uppercase tracking-wider text-text-subtle font-semibold leading-none truncate">
          {label}
        </span>
        <Icon
          className={`h-3 w-3 ${palette.icon} shrink-0`}
          aria-hidden
        />
      </div>
      <div
        className={`text-xl font-semibold tabular-nums tracking-tight leading-tight ${palette.value}`}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-text-muted truncate leading-tight">
          {hint}
        </div>
      )}
    </div>
  );
}

function fmtSec(s: number | null): string {
  if (s == null || !isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function KpiStrip(props: {
  finalizedToday: number;
  totalActive: number;
  cycle: { p50: number | null; p90: number | null; avg: number | null; count: number };
  hourlyPace: { thisHour: number; avgPerHour: number };
  stationIdle: { idle: number; total: number };
  idleCards: { idle: number; total: number };
  bagsAvailable: number;
  bagTypes: number;
  forgottenBags: number;
  agedCount: number;
  agedDaysOldMax: number | null;
  materialRunwayDays: number | null;
  oeeProxy: number | null; // 0..1, null if no nameplate
}) {
  const {
    finalizedToday,
    totalActive,
    cycle,
    hourlyPace,
    stationIdle,
    idleCards,
    bagsAvailable,
    bagTypes,
    forgottenBags,
    agedCount,
    agedDaysOldMax,
    materialRunwayDays,
    oeeProxy,
  } = props;

  // p90 vs p50: red when ratio > 2x.
  const cycleRatio =
    cycle.p50 && cycle.p50 > 0 && cycle.p90 ? cycle.p90 / cycle.p50 : 1;
  const cycleP90Tone: Tone =
    cycleRatio >= 2 ? "danger" : cycleRatio >= 1.5 ? "warn" : "ok";

  // Hourly pace: amber when < 0.6x avg, ok when >= avg, neutral when no data.
  const paceRatio =
    hourlyPace.avgPerHour > 0
      ? hourlyPace.thisHour / hourlyPace.avgPerHour
      : null;
  const paceTone: Tone =
    paceRatio === null
      ? "neutral"
      : paceRatio >= 1
        ? "ok"
        : paceRatio >= 0.6
          ? "warn"
          : "danger";

  // Material runway: red when < 3d, amber when < 7d, ok otherwise.
  const runwayTone: Tone =
    materialRunwayDays === null
      ? "neutral"
      : materialRunwayDays < 3
        ? "danger"
        : materialRunwayDays < 7
          ? "warn"
          : "ok";

  // Aged tone: red when something > 30d.
  const agedTone: Tone =
    agedCount === 0
      ? "ok"
      : (agedDaysOldMax ?? 0) >= 30
        ? "danger"
        : "warn";

  const tiles: KpiTileProps[] = [
    {
      icon: PackageCheck,
      label: "Finalized today",
      value: finalizedToday.toLocaleString(),
      hint: `${cycle.count} bags 7d`,
      tone: "ok",
    },
    {
      icon: Activity,
      label: "In flight",
      value: totalActive.toLocaleString(),
      hint: "unfinalized bags",
    },
    {
      icon: Clock,
      label: "Avg cycle 7d",
      value: fmtSec(cycle.avg),
      hint: cycle.count > 0 ? `${cycle.count} bags` : "no signal",
    },
    {
      icon: TrendingUp,
      label: "P90 cycle 7d",
      value: fmtSec(cycle.p90),
      hint:
        cycle.p50 && cycle.p90
          ? `${cycleRatio.toFixed(1)}× p50`
          : "no signal",
      tone: cycleP90Tone,
    },
    {
      icon: Gauge,
      label: "OEE proxy",
      value:
        oeeProxy === null
          ? "—"
          : `${Math.round(oeeProxy * 100)}%`,
      hint:
        oeeProxy === null
          ? "no nameplate set"
          : `${Math.round(oeeProxy * 100)}% of capacity`,
      tone:
        oeeProxy === null
          ? "neutral"
          : oeeProxy >= 0.7
            ? "ok"
            : oeeProxy >= 0.4
              ? "warn"
              : "danger",
    },
    {
      icon: Wrench,
      label: "Idle stations",
      value: `${stationIdle.idle}/${stationIdle.total}`,
      hint: `${stationIdle.total - stationIdle.idle} active in last 5m`,
      tone:
        stationIdle.total === 0
          ? "neutral"
          : stationIdle.idle / stationIdle.total >= 0.7
            ? "warn"
            : "ok",
    },
    {
      icon: Layers,
      label: "Idle cards",
      value: `${idleCards.idle}/${idleCards.total}`,
      hint: idleCards.total === 0 ? "no QR cards yet" : "idle / total",
    },
    {
      icon: Pill,
      label: "Bags available",
      value: bagsAvailable.toLocaleString(),
      hint: `${bagTypes} types`,
    },
    {
      icon: Package,
      label: "Material runway",
      value:
        materialRunwayDays === null
          ? "—"
          : `${materialRunwayDays.toFixed(1)}d`,
      hint:
        materialRunwayDays === null
          ? "no burn data yet"
          : "min across materials",
      tone: runwayTone,
    },
    {
      icon: Hourglass,
      label: "Forgotten bags",
      value: forgottenBags.toLocaleString(),
      hint:
        forgottenBags === 0
          ? "no paused > 30m"
          : "paused > 30 min",
      tone: forgottenBags > 0 ? "danger" : "ok",
    },
    {
      icon: AlertTriangle,
      label: "Aged unfinalized",
      value: agedCount.toLocaleString(),
      hint:
        agedCount === 0
          ? "all fresh"
          : agedDaysOldMax
            ? `oldest ${agedDaysOldMax}d`
            : "—",
      tone: agedTone,
    },
    {
      icon: Boxes,
      label: "Pace this hour",
      value: hourlyPace.thisHour.toLocaleString(),
      hint:
        hourlyPace.avgPerHour > 0
          ? `${hourlyPace.thisHour} / ${hourlyPace.avgPerHour.toFixed(1)} avg`
          : "no day-avg yet",
      tone: paceTone,
    },
  ];

  return (
    <div className="-mx-4 sm:mx-0 px-4 sm:px-0 overflow-x-auto">
      <div className="flex gap-2 min-w-max sm:grid sm:grid-cols-6 lg:grid-cols-12 sm:min-w-0">
        {tiles.map((t, i) => (
          <CompactTile key={i} {...t} />
        ))}
      </div>
    </div>
  );
}
