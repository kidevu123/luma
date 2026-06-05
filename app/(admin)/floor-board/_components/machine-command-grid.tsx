"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  Layers3,
  Package,
  PauseCircle,
  UserRound,
} from "lucide-react";
import {
  formatCycleSec,
  formatWait,
  trustedCycleSec,
} from "@/lib/floor-command/floor-display";
import type {
  MachineRollRow,
  StationCommandRow,
} from "@/lib/production/floor-manager-snapshot-types";
import { cn } from "@/lib/utils";

type Props = {
  rows: StationCommandRow[];
};

type CardState = "running" | "warning" | "paused" | "idle" | "down";

function minutesFromSeconds(seconds: number | null): number | null {
  if (seconds == null) return null;
  return Math.floor(seconds / 60);
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "-";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  const leftMinutes = minutes % 60;
  return leftMinutes > 0 ? `${hours}h ${leftMinutes}m` : `${hours}h`;
}

function formatTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function stationDisplayKind(kind: string): string {
  return kind.replace(/_/g, " ").toLowerCase();
}

function cycleDelta(row: StationCommandRow): string {
  const shift = trustedCycleSec(row.avgCycleSecShift);
  const base = trustedCycleSec(row.avgCycleSec7d);
  if (shift == null || base == null || base <= 0) return "no shift baseline";
  const ratio = shift / base;
  if (ratio > 1.2) return `${Math.round((ratio - 1) * 100)}% slow vs 7d`;
  if (ratio < 0.85) return `${Math.round((1 - ratio) * 100)}% fast vs 7d`;
  return "near 7d pace";
}

function throughputForStation(row: StationCommandRow): {
  label: string;
  value: number;
  sub: string;
} {
  if (row.stationKind === "BLISTER" || row.stationKind === "HANDPACK_BLISTER") {
    return {
      label: "Blistered",
      value: row.todayBlistered,
      sub: `${row.todayUnits.toLocaleString()} units out`,
    };
  }
  if (row.stationKind === "SEALING") {
    return {
      label: "Sealed",
      value: row.todaySealed,
      sub: `${row.todayFinalized} finalized`,
    };
  }
  if (row.stationKind === "PACKAGING") {
    return {
      label: "Packaged",
      value: row.todayPackaged,
      sub: `${row.todayFinalized} finalized`,
    };
  }
  return {
    label: "Finalized",
    value: row.todayFinalized,
    sub: `${row.todayUnits.toLocaleString()} units out`,
  };
}

function rollRoleLabel(roll: MachineRollRow): string {
  if (roll.materialRole) return roll.materialRole;
  if (roll.materialKind?.includes("FOIL")) return "FOIL";
  if (roll.materialKind?.includes("PVC")) return "PVC";
  return "ROLL";
}

function sortRolls(rolls: MachineRollRow[]): MachineRollRow[] {
  const weight = (role: string | null) => {
    if (role === "PVC") return 0;
    if (role === "FOIL") return 1;
    return 2;
  };
  return [...rolls].sort(
    (a, b) => weight(a.materialRole) - weight(b.materialRole),
  );
}

function rollMissing(row: StationCommandRow, role: "PVC" | "FOIL"): boolean {
  const needsBlisterRolls =
    row.stationKind === "BLISTER" || row.stationKind === "HANDPACK_BLISTER";
  if (!needsBlisterRolls || !row.machineId) return false;
  return !row.activeRolls.some((r) => rollRoleLabel(r) === role);
}

function actionItems(row: StationCommandRow): string[] {
  const items: string[] = [];
  if (row.isPaused) items.push("Paused bag");
  if (row.isOnHold) items.push("On hold");
  if (row.reworkPending) items.push("Rework pending");
  if (row.workflowBagId && !row.productName) items.push("Product not selected");
  if (row.workflowBagId && !row.activeOperatorName && !row.operatorName) {
    items.push("No operator session");
  }
  if (rollMissing(row, "PVC")) items.push("PVC roll missing");
  if (rollMissing(row, "FOIL")) items.push("Foil roll missing");
  const elapsedMin = minutesFromSeconds(row.elapsedSeconds);
  if (elapsedMin != null && elapsedMin >= 45) items.push("Long active bag");
  if (!row.workflowBagId && (row.queueWip ?? 0) > 0) items.push("Queue waiting");
  if (!row.machineId && row.stationKind !== "PACKAGING") items.push("No machine");
  if (row.targetBagsPerHour == null && row.machineId) items.push("No target");
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
  {
    label: string;
    border: string;
    badge: string;
    glow: string;
    dot: string;
  }
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
    border: "border-white/[0.09]",
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

function RollCard({ roll }: { roll: MachineRollRow }) {
  const runway =
    roll.projectedBlistersRemaining != null
      ? `${roll.projectedBlistersRemaining.toLocaleString()} blisters left`
      : roll.projectedRemainingGrams != null
        ? `${Math.round(roll.projectedRemainingGrams).toLocaleString()}g left`
        : "remaining unknown";

  return (
    <div className="rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
          {rollRoleLabel(roll)}
        </span>
        <span className="text-[10px] text-slate-600">{roll.confidence}</span>
      </div>
      <p className="mt-1 truncate text-[15px] font-semibold text-slate-100">
        {roll.rollNumber ?? "Unnumbered roll"}
      </p>
      <p className="truncate text-[11px] text-slate-400">
        {roll.materialName ?? roll.materialKind ?? "Material unknown"}
      </p>
      <p className="mt-1.5 text-[10px] text-slate-500">{runway}</p>
    </div>
  );
}

function MissingRollCard({ role }: { role: "PVC" | "FOIL" }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-amber-200">
        <AlertTriangle size={13} aria-hidden />
        <span className="text-[10px] font-bold uppercase tracking-[0.16em]">
          {role}
        </span>
      </div>
      <p className="mt-1 text-[13px] font-semibold text-amber-100">
        No active roll
      </p>
      <p className="text-[10px] text-amber-200/70">Mount event not open</p>
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
}) {
  return (
    <div className="min-w-0 rounded-md border border-white/[0.07] bg-white/[0.025] px-2 py-1.5">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-100">
        {value}
      </p>
      {sub && <p className="truncate text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}

function StationCommandCard({ row }: { row: StationCommandRow }) {
  const actions = actionItems(row);
  const state = cardState(row, actions);
  const style = stateStyles[state];
  const throughput = throughputForStation(row);
  const sortedRolls = sortRolls(row.activeRolls);
  const elapsedMin = minutesFromSeconds(row.elapsedSeconds);
  const queueLabel =
    row.queueWip != null
      ? `${row.queueWip} waiting`
      : row.stationKind === "PACKAGING"
        ? "shared"
        : "-";
  const operator =
    row.activeOperatorName ?? row.operatorName ?? row.operatorCode ?? null;
  const target =
    row.targetBagsPerHour != null ? `${row.targetBagsPerHour}/hr target` : null;
  const bagTitle =
    row.bagLabel ??
    (row.workflowBagId ? row.receiptNumber ?? "Active bag" : "No bag scanned");
  const productLine = row.productName ?? "No product selected yet";

  return (
    <article
      className={cn(
        "min-w-0 rounded-lg border bg-slate-950/90 p-3",
        "flex flex-col gap-3",
        style.border,
        style.glow,
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("h-2.5 w-2.5 rounded-full", style.dot)} />
            <h3 className="truncate text-sm font-bold uppercase tracking-[0.12em] text-slate-100">
              {row.stationLabel}
            </h3>
          </div>
          <p className="mt-1 truncate text-[11px] text-slate-500">
            {row.machineName ?? "No machine bound"} ·{" "}
            {row.machineKind ?? stationDisplayKind(row.stationKind)}
            {row.cardsPerTurn ? ` · ${row.cardsPerTurn} cards/turn` : ""}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em]",
            style.badge,
          )}
        >
          {style.label}
        </span>
      </header>

      <section className="grid grid-cols-2 gap-2">
        {sortedRolls.map((roll) => (
          <RollCard key={roll.packagingLotId} roll={roll} />
        ))}
        {rollMissing(row, "PVC") && <MissingRollCard role="PVC" />}
        {rollMissing(row, "FOIL") && <MissingRollCard role="FOIL" />}
        {sortedRolls.length === 0 &&
          !rollMissing(row, "PVC") &&
          !rollMissing(row, "FOIL") && (
            <div className="col-span-2 rounded-md border border-white/[0.07] bg-black/15 px-2.5 py-2 text-[11px] text-slate-600">
              No machine roll is mounted for this station.
            </div>
          )}
      </section>

      <section className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
        <div className="flex items-start gap-2">
          <Package size={16} className="mt-0.5 shrink-0 text-slate-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold text-slate-50">
              {bagTitle}
            </p>
            {row.bagLabelSecondary && (
              <p className="truncate text-[11px] text-slate-500">
                {row.bagLabelSecondary}
              </p>
            )}
            <div
              className={cn(
                "mt-2 rounded-md border px-2.5 py-2",
                row.productName
                  ? "border-emerald-500/20 bg-emerald-500/[0.05]"
                  : "border-amber-400/45 bg-amber-500/[0.08]",
              )}
            >
              <p
                className={cn(
                  "text-[12px] font-semibold",
                  row.productName ? "text-emerald-100" : "text-amber-100",
                )}
              >
                {productLine}
              </p>
              {!row.productName && row.workflowBagId && (
                <p className="text-[11px] text-amber-200/75">
                  Finished product will be chosen at sealing.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-3 gap-2">
        <StatCell
          label="Elapsed"
          value={formatDuration(row.elapsedSeconds)}
          sub={row.startedAt ? `started ${formatTime(row.startedAt)}` : "not active"}
        />
        <StatCell
          label="Queue"
          value={queueLabel}
          sub={
            row.queueOldestMinutes != null && row.queueOldestMinutes > 0
              ? `oldest ${formatWait(row.queueOldestMinutes)}`
              : row.queueStatus ?? undefined
          }
        />
        <StatCell
          label={throughput.label}
          value={throughput.value.toLocaleString()}
          sub={throughput.sub}
        />
      </section>

      <section className="grid grid-cols-2 gap-2">
        <StatCell
          label="Cycle"
          value={formatCycleSec(trustedCycleSec(row.avgCycleSecShift))}
          sub={cycleDelta(row)}
        />
        <StatCell
          label="Target"
          value={target ?? "-"}
          sub={
            elapsedMin != null && elapsedMin > 0
              ? `${formatWait(elapsedMin)} on current bag`
              : "idle timer clear"
          }
        />
      </section>

      <section className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-white/[0.07] bg-black/15 px-2 py-1.5">
          <UserRound size={14} className="shrink-0 text-slate-500" />
          <span className="truncate text-slate-300">
            {operator ?? "No operator session"}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-white/[0.07] bg-black/15 px-2 py-1.5">
          <Clock size={14} className="shrink-0 text-slate-500" />
          <span className="truncate text-slate-300">
            {row.lastEventType
              ? `${row.lastEventType} · ${formatTime(row.lastEventAt)}`
              : "No live event"}
          </span>
        </div>
      </section>

      <section className="mt-auto flex flex-wrap gap-1.5">
        {actions.length > 0 ? (
          actions.slice(0, 5).map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-500/[0.08] px-2 py-1 text-[10px] font-semibold text-amber-100"
            >
              <AlertTriangle size={12} aria-hidden />
              {item}
            </span>
          ))
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/[0.08] px-2 py-1 text-[10px] font-semibold text-emerald-100">
            <CheckCircle2 size={12} aria-hidden />
            Clear
          </span>
        )}
      </section>
    </article>
  );
}

export function MachineCommandGrid({ rows }: Props) {
  const sorted = [...rows].sort((a, b) => {
    const aActions = actionItems(a).length;
    const bActions = actionItems(b).length;
    if (a.workflowBagId && !b.workflowBagId) return -1;
    if (!a.workflowBagId && b.workflowBagId) return 1;
    if (aActions !== bActions) return bActions - aActions;
    return a.stationLabel.localeCompare(b.stationLabel);
  });

  const running = rows.filter((r) => r.workflowBagId).length;
  const warnings = rows.filter((r) => actionItems(r).length > 0).length;
  const queue = rows.reduce((sum, r) => sum + (r.queueWip ?? 0), 0);

  if (rows.length === 0) {
    return (
      <section className="shrink-0 border-b border-white/[0.06] bg-[#07090d] p-3">
        <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-6 text-center text-sm text-red-100">
          No live station command rows loaded.
        </div>
      </section>
    );
  }

  return (
    <section className="shrink-0 border-b border-white/[0.06] bg-[#07090d] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[12px] font-bold uppercase tracking-[0.18em] text-amber-300">
            Live machine command cards
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            {running} active · {warnings} exceptions · {queue} queued
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1">
            <Layers3 size={13} aria-hidden />
            rolls
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1">
            <Activity size={13} aria-hidden />
            station state
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1">
            <Gauge size={13} aria-hidden />
            pace
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1">
            <PauseCircle size={13} aria-hidden />
            holds
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {sorted.map((row) => (
          <StationCommandCard key={row.stationId} row={row} />
        ))}
      </div>
    </section>
  );
}
