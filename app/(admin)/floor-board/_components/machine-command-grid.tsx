"use client";

import { AlertTriangle, ChevronRight } from "lucide-react";
import { Fragment, useMemo } from "react";
import { formatWait } from "@/lib/floor-command/floor-display";
import type {
  LineStepGroup,
  ProductionLineDefinition,
} from "@/lib/floor-command/production-lines";
import {
  BOTTLE_PRODUCTION_LINE,
  buildLineStepGroupsForLine,
  CARD_PRODUCTION_LINE,
  lineMismatchInfo,
  secondaryLineRows,
} from "@/lib/floor-command/production-lines";
import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";
import { formatWeightKg } from "@/lib/ui/luma-display";
import { cn } from "@/lib/utils";

type Props = {
  rows: StationCommandRow[];
  displayLine: ProductionLineDefinition;
  fillViewport?: boolean;
  dense?: boolean;
  onSwitchLine?: (lineId: string) => void;
};

type CardState = "running" | "warning" | "paused" | "idle" | "down";

function actionItems(row: StationCommandRow): string[] {
  const items: string[] = [];
  if (row.isPaused) items.push("Paused");
  if (row.isOnHold) items.push("On hold");
  if (row.reworkPending) items.push("Rework pending");
  if (row.workflowBagId && !row.productName) items.push("Product not selected");
  if (
    row.workflowBagId &&
    !row.activeOperatorName &&
    !row.operatorName
  ) {
    items.push("No operator");
  }
  const needsBlister =
    row.stationKind === "BLISTER" || row.stationKind === "HANDPACK_BLISTER";
  if (needsBlister && row.machineId) {
    const hasPvc = row.activeRolls.some(
      (r) => r.materialRole === "PVC" || r.materialKind?.includes("PVC"),
    );
    const hasFoil = row.activeRolls.some(
      (r) => r.materialRole === "FOIL" || r.materialKind?.includes("FOIL"),
    );
    if (!hasPvc) items.push("PVC roll missing");
    if (!hasFoil) items.push("Foil roll missing");
  }
  if (!row.workflowBagId && (row.queueWip ?? 0) > 0) items.push("Queue waiting");
  if (!row.machineId && row.stationKind !== "PACKAGING") items.push("No machine");
  return items;
}

function cardState(row: StationCommandRow, actions: string[]): CardState {
  if (!row.machineId && row.stationKind !== "PACKAGING") return "down";
  if (row.isPaused || row.isOnHold) return "paused";
  if (actions.some((a) => a.includes("missing") || a.includes("selected"))) {
    return "warning";
  }
  if (row.workflowBagId) return "running";
  if ((row.queueWip ?? 0) > 0) return "warning";
  return "idle";
}

const stateStyles: Record<
  CardState,
  { label: string; border: string; badge: string; glow: string; dot: string }
> = {
  running: {
    label: "Running",
    border: "border-emerald-500/35",
    badge: "bg-emerald-500/15 text-emerald-200 border-emerald-400/35",
    glow: "shadow-[0_0_28px_rgba(16,185,129,0.10)]",
    dot: "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.75)]",
  },
  warning: {
    label: "Warning",
    border: "border-amber-500/45",
    badge: "bg-amber-500/15 text-amber-200 border-amber-400/35",
    glow: "shadow-[0_0_28px_rgba(245,158,11,0.10)]",
    dot: "bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.65)]",
  },
  paused: {
    label: "Paused",
    border: "border-orange-500/45",
    badge: "bg-orange-500/15 text-orange-200 border-orange-400/35",
    glow: "shadow-[0_0_28px_rgba(249,115,22,0.10)]",
    dot: "bg-orange-400 shadow-[0_0_12px_rgba(251,146,60,0.65)]",
  },
  idle: {
    label: "Idle",
    border: "border-white/[0.08]",
    badge: "bg-white/[0.05] text-slate-400 border-white/[0.10]",
    glow: "",
    dot: "bg-slate-600",
  },
  down: {
    label: "Down",
    border: "border-red-500/45",
    badge: "bg-red-500/15 text-red-200 border-red-400/35",
    glow: "shadow-[0_0_28px_rgba(239,68,68,0.12)]",
    dot: "bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.70)]",
  },
};

function shiftTotalLabel(row: StationCommandRow): string {
  if (row.stationKind === "BLISTER" || row.stationKind === "HANDPACK_BLISTER") {
    return `${row.todayBlistered.toLocaleString()} blistered`;
  }
  if (row.stationKind === "SEALING" || row.stationKind === "COMBINED") {
    return `${row.todaySealed.toLocaleString()} sealed`;
  }
  if (row.stationKind === "PACKAGING") {
    return `${row.todayPackaged.toLocaleString()} packaged`;
  }
  if (row.stationKind === "BOTTLE_HANDPACK") {
    return `${row.todayFinalized.toLocaleString()} filled`;
  }
  return `${row.todayFinalized.toLocaleString()} done`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const left = minutes % 60;
  return left > 0 ? `${hours}h ${left}m` : `${hours}h`;
}

function machineSubtitle(row: StationCommandRow): string {
  const parts = [
    row.machineName ?? row.machineKind ?? row.stationKind.replace(/_/g, " "),
  ];
  if (row.cardsPerTurn) parts.push(`${row.cardsPerTurn} cards/turn`);
  return parts.join(" · ");
}

function StationFloorTile({ row }: { row: StationCommandRow }) {
  const actions = actionItems(row);
  const state = cardState(row, actions);
  const style = stateStyles[state];
  const isActive =
    state === "running" ||
    state === "warning" ||
    state === "paused" ||
    (state === "down" && row.stationKind === "PACKAGING");

  const bagTitle =
    row.bagLabel ??
    (row.workflowBagId ? (row.receiptNumber ?? "Active bag") : null);

  return (
    <article
      className={cn(
        "flex min-h-[96px] min-w-0 flex-1 flex-col rounded-lg border transition-shadow duration-150",
        isActive ? "p-3 bg-slate-950/90" : "p-2.5 bg-[#0a0d12]/80",
        style.border,
        isActive && style.glow,
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", style.dot)} />
          <h3 className="truncate text-[13px] font-bold uppercase tracking-[0.1em] text-slate-100">
            {row.stationLabel}
          </h3>
        </div>
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]",
            style.badge,
          )}
        >
          {style.label}
        </span>
      </header>
      <p className="mt-0.5 truncate text-[10px] text-slate-500">
        {machineSubtitle(row)}
      </p>

      {state === "down" ? (
        <p className="flex flex-1 items-center justify-center text-[11px] font-medium uppercase tracking-[0.14em] text-red-300/80">
          No machine bound
        </p>
      ) : isActive ? (
        <div className="mt-2 min-h-0 flex-1 space-y-2">
          {bagTitle && (
            <p className="truncate font-mono text-[15px] font-bold text-slate-50 lg:text-[17px]">
              {bagTitle}
            </p>
          )}
          {row.productName ? (
            <p className="truncate text-[12px] font-semibold text-emerald-100">
              {row.productName}
              {row.elapsedSeconds != null && (
                <span className="font-normal text-slate-400">
                  {" "}
                  · {formatDuration(row.elapsedSeconds)}
                </span>
              )}
            </p>
          ) : row.workflowBagId ? (
            <p className="text-[11px] font-medium text-amber-200/90">
              Product chosen at seal
            </p>
          ) : state === "warning" && (row.queueWip ?? 0) > 0 ? (
            <p className="text-[12px] text-amber-200">
              {row.queueWip} bags waiting
              {row.queueOldestMinutes != null && row.queueOldestMinutes > 0
                ? ` · oldest ${formatWait(row.queueOldestMinutes)}`
                : ""}
            </p>
          ) : state === "paused" ? (
            <p className="text-[12px] font-medium uppercase tracking-wide text-orange-200">
              Paused
            </p>
          ) : null}

          {(row.stationKind === "BLISTER" ||
            row.stationKind === "HANDPACK_BLISTER") &&
            row.machineId && (
              <div className="flex flex-wrap gap-1">
                {row.activeRolls.slice(0, 2).map((roll) => (
                  <span
                    key={roll.packagingLotId}
                    className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-black/25 px-2 py-0.5 text-[10px] text-slate-400"
                  >
                    {roll.materialRole ?? "ROLL"}{" "}
                    {roll.rollNumber ?? "?"}
                    {roll.projectedRemainingGrams != null &&
                      ` · ${formatWeightKg(roll.projectedRemainingGrams)}`}
                  </span>
                ))}
                {actions.includes("PVC roll missing") && (
                  <span className="inline-flex rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                    PVC missing
                  </span>
                )}
                {actions.includes("Foil roll missing") && (
                  <span className="inline-flex rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                    Foil missing
                  </span>
                )}
              </div>
            )}

          {actions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {actions.slice(0, 2).map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1 rounded border border-amber-400/30 bg-amber-500/[0.08] px-1.5 py-0.5 text-[9px] font-semibold text-amber-100"
                >
                  <AlertTriangle size={10} aria-hidden />
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="flex flex-1 items-center justify-center text-[11px] uppercase tracking-[0.2em] text-slate-700">
          — idle —
        </p>
      )}

      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-white/[0.05] pt-2 text-[10px] tabular-nums text-slate-500">
        <span>Q {row.queueWip ?? 0}</span>
        <span className="truncate">{shiftTotalLabel(row)}</span>
      </footer>
    </article>
  );
}

function StepEmptyState({
  stepLabel,
  queueWip,
  queueOldestMinutes,
}: {
  stepLabel: string;
  queueWip: number;
  queueOldestMinutes: number | null;
}) {
  if (queueWip > 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-amber-500/25 bg-amber-500/[0.04] p-4 m-1">
        <p className="text-4xl font-bold tabular-nums text-amber-300">
          {queueWip}
        </p>
        <p className="mt-1 text-[12px] font-medium text-slate-400">
          bags waiting
        </p>
        {queueOldestMinutes != null && queueOldestMinutes > 0 && (
          <p className="mt-0.5 text-[10px] text-slate-500">
            oldest · {formatWait(queueOldestMinutes)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] p-4 m-1">
      <p className="text-[12px] font-medium text-slate-500">No station here</p>
      <p className="mt-1 text-center text-[10px] text-slate-600">
        Configure a {stepLabel.toLowerCase()} station in admin
      </p>
    </div>
  );
}

function StepConnector({ queueWip }: { queueWip: number }) {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center justify-center gap-1 self-stretch">
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-600 to-transparent" />
      {queueWip > 0 ? (
        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold tabular-nums text-amber-200">
          {queueWip}
        </span>
      ) : (
        <ChevronRight size={16} className="text-slate-700" aria-hidden />
      )}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-600 to-transparent" />
    </div>
  );
}

function LineStepColumn({
  group,
  dense,
}: {
  group: LineStepGroup;
  dense?: boolean;
}) {
  const stepQueue = group.stations.reduce(
    (sum, s) => sum + (s.queueWip ?? 0),
    0,
  );
  const oldestQueue = group.stations.reduce(
    (m, s) => Math.max(m, s.queueOldestMinutes ?? 0),
    0,
  );

  return (
    <div className="flex min-h-0 flex-col bg-[#07090d]">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-[#0a0d12] px-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-xs font-bold text-amber-300">
          {group.step.step}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold uppercase tracking-[0.08em] text-slate-100">
            {group.step.label}
          </p>
          {!dense && (
            <p className="hidden truncate text-[10px] text-slate-600 lg:block">
              {group.step.role}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right text-[10px] tabular-nums text-slate-500">
          {stepQueue > 0 && <span className="text-amber-300/90">Q {stepQueue}</span>}
          {group.stations.length > 0 && (
            <span className={stepQueue > 0 ? "ml-2" : ""}>
              {group.stations.length} stn
            </span>
          )}
        </div>
      </header>
      <div
        className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2"
        style={{
          gridTemplateRows: `repeat(${Math.max(group.stations.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {group.stations.length === 0 ? (
          <StepEmptyState
            stepLabel={group.step.label}
            queueWip={stepQueue}
            queueOldestMinutes={oldestQueue > 0 ? oldestQueue : null}
          />
        ) : (
          group.stations.map((row) => (
            <StationFloorTile key={row.stationId} row={row} />
          ))
        )}
      </div>
    </div>
  );
}

function LineFlowGrid({
  groups,
  dense,
}: {
  groups: LineStepGroup[];
  dense?: boolean;
}) {
  if (groups.length === 0) return null;

  return (
    <div className="flex h-full min-h-0 flex-1">
      {groups.map((group, index) => (
        <Fragment key={`${group.line.id}-${group.step.key}`}>
          <div className="flex min-w-0 flex-1 flex-col">
            <LineStepColumn
              group={group}
              {...(dense ? { dense: true } : {})}
            />
          </div>
          {index < groups.length - 1 && (
            <StepConnector
              queueWip={group.stations.reduce(
                (sum, s) => sum + (s.queueWip ?? 0),
                0,
              )}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function SecondaryLineStrip({
  line,
  rows,
}: {
  line: ProductionLineDefinition;
  rows: StationCommandRow[];
}) {
  const active = rows.filter((r) => r.workflowBagId).length;
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 overflow-x-auto border-t border-white/[0.06] bg-[#0a0d12] px-3">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {line.shortName}
      </span>
      <span className="shrink-0 text-[10px] text-slate-600">
        {rows.length} stations · {active} active
      </span>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {rows.map((row) => {
          const state = cardState(row, actionItems(row));
          return (
            <div
              key={row.stationId}
              className="flex h-10 w-36 shrink-0 items-center gap-2 rounded border border-white/[0.08] bg-black/20 px-2"
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  stateStyles[state].dot,
                )}
              />
              <span className="truncate text-[10px] font-medium text-slate-300">
                {row.stationLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineMismatchBanner({
  info,
  onSwitchLine,
}: {
  info: NonNullable<ReturnType<typeof lineMismatchInfo>>;
  onSwitchLine: (lineId: string) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/[0.06] px-4 py-2">
      <AlertTriangle size={14} className="shrink-0 text-amber-400" />
      <p className="min-w-0 flex-1 text-[11px] text-amber-100">
        Mixed lines · showing{" "}
        <span className="font-semibold">{info.primary.shortName}</span> (
        {info.cardCount} card · {info.bottleCount} bottle stations)
      </p>
      <button
        type="button"
        onClick={() => onSwitchLine(info.secondary.id)}
        className="shrink-0 rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-200 hover:bg-amber-500/20"
      >
        View {info.secondary.shortName}
      </button>
    </div>
  );
}

export function MachineCommandGrid({
  rows,
  displayLine,
  fillViewport = false,
  dense = false,
  onSwitchLine,
}: Props) {
  const groups = useMemo(
    () => buildLineStepGroupsForLine(displayLine, rows),
    [displayLine, rows],
  );
  const mismatch = useMemo(() => lineMismatchInfo(rows), [rows]);
  const secondaryRows = useMemo(
    () => secondaryLineRows(rows, displayLine),
    [rows, displayLine],
  );

  if (rows.length === 0) {
    return (
      <section className="flex flex-1 flex-col min-h-0 bg-[#07090d] p-3">
        <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-6 text-center text-sm text-red-100">
          No live station command rows loaded.
        </div>
      </section>
    );
  }

  const secondaryLine =
    displayLine.id === CARD_PRODUCTION_LINE.id
      ? BOTTLE_PRODUCTION_LINE
      : CARD_PRODUCTION_LINE;

  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-[#07090d]",
        fillViewport ? "h-full flex-1" : "flex-1",
      )}
    >
      {mismatch?.hasMismatch && onSwitchLine && (
        <LineMismatchBanner info={mismatch} onSwitchLine={onSwitchLine} />
      )}

      <LineFlowGrid groups={groups} {...(dense ? { dense: true } : {})} />

      {secondaryRows.length > 0 && dense && (
        <SecondaryLineStrip line={secondaryLine} rows={secondaryRows} />
      )}
    </section>
  );
}
