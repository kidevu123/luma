// app/(admin)/floor-board/_components/widgets/recent-events-widget.tsx
"use client";

import type { RecentEventRow } from "@/lib/production/floor-command";

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function RecentEventsWidget({ events }: { events: RecentEventRow[] }) {
  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
        Recent Events
      </div>
      {events.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-sm text-slate-600">
          No events yet
        </div>
      ) : (
        events.map((e) => (
          <div
            key={e.id}
            className="flex items-start gap-2 py-1 border-b border-white/5"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-medium text-slate-300 truncate">
                {e.eventType.replace(/_/g, " ").toLowerCase()}
              </div>
              <div className="text-[9px] text-slate-600">
                {e.workflowBagId.slice(0, 8)}
                {e.employeeId ? ` · ${e.employeeId}` : ""}
              </div>
            </div>
            <div className="text-[9px] text-slate-700 flex-shrink-0">
              {timeAgo(new Date(e.occurredAt))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
