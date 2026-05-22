// app/(admin)/floor-board/_components/widgets/queue-health-widget.tsx
"use client";

import type { QueueHealthRow } from "@/lib/floor-command/types";

const STATUS_STYLES = {
  STALLED: { badge: "bg-red-500/20 text-red-400", bar: "bg-red-500" },
  AGING:   { badge: "bg-amber-500/20 text-amber-400", bar: "bg-amber-500" },
  FLOWING: { badge: "bg-emerald-500/20 text-emerald-400", bar: "bg-emerald-500" },
  EMPTY:   { badge: "bg-slate-700/40 text-slate-500", bar: "bg-slate-700" },
} as const;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function QueueHealthWidget({ queues }: { queues: QueueHealthRow[] }) {
  if (queues.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No queue data yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
        Queue Health
      </div>
      {queues.map((q) => {
        const s = STATUS_STYLES[q.queueStatus];
        return (
          <div
            key={q.stageKey}
            className="flex items-center gap-2 py-1.5 border-b border-white/5"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium text-slate-300 truncate">
                {q.stageKey.replace(/_/g, " ").toLowerCase()}
              </div>
              <div className="text-[10px] text-slate-600">
                oldest: {formatAge(q.oldestAgeSeconds)}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-sm font-bold tabular-nums text-slate-200">
                {q.wip}
              </span>
              <span
                className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${s.badge}`}
              >
                {q.queueStatus}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
