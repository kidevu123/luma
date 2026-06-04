"use client";

import type { ReactNode } from "react";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
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

type PanelProps = {
  title: string;
  children: ReactNode;
};

function Panel({ title, children }: PanelProps) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-slate-900/60 px-3 py-2 min-w-[160px] flex-1">
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

/** The four questions a floor lead asks — sourced only from managerSnapshot (already loaded). */
export function CommandCenterProductionAnswers({ snapshot }: Props) {
  const { plant, machines, flavorToday, stageCycles, recentFinalized, products } =
    snapshot;

  const flavors = flavorToday.filter((f) => f.units > 0 || f.bags > 0);
  const flavorFallback = products.filter(
    (p) => p.bagsFinalized > 0 || p.unitsYielded > 0,
  );

  const machinesRanked = machines
    .map((m) => ({
      ...m,
      shift: trustedCycleSec(m.avgCycleSecShift),
      base: trustedCycleSec(m.avgCycleSec7d),
    }))
    .filter((m) => m.shift != null && m.base != null)
    .sort((a, b) => (b.shift! / b.base!) - (a.shift! / a.base!));

  const slowest = machinesRanked[0];
  const avgCycle = trustedCycleSec(plant.avgCycleSecShift);
  const skewed =
    plant.avgCycleSecShift != null &&
    plant.avgCycleSecShift > MAX_TRUSTED_CYCLE_SEC;

  const bottleneckStage = stageCycles
    .filter((s) => s.avgSecShift != null)
    .sort((a, b) => (b.avgSecShift ?? 0) - (a.avgSecShift ?? 0))[0];

  const last = recentFinalized[0];

  return (
    <section
      className="shrink-0 px-3 py-2 border-b border-white/[0.06] bg-slate-950/80"
      aria-label="Production answers"
    >
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
        What you asked for · from live read models
      </p>
      <div className="flex gap-2 overflow-x-auto pb-0.5">
        <Panel title="Flavors / products today">
          {flavors.length > 0 ? (
            <ul className="space-y-1">
              {flavors.slice(0, 5).map((f) => (
                <li key={f.productName} className="flex justify-between gap-2">
                  <span className="truncate text-slate-200">{f.productName}</span>
                  <span className="tabular-nums text-slate-400 shrink-0">
                    {f.units} u · {f.bags} bag{f.bags === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          ) : flavorFallback.length > 0 ? (
            <ul className="space-y-1">
              {flavorFallback.slice(0, 5).map((p) => (
                <li key={p.productId} className="flex justify-between gap-2">
                  <span className="truncate">{p.productName}</span>
                  <span className="tabular-nums text-slate-400 shrink-0">
                    {p.unitsYielded} u
                  </span>
                </li>
              ))}
              <li className="text-[10px] text-slate-600">Shift material usage</li>
            </ul>
          ) : (
            <span className="text-slate-500">
              No units finalized today in throughput read model. Check scanners
              / BAG_FINALIZED events.
            </span>
          )}
        </Panel>

        <Panel title="Machine taking longer">
          {slowest ? (
            <>
              <p className="font-medium text-amber-200/90">{slowest.name}</p>
              <p className="text-slate-400 mt-0.5">
                {paceLabel(slowest.shift, slowest.base)}
              </p>
              <p className="text-[10px] text-slate-600 mt-1 tabular-nums">
                Shift {formatCycleSec(slowest.shift)} · 7d{" "}
                {formatCycleSec(slowest.base)}
              </p>
              {slowest.currentReceiptNumber && (
                <p className="text-[10px] text-emerald-400/80 mt-1">
                  On: {receiptLabel(slowest.currentReceiptNumber)}
                </p>
              )}
            </>
          ) : (
            <span className="text-slate-500">
              Need finalized bags this shift on machines to compare pace (3
              finalized may not tie to a machine yet).
            </span>
          )}
        </Panel>

        <Panel title="Average cycle">
          {avgCycle != null ? (
            <>
              <p className="text-lg font-semibold tabular-nums text-slate-50">
                {formatCycleSec(avgCycle)}
              </p>
              <p className="text-slate-500 text-[11px]">
                {plant.bagsFinalizedShift} bag
                {plant.bagsFinalizedShift === 1 ? "" : "s"} finalized this shift
                (under 8h each)
              </p>
              {bottleneckStage && (
                <p className="text-[10px] text-slate-600 mt-1">
                  Slowest step: {bottleneckStage.label}{" "}
                  {formatCycleSec(bottleneckStage.avgSecShift)}
                </p>
              )}
            </>
          ) : skewed ? (
            <span className="text-amber-300/90">
              Hidden — one or more finalized bags took multi-day (stuck WIP).
              Clear old bags or use step times below.
            </span>
          ) : plant.bagsFinalizedShift === 0 ? (
            <span className="text-slate-500">
              No bags finalized this shift yet.
            </span>
          ) : (
            <span className="text-slate-500">
              {plant.bagsFinalizedShift} finalized but none under 8h total time.
            </span>
          )}
        </Panel>

        <Panel title="Last completed">
          {last ? (
            <>
              <p className="font-medium">
                {receiptLabel(last.receiptNumber, null)}
              </p>
              <p className="text-slate-400">{last.productName ?? "—"}</p>
              <p className="text-[10px] text-slate-600 mt-1 tabular-nums">
                {last.unitsYielded} units · {formatCycleSec(last.totalCycleSec)}{" "}
                total · {last.minutesAgo}m ago
              </p>
            </>
          ) : (
            <span className="text-slate-500">Nothing finalized yet today.</span>
          )}
        </Panel>
      </div>
    </section>
  );
}
