// app/(admin)/floor-board/_components/widgets/quality-watch-widget.tsx
"use client";

import type { RecentEventRow } from "@/lib/production/floor-command";

const QUALITY_EVENT_TYPES = new Set([
  "DAMAGE_REPORTED",
  "REWORK_SENT",
  "REWORK_RECEIVED",
  "CORRECTION_LOGGED",
  "BAG_SCRAPPED",
  "HOLD_PLACED",
  "HOLD_RELEASED",
]);

const EVENT_STYLES: Record<string, string> = {
  DAMAGE_REPORTED:  "text-red-400",
  REWORK_SENT:      "text-amber-400",
  REWORK_RECEIVED:  "text-sky-400",
  CORRECTION_LOGGED: "text-purple-400",
  BAG_SCRAPPED:     "text-red-500",
  HOLD_PLACED:      "text-orange-400",
  HOLD_RELEASED:    "text-emerald-400",
};

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function QualityWatchWidget({ events }: { events: RecentEventRow[] }) {
  const qualityEvents = events.filter((e) => QUALITY_EVENT_TYPES.has(e.eventType));

  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
        Quality Watch
      </div>
      {qualityEvents.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-sm text-emerald-400">
          First-pass clean
        </div>
      ) : (
        qualityEvents.map((e) => (
          <div
            key={e.id}
            className="flex items-start gap-2 py-1.5 border-b border-white/5"
          >
            <div className="flex-1 min-w-0">
              <div
                className={`text-[11px] font-semibold truncate ${EVENT_STYLES[e.eventType] ?? "text-slate-400"}`}
              >
                {e.eventType.replace(/_/g, " ").toLowerCase()}
              </div>
              <div className="text-[10px] text-slate-600 truncate">
                bag {e.workflowBagId.slice(0, 8)}
                {e.employeeId ? ` · ${e.employeeId}` : ""}
              </div>
            </div>
            <div className="text-[10px] text-slate-600 flex-shrink-0">
              {timeAgo(new Date(e.occurredAt))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
