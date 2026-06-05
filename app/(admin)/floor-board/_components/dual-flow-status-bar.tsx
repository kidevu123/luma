"use client";

import {
  BOTTLE_PRODUCTION_LINE,
  buildLineStepGroupsForLine,
  CARD_PRODUCTION_LINE,
  type ProductionLineDefinition,
} from "@/lib/floor-command/production-lines";
import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";
import { cn } from "@/lib/utils";

type StepStatus = "running" | "warning" | "paused" | "idle" | "down";

function stepStatusFromRows(stations: StationCommandRow[]): StepStatus {
  if (stations.length === 0) return "idle";
  let worst: StepStatus = "idle";
  const rank: Record<StepStatus, number> = {
    idle: 0,
    running: 1,
    warning: 2,
    paused: 3,
    down: 4,
  };
  for (const row of stations) {
    let s: StepStatus = "idle";
    if (!row.machineId && row.stationKind !== "PACKAGING") s = "down";
    else if (row.isPaused || row.isOnHold) s = "paused";
    else if (row.workflowBagId) s = "running";
    else if ((row.queueWip ?? 0) > 0) s = "warning";
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

const dotStyles: Record<StepStatus, string> = {
  running: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]",
  warning: "bg-amber-400",
  paused: "bg-orange-400",
  idle: "bg-slate-600",
  down: "bg-red-400",
};

function FlowLine({
  line,
  rows,
  active,
  onSelect,
}: {
  line: ProductionLineDefinition;
  rows: StationCommandRow[];
  active: boolean;
  onSelect: () => void;
}) {
  const groups = buildLineStepGroupsForLine(line, rows);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
        active
          ? "border-amber-500/40 bg-amber-500/[0.08]"
          : "border-white/[0.06] bg-black/20 hover:border-white/10",
      )}
    >
      <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
        {line.shortName}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {groups.map((g, i) => {
          const st = stepStatusFromRows(g.stations);
          return (
            <span key={g.step.key} className="inline-flex items-center gap-1">
              {i > 0 && (
                <span className="text-slate-700" aria-hidden>
                  →
                </span>
              )}
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", dotStyles[st])}
                title={`${g.step.label}: ${st}`}
              />
              <span className="hidden truncate text-[9px] text-slate-500 sm:inline">
                {g.step.label.split("/")[0]?.trim()}
              </span>
            </span>
          );
        })}
      </div>
    </button>
  );
}

export type LineViewMode = "auto" | "card_route" | "bottle_route" | "both";

type Props = {
  rows: StationCommandRow[];
  lineView: LineViewMode;
  onLineViewChange: (mode: LineViewMode) => void;
  queueRail?: React.ReactNode;
};

export function DualFlowStatusBar({
  rows,
  lineView,
  onLineViewChange,
  queueRail,
}: Props) {
  const activeCard =
    lineView === "card_route" || lineView === "auto" || lineView === "both";
  const activeBottle =
    lineView === "bottle_route" || lineView === "both";

  return (
    <div className="flex shrink-0 flex-col border-b border-white/[0.06] bg-[#0a0d12]">
      <div className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 gap-2">
        <FlowLine
          line={CARD_PRODUCTION_LINE}
          rows={rows}
          active={activeCard}
          onSelect={() =>
            onLineViewChange(
              lineView === "card_route" ? "auto" : "card_route",
            )
          }
        />
        <FlowLine
          line={BOTTLE_PRODUCTION_LINE}
          rows={rows}
          active={activeBottle}
          onSelect={() =>
            onLineViewChange(
              lineView === "bottle_route" ? "auto" : "bottle_route",
            )
          }
        />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {lineView !== "auto" && (
          <button
            type="button"
            onClick={() => onLineViewChange("auto")}
            className="min-h-[36px] rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-sky-300 hover:bg-sky-500/20"
          >
            ← Auto
          </button>
        )}
        {(
          [
            ["auto", "Auto"],
            ["card_route", "Card"],
            ["both", "Both"],
            ["bottle_route", "Bottle"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onLineViewChange(id)}
            className={cn(
              "min-h-[36px] rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
              lineView === id
                ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                : "border-white/10 text-slate-500 hover:text-slate-300",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      </div>
      {queueRail}
    </div>
  );
}
