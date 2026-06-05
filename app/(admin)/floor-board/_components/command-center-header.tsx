"use client";

import { Monitor, User, Users } from "lucide-react";
import type { FloorBoardMode } from "@/lib/floor-command/floor-board-mode";
import { formatWait } from "@/lib/floor-command/floor-display";
import {
  lineFlowLabel,
  type ProductionLineDefinition,
} from "@/lib/floor-command/production-lines";
import type { LineViewMode } from "./dual-flow-status-bar";
import { partitionWip } from "@/lib/floor-command/wip-partition";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { FloorLiveStatus } from "@/app/(admin)/floor-board/_hooks/use-floor-live-refresh";
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
  snapshot?: FloorManagerSnapshot;
  displayLine?: ProductionLineDefinition;
  lineView?: LineViewMode;
  liveStatus?: FloorLiveStatus;
  lastUpdatedAt?: number | null;
  compact?: boolean;
};

export function CommandCenterHeader({
  mode,
  onModeChange,
  showControls = true,
  snapshot,
  displayLine,
  lineView = "auto",
  liveStatus = "live",
  lastUpdatedAt = null,
  compact = false,
}: Props) {
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

  const statusLine = snapshot
    ? (() => {
        const { onStation, waiting } = partitionWip(snapshot);
        const oldestWait = waiting.reduce(
          (m, b) => Math.max(m, b.elapsedMinutes),
          0,
        );
        const { plant } = snapshot;
        return (
          <p className="mt-0.5 truncate text-[11px] text-slate-400">
            <span className="text-slate-200 tabular-nums">{plant.bagsInFlow}</span>{" "}
            in flow ·{" "}
            <span className="text-slate-200 tabular-nums">{onStation.length}</span>{" "}
            at station ·{" "}
            <span className="text-slate-200 tabular-nums">{waiting.length}</span>{" "}
            waiting
            {oldestWait > 0 && (
              <>
                {" "}
                · longest wait{" "}
                <span className="text-amber-300/90">{formatWait(oldestWait)}</span>
              </>
            )}
          </p>
        );
      })()
    : null;

  return (
    <header
      className={[
        "flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#0b0e14]",
        compact ? "px-3 py-1" : "px-4 py-2 gap-3",
      ].join(" ")}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {!compact && (
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Luma
            </span>
          )}
          <FloorLiveIndicator
            status={liveStatus}
            lastUpdatedAt={lastUpdatedAt}
          />
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-amber-400/80">
            {displayLine
              ? `${displayLine.shortName.toUpperCase()}${lineView === "both" ? " · BOTH" : ""} · ${lineFlowLabel(displayLine)}`
              : "Blister → Seal → Pack"}
          </span>
        </div>
        {!compact && (
          <>
            <h1 className="text-base font-semibold tracking-tight text-slate-50 sm:text-lg">
              Production line
            </h1>
            {statusLine}
          </>
        )}
        {compact && statusLine}
      </div>
      <div className="hidden shrink-0 text-right text-[11px] tabular-nums text-slate-500 sm:block">
        <div>{dateStr}</div>
        <div className="text-slate-400">{timeStr}</div>
      </div>
      {showControls && (
        <div className="flex shrink-0 items-center gap-1">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onModeChange(id)}
              className={[
                "flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors sm:min-h-0 sm:min-w-0",
                mode === id
                  ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                  : "border-white/10 text-slate-500 hover:text-slate-300",
              ].join(" ")}
            >
              <Icon size={11} aria-hidden />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
