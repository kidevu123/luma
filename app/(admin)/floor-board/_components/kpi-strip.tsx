// Shift KPI footer — complements canonical metrics strip above.

import type { KpiStripData } from "@/lib/production/floor-command";
import { floorTokens } from "./floor-board-ui";

function formatSeconds(s: number | null): string {
  if (s === null) return "—";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-3 py-2 flex-1 min-w-0 border-r border-white/[0.06] last:border-0">
      <div className={floorTokens.label}>{label}</div>
      <div className="text-base sm:text-lg font-semibold text-slate-100 tabular-nums mt-0.5 truncate w-full text-center">
        {value}
      </div>
    </div>
  );
}

export function KpiStrip({ data }: { data: KpiStripData }) {
  return (
    <div
      className="flex items-stretch bg-slate-950/95 border-t border-white/[0.06]"
      aria-label="Shift KPI summary"
    >
      <KpiCell label="Bags today" value={data.bagsToday.toLocaleString()} />
      <KpiCell label="Units out" value={data.unitsOut.toLocaleString()} />
      <KpiCell label="Avg cycle" value={formatSeconds(data.avgCycleSeconds)} />
      <KpiCell label="Active ops" value={String(data.activeOperators)} />
      <KpiCell
        label="First-pass yield"
        value={data.firstPassYieldPct !== null ? `${data.firstPassYieldPct}%` : "—"}
      />
      <KpiCell label="Stations idle" value={String(data.stationsCurrentlyIdle)} />
    </div>
  );
}
