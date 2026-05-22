// app/(admin)/floor-board/_components/widgets/operator-board-widget.tsx
"use client";

import type { OperatorDailyRow } from "@/lib/floor-command/types";

function formatActiveTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function OperatorBoardWidget({
  operators,
}: {
  operators: OperatorDailyRow[];
}) {
  if (operators.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No operator data yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
        Operator Board
      </div>
      <div className="grid grid-cols-5 text-[9px] text-slate-600 uppercase tracking-wider pb-1 border-b border-white/10">
        <span className="col-span-2">Operator</span>
        <span className="text-right">Bags</span>
        <span className="text-right">Active</span>
        <span className="text-right">Damage</span>
      </div>
      {operators.map((op) => (
        <div
          key={op.operatorCode}
          className="grid grid-cols-5 items-center py-1 border-b border-white/5"
        >
          <div className="col-span-2 flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-300 flex-shrink-0">
              {op.operatorCode.slice(0, 2).toUpperCase()}
            </div>
            <span className="text-[11px] text-slate-300 truncate">
              {op.operatorCode}
            </span>
          </div>
          <span className="text-right text-sm font-bold tabular-nums text-slate-200">
            {op.bagsFinalized}
          </span>
          <span className="text-right text-[10px] text-slate-400">
            {formatActiveTime(op.activeSecondsTotal)}
          </span>
          <span
            className={`text-right text-[10px] font-semibold ${
              op.damageEventsTotal > 0 ? "text-red-400" : "text-slate-600"
            }`}
          >
            {op.damageEventsTotal || "--"}
          </span>
        </div>
      ))}
    </div>
  );
}
