"use client";

import { Monitor, User, Users } from "lucide-react";
import type { FloorBoardMode } from "@/lib/floor-command/floor-board-mode";
import { FloorLiveIndicator } from "./floor-board-ui";

const MODES: Array<{
  id: FloorBoardMode;
  label: string;
  icon: typeof Users;
}> = [
  { id: "lead", label: "Lead", icon: Users },
  { id: "manager", label: "Manager", icon: User },
  { id: "owner", label: "Owner", icon: User },
  { id: "tv", label: "TV", icon: Monitor },
];

type Props = {
  mode: FloorBoardMode;
  onModeChange: (mode: FloorBoardMode) => void;
  showControls?: boolean;
};

export function CommandCenterHeader({ mode, onModeChange, showControls = true }: Props) {
  const now = new Date();
  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 bg-[#0b0e14] shrink-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Luma
          </span>
          <FloorLiveIndicator />
        </div>
        <h1 className="text-lg sm:text-xl font-semibold text-slate-50 tracking-tight">
          Production command center
        </h1>
      </div>
      <div className="hidden sm:block text-right text-[11px] text-slate-500 tabular-nums shrink-0">
        <div>{dateStr}</div>
        <div className="text-slate-400">{timeStr}</div>
      </div>
      {showControls && (
        <div className="flex items-center gap-1 shrink-0">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onModeChange(id)}
              className={[
                "flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors",
                mode === id
                  ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                  : "border-white/10 text-slate-500 hover:text-slate-300",
              ].join(" ")}
            >
              <Icon size={11} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
