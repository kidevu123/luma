// app/(admin)/floor-board/_components/kpi-strip.tsx
import type { KpiStripData } from "@/lib/production/floor-command";

function formatSeconds(s: number | null): string {
  if (s === null) return "--";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 border-r border-white/10 last:border-0 flex-1">
      <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold text-slate-100 tabular-nums">{value}</div>
    </div>
  );
}

export function KpiStrip({ data }: { data: KpiStripData }) {
  return (
    <div className="flex items-stretch h-12 bg-slate-900/90 border-t border-white/10">
      <KpiCell label="Bags Today" value={data.bagsToday.toLocaleString()} />
      <KpiCell label="Units Out" value={data.unitsOut.toLocaleString()} />
      <KpiCell label="Avg Cycle" value={formatSeconds(data.avgCycleSeconds)} />
      <KpiCell label="Active Operators" value={String(data.activeOperators)} />
      <KpiCell
        label="First-Pass Yield"
        value={data.firstPassYieldPct !== null ? `${data.firstPassYieldPct}%` : "--"}
      />
      <KpiCell label="Stations Idle" value={String(data.stationsCurrentlyIdle)} />
    </div>
  );
}
