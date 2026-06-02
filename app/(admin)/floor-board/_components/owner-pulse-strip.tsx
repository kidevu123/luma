import Link from "next/link";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";

export function OwnerPulseStrip({
  snapshot,
  emphasized = false,
}: {
  snapshot: FloorManagerSnapshot;
  emphasized?: boolean;
}) {
  const { plant } = snapshot;

  const cells: Array<{
    label: string;
    value: string;
    sub?: string;
    warn?: boolean;
  }> = [
    {
      label: "WIP bags",
      value: String(plant.bagsInFlow),
    },
    {
      label: "Finalized shift",
      value: String(plant.bagsFinalizedShift),
    },
    {
      label: "Units shift",
      value: plant.unitsYieldedShift.toLocaleString(),
    },
    {
      label: "Pause today",
      value: `${plant.pauseMinutesToday}m`,
      sub: `~$${plant.pauseCostUsdToday}`,
    },
    {
      label: "Material runway",
      value:
        plant.materialRunwayDays != null
          ? `${plant.materialRunwayDays.toFixed(1)}d`
          : "—",
      warn: plant.materialRunwayDays != null && plant.materialRunwayDays < 3,
    },
  ];

  return (
    <div
      className={[
        "flex items-stretch border-t border-white/10 shrink-0",
        emphasized ? "bg-amber-500/5" : "bg-slate-900/50",
      ].join(" ")}
      aria-label="Owner pulse"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-r border-white/10 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Owner
        </span>
        <Link
          href="/dashboard"
          className="text-[10px] text-sky-400 hover:text-sky-300"
        >
          Dashboard →
        </Link>
        <Link
          href="/metrics"
          className="text-[10px] text-sky-400 hover:text-sky-300"
        >
          Metrics →
        </Link>
      </div>
      {cells.map((c) => (
        <div
          key={c.label}
          className={[
            "flex flex-col justify-center px-3 py-1.5 border-r border-white/10 last:border-0 flex-1 min-w-0",
            c.warn ? "bg-amber-500/10" : "",
          ].join(" ")}
        >
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {c.label}
          </span>
          <span className="text-sm font-semibold tabular-nums text-slate-100 truncate">
            {c.value}
          </span>
          {"sub" in c && c.sub && (
            <span className="text-[10px] text-slate-500">{c.sub}</span>
          )}
        </div>
      ))}
    </div>
  );
}
