// app/(admin)/floor-board/_components/status-bar.tsx
import type { ShiftStatusData, StatusCell, StatusLevel } from "@/lib/floor-command/types";

const LEVEL_STYLES: Record<StatusLevel, { border: string; badge: string; text: string; dot: string }> = {
  good:    { border: "border-emerald-500/40", badge: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-400" },
  warn:    { border: "border-amber-500/40",   badge: "bg-amber-500/10",   text: "text-amber-400",   dot: "bg-amber-400" },
  crit:    { border: "border-red-500/40",     badge: "bg-red-500/10",     text: "text-red-400",     dot: "bg-red-400" },
  neutral: { border: "border-white/10",       badge: "bg-white/5",        text: "text-slate-400",   dot: "bg-slate-500" },
};

function StatusCellView({ cell }: { cell: StatusCell }) {
  const s = LEVEL_STYLES[cell.level];
  return (
    <div className={`flex items-center gap-3 px-4 py-2 rounded border ${s.border} ${s.badge} flex-1 min-w-0`}>
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />
      <div className="min-w-0">
        <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{cell.label}</div>
        <div className={`text-sm font-semibold truncate ${s.text}`}>{cell.value}</div>
        {cell.detail && (
          <div className="text-[11px] text-slate-500 truncate">{cell.detail}</div>
        )}
      </div>
    </div>
  );
}

export function StatusBar({ data }: { data: ShiftStatusData }) {
  return (
    <div className="flex items-stretch gap-2 px-4 py-2 bg-slate-900/80 border-b border-white/10 h-14">
      <StatusCellView cell={data.target} />
      <StatusCellView cell={data.bottleneck} />
      <StatusCellView cell={data.quality} />
      <StatusCellView cell={data.attention} />
    </div>
  );
}
