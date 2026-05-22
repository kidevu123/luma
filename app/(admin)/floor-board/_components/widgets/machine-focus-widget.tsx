// app/(admin)/floor-board/_components/widgets/machine-focus-widget.tsx
"use client";

import type { StationWithLive } from "@/lib/floor-command/types";
import { Settings } from "lucide-react";

function formatSeconds(s: number | null): string {
  if (s === null) return "--";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function MachineFocusWidget({
  station,
  stationId,
  isEditing,
  onReconfigure,
}: {
  station: StationWithLive | null;
  stationId: string | undefined;
  isEditing: boolean;
  onReconfigure?: () => void;
}) {
  if (!stationId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500">
        <Settings size={20} />
        <span className="text-sm">Select a station to focus</span>
        {isEditing && (
          <button
            onClick={onReconfigure}
            className="text-xs text-sky-400 underline"
          >
            Configure
          </button>
        )}
      </div>
    );
  }

  if (!station) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500">
        <span className="text-sm">Station not found</span>
        {isEditing && (
          <button
            onClick={onReconfigure}
            className="text-xs text-sky-400 underline"
          >
            Reconfigure
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 h-full">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-slate-300">{station.label}</div>
          <div className="text-[10px] text-slate-500">
            {station.kind.replace(/_/g, " ").toLowerCase()}
          </div>
        </div>
        {isEditing && (
          <button onClick={onReconfigure} className="text-[10px] text-sky-400">
            Change
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(
          [
            { label: "Operator", value: station.currentEmployeeName ?? "--" },
            { label: "Product", value: station.currentProductName ?? "--" },
            { label: "Time on bag", value: formatSeconds(station.busyForSeconds) },
            {
              label: "Target rate",
              value: station.machineTargetBagsPerHour
                ? `${station.machineTargetBagsPerHour}/hr`
                : "--",
            },
          ] as const
        ).map(({ label, value }) => (
          <div key={label} className="bg-slate-800/60 rounded p-2">
            <div className="text-[9px] text-slate-600 uppercase tracking-wider">
              {label}
            </div>
            <div className="text-sm font-semibold text-slate-200 truncate">{value}</div>
          </div>
        ))}
      </div>

      {station.lastEventType && (
        <div className="text-[10px] text-slate-500">
          Last: {station.lastEventType.replace(/_/g, " ").toLowerCase()}
        </div>
      )}
    </div>
  );
}
