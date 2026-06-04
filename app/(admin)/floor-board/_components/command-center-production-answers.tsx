"use client";

import type { ReactNode } from "react";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
  formatWait,
  receiptLabel,
  trustedCycleSec,
  MAX_TRUSTED_CYCLE_SEC,
} from "@/lib/floor-command/floor-display";

function paceLabel(shiftSec: number | null, baselineSec: number | null): string {
  if (shiftSec == null || baselineSec == null || baselineSec <= 0) {
    return "Not enough shift data";
  }
  const ratio = shiftSec / baselineSec;
  if (ratio > 1.2) return `${Math.round((ratio - 1) * 100)}% slower than 7d`;
  if (ratio < 0.85) return `${Math.round((1 - ratio) * 100)}% faster than 7d`;
  return "Near 7-day average";
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-slate-900/60 px-3 py-2 min-w-[150px] flex-1 max-w-[280px]">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h3>
      <div className="mt-1.5 text-[12px] text-slate-200 leading-snug">{children}</div>
    </div>
  );
}

type Props = {
  snapshot: FloorManagerSnapshot;
};

export function CommandCenterProductionAnswers({ snapshot }: Props) {
  const { plant, machines, flavorToday, stageCycles, recentFinalized, wipByStage } =
    snapshot;

  const flavors = flavorToday.filter((f) => f.units > 0 || f.bags > 0);

  const machinesRanked = machines
    .map((m) => ({
      ...m,
      shift: trustedCycleSec(m.avgCycleSecShift),
      base: trustedCycleSec(m.avgCycleSec7d),
    }))
    .filter((m) => m.shift != null && m.base != null)
    .sort((a, b) => (b.shift! / b.base!) - (a.shift! / a.base!));

  const slowestShift = machinesRanked[0];

  const slowest7d = [...machines]
    .filter((m) => trustedCycleSec(m.avgCycleSec7d) != null)
    .sort(
      (a, b) =>
        (trustedCycleSec(b.avgCycleSec7d) ?? 0) -
        (trustedCycleSec(a.avgCycleSec7d) ?? 0),
    )[0];

  const worstWip = [...wipByStage].sort(
    (a, b) => b.oldestMinutes - a.oldestMinutes,
  )[0];

  const recentTrusted = recentFinalized
    .map((b) => b.totalCycleSec)
    .filter((s) => s > 0 && s <= MAX_TRUSTED_CYCLE_SEC);
  const avgFromRecent =
    recentTrusted.length > 0
      ? Math.round(
          recentTrusted.reduce((sum, s) => sum + s, 0) / recentTrusted.length,
        )
      : null;

  const plantAvg = trustedCycleSec(plant.avgCycleSecShift);
  const avgCycle = plantAvg ?? avgFromRecent;

  const bottleneckStage = stageCycles
    .filter((s) => s.avgSecShift != null && trustedCycleSec(s.avgSecShift))
    .sort(
      (a, b) =>
        (trustedCycleSec(b.avgSecShift) ?? 0) -
        (trustedCycleSec(a.avgSecShift) ?? 0),
    )[0];

  const last = recentFinalized[0];

  return (
    <section
      className="shrink-0 px-3 py-2 border-b border-white/[0.06] bg-slate-950/80"
      aria-label="Production answers"
    >
      <div className="flex gap-2 overflow-x-auto">
        <Panel title="Flavors today">
          {flavors.length > 0 ? (
            <ul className="space-y-0.5">
              {flavors.slice(0, 4).map((f) => (
                <li key={f.productName} className="flex justify-between gap-2">
                  <span className="truncate">{f.productName}</span>
                  <span className="tabular-nums text-slate-400 shrink-0">
                    {f.units.toLocaleString()} u
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-slate-500">No throughput logged for today yet.</span>
          )}
        </Panel>

        <Panel title="Slowest / bottleneck">
          {slowestShift ? (
            <>
              <p className="font-medium text-amber-200/90">{slowestShift.name}</p>
              <p className="text-slate-400">{paceLabel(slowestShift.shift, slowestShift.base)}</p>
            </>
          ) : slowest7d ? (
            <>
              <p className="font-medium text-slate-200">{slowest7d.name}</p>
              <p className="text-slate-400">
                7d avg {formatCycleSec(trustedCycleSec(slowest7d.avgCycleSec7d))}
                {slowest7d.currentReceiptNumber
                  ? ` · on ${receiptLabel(slowest7d.currentReceiptNumber)}`
                  : ""}
              </p>
              <p className="text-[10px] text-slate-600 mt-0.5">
                Shift pace needs more finalized bags on this machine.
              </p>
            </>
          ) : worstWip ? (
            <>
              <p className="font-medium text-red-300/90">{worstWip.label}</p>
              <p className="text-slate-400">
                {worstWip.count} bag{worstWip.count === 1 ? "" : "s"} · oldest{" "}
                {formatWait(worstWip.oldestMinutes)}
              </p>
            </>
          ) : (
            <span className="text-slate-500">No machine or queue signal yet.</span>
          )}
        </Panel>

        <Panel title="Avg cycle">
          {avgCycle != null ? (
            <>
              <p className="text-lg font-semibold tabular-nums">
                {formatCycleSec(avgCycle)}
              </p>
              <p className="text-[11px] text-slate-500">
                {plantAvg != null
                  ? `${plant.bagsFinalizedShift} finalized this shift`
                  : `Last ${recentTrusted.length} completed (under 8h each)`}
              </p>
            </>
          ) : last && last.totalCycleSec > MAX_TRUSTED_CYCLE_SEC ? (
            <>
              <p className="text-amber-300/90">Last bag {formatCycleSec(last.totalCycleSec)}</p>
              <p className="text-[11px] text-slate-500">
                Multi-day bag — clear WIP for a honest shift average.
              </p>
            </>
          ) : bottleneckStage ? (
            <>
              <p className="font-medium">{formatCycleSec(bottleneckStage.avgSecShift)}</p>
              <p className="text-[11px] text-slate-500">
                Slowest step this shift: {bottleneckStage.label}
              </p>
            </>
          ) : (
            <span className="text-slate-500">No clean completions yet this shift.</span>
          )}
        </Panel>

        <Panel title="Last completed">
          {last ? (
            <>
              <p className="font-medium truncate">
                {receiptLabel(last.receiptNumber, null)}
              </p>
              <p className="text-slate-400 truncate">{last.productName ?? "—"}</p>
              <p className="text-[10px] text-slate-600 mt-0.5 tabular-nums">
                {last.unitsYielded.toLocaleString()} u · {formatCycleSec(last.totalCycleSec)} ·{" "}
                {last.minutesAgo}m ago
              </p>
            </>
          ) : (
            <span className="text-slate-500">Nothing finalized yet.</span>
          )}
        </Panel>
      </div>
    </section>
  );
}
