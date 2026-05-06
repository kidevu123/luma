// Per-machine lifeline cards. One rich card per machine — the heart
// of the ops-tv board. Each card has:
//   - colored status band (running / idle / down / quiet)
//   - machine name + kind + state
//   - current bag (receipt + product + elapsed)
//   - last scan timestamp
//   - today's output
//   - cycle (current vs product 7d avg)
//   - cards/turn
//   - compressors inline
//   - 24h sparkline of events on this machine
//
// Color rules (the "big band" up top):
//   green = activity in last 5 min
//   amber = activity 5–30 min ago
//   red   = activity 30+ min ago AND machine has had activity in 24h
//   gray  = no activity in 24h ("quiet" — not necessarily a problem)

import * as React from "react";
import { SparkBars } from "@/components/charts/inline-charts";
import type { MachineLifeline } from "../_loaders";

const ONE_MIN = 60_000;

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem.toString().padStart(2, "0")}m`;
}

function machineKindLabel(k: string): string {
  return k
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtTimeAgo(d: Date | null): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "now";
  if (ms < ONE_MIN) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * ONE_MIN) return `${Math.floor(ms / ONE_MIN)}m ago`;
  if (ms < 24 * 60 * ONE_MIN)
    return `${Math.floor(ms / (60 * ONE_MIN))}h ago`;
  return `${Math.floor(ms / (24 * 60 * ONE_MIN))}d ago`;
}

type Status = "running" | "idle" | "down" | "quiet";

function classifyStatus(lastEventAt: Date | null): Status {
  if (!lastEventAt) return "quiet";
  const ms = Date.now() - lastEventAt.getTime();
  if (ms <= 5 * ONE_MIN) return "running";
  if (ms <= 30 * ONE_MIN) return "idle";
  if (ms <= 24 * 60 * ONE_MIN) return "down";
  return "quiet";
}

const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  idle: "Idle",
  down: "Down",
  quiet: "Quiet",
};

const STATUS_BAND: Record<Status, string> = {
  running: "bg-emerald-500",
  idle: "bg-amber-400",
  down: "bg-red-500",
  quiet: "bg-text-subtle/30",
};

const STATUS_TEXT: Record<Status, string> = {
  running: "text-emerald-700",
  idle: "text-amber-700",
  down: "text-red-700",
  quiet: "text-text-muted",
};

const STATUS_SPARK_COLOR: Record<Status, string> = {
  running: "#10b981",
  idle: "#f59e0b",
  down: "#ef4444",
  quiet: "#94a3b8",
};

export function LifelineGrid({
  machines,
}: {
  machines: MachineLifeline[];
}) {
  if (machines.length === 0) {
    return (
      <p className="text-sm text-text-muted py-3">
        No active machines. Configure machines under /admin/machines.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {machines.map((m) => (
        <LifelineCard key={m.machineId} m={m} />
      ))}
    </div>
  );
}

function LifelineCard({ m }: { m: MachineLifeline }) {
  const status = classifyStatus(m.lastEventAt);

  // Cycle delta — how is the current bag's elapsed vs product 7d avg.
  const elapsedMs = m.currentBagStartedAt
    ? Date.now() - m.currentBagStartedAt.getTime()
    : 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const avgCycleSec = m.currentProductAvgCycleSec ?? 0;
  const cycleRatio = avgCycleSec > 0 ? elapsedSec / avgCycleSec : 0;
  const cycleHot = cycleRatio >= 1.5;

  // Today output — pick the most-relevant for the kind.
  const todayCount =
    m.kind === "BLISTER"
      ? m.todayBlistered
      : m.kind === "SEALING"
        ? m.todaySealed
        : m.todayFinalized > 0
          ? m.todayFinalized
          : m.todayPackaged;

  return (
    <div className="rounded-lg border border-border/70 bg-surface overflow-hidden flex flex-col">
      {/* Status band */}
      <div className={`h-1.5 ${STATUS_BAND[status]}`} />

      <div className="p-2.5 space-y-2 flex-1">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-sm leading-tight truncate">
              {m.name}
            </p>
            <p className="text-[10px] text-text-subtle leading-tight">
              {machineKindLabel(m.kind)} · {m.cardsPerTurn}/turn
            </p>
          </div>
          <span
            className={`text-[10px] font-bold uppercase tracking-wider ${STATUS_TEXT[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>

        {/* Current bag */}
        {m.currentBagId ? (
          <div className="rounded-md bg-surface-2/40 px-2 py-1.5 space-y-0.5 border border-border/50">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
                Current bag
              </span>
              <span
                className={`text-[10px] font-mono tabular-nums ${
                  cycleHot ? "text-red-700 font-semibold" : "text-text-muted"
                }`}
              >
                {fmtElapsed(elapsedMs)}
                {avgCycleSec > 0 && (
                  <span className="text-text-subtle font-normal">
                    {" "}
                    · avg {fmtElapsed(avgCycleSec * 1000)}
                  </span>
                )}
              </span>
            </div>
            <p className="text-xs font-medium truncate">
              {m.currentProductName ?? "—"}
            </p>
            <p className="text-[10px] font-mono text-text-subtle truncate">
              {m.currentReceiptNumber ?? m.currentBagId.slice(0, 8)}
            </p>
          </div>
        ) : (
          <div className="rounded-md bg-surface-2/30 px-2 py-1.5 border border-dashed border-border/50">
            <p className="text-[11px] text-text-subtle italic">
              No active bag
            </p>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
          <div>
            <p className="uppercase tracking-wider text-text-subtle font-semibold">
              Last
            </p>
            <p className="font-mono tabular-nums text-text">
              {fmtTimeAgo(m.lastEventAt)}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider text-text-subtle font-semibold">
              Today
            </p>
            <p className="font-semibold tabular-nums text-text">
              {todayCount.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider text-text-subtle font-semibold">
              Units
            </p>
            <p className="font-semibold tabular-nums text-text">
              {m.todayUnits.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Compressors */}
        {m.compressors.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap pt-1 border-t border-border/40">
            <span className="text-[9px] uppercase tracking-wider text-text-subtle font-semibold">
              Comp:
            </span>
            {m.compressors.slice(0, 4).map((c, i) => {
              const ok = c.status === "working";
              return (
                <span
                  key={i}
                  className={`text-[10px] inline-flex items-center gap-0.5 rounded px-1 py-0 leading-tight ${
                    ok
                      ? "text-emerald-700 bg-emerald-50"
                      : "text-red-700 bg-red-50"
                  }`}
                >
                  <span
                    className={`h-1 w-1 rounded-full ${
                      ok ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  {c.name}
                </span>
              );
            })}
            {m.compressors.length > 4 && (
              <span className="text-[10px] text-text-subtle">
                +{m.compressors.length - 4}
              </span>
            )}
          </div>
        )}

        {/* 24h sparkline */}
        <div className="pt-1 border-t border-border/40">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[9px] uppercase tracking-wider text-text-subtle font-semibold">
              24h events
            </span>
            <span className="text-[9px] text-text-muted tabular-nums">
              {m.hourly.reduce((s, n) => s + n, 0)} total
            </span>
          </div>
          <SparkBars
            data={m.hourly}
            height={26}
            color={STATUS_SPARK_COLOR[status]}
          />
        </div>
      </div>
    </div>
  );
}
