"use client";

import Link from "next/link";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
  formatWait,
  humanStage,
  receiptLabel,
} from "@/lib/floor-command/floor-display";
import { FloorPanel, floorTokens } from "./floor-board-ui";

type Props = {
  snapshot: FloorManagerSnapshot;
};

function paceLabel(
  shiftSec: number | null,
  baselineSec: number | null,
): { text: string; tone: "slow" | "fast" | "ok" | "muted" } {
  if (shiftSec == null || baselineSec == null || baselineSec <= 0) {
    return { text: "No comparison yet", tone: "muted" };
  }
  const ratio = shiftSec / baselineSec;
  if (ratio > 1.2) {
    return {
      text: `${Math.round((ratio - 1) * 100)}% slower than 7-day avg`,
      tone: "slow",
    };
  }
  if (ratio < 0.85) {
    return {
      text: `${Math.round((1 - ratio) * 100)}% faster than 7-day avg`,
      tone: "fast",
    };
  }
  return { text: "Near 7-day average", tone: "ok" };
}

export function OperationsBriefingPanel({ snapshot }: Props) {
  const { plant, stations, inFlight, recentFinalized, wipByStage, stageCycles, products, machines } =
    snapshot;

  const activeReceipts = new Set(
    stations
      .map((s) => s.receiptNumber)
      .filter((r): r is string => Boolean(r)),
  );

  const onStationNow = stations.filter(
    (s) => s.receiptNumber || s.workflowBagId,
  );

  const waitingAside = inFlight
    .filter((b) => !b.receiptNumber || !activeReceipts.has(b.receiptNumber))
    .sort((a, b) => b.elapsedMinutes - a.elapsedMinutes);

  const oldestWait =
    waitingAside[0]?.elapsedMinutes ??
    wipByStage[0]?.oldestMinutes ??
    0;

  const machinesWithPace = machines
    .filter((m) => m.avgCycleSec7d != null && m.avgCycleSecShift != null)
    .map((m) => ({
      ...m,
      pace: paceLabel(m.avgCycleSecShift, m.avgCycleSec7d),
    }))
    .sort((a, b) => {
      const ar =
        a.avgCycleSecShift && a.avgCycleSec7d
          ? a.avgCycleSecShift / a.avgCycleSec7d
          : 0;
      const br =
        b.avgCycleSecShift && b.avgCycleSec7d
          ? b.avgCycleSecShift / b.avgCycleSec7d
          : 0;
      return br - ar;
    });

  const slowMachines = machinesWithPace.filter((m) => m.pace.tone === "slow");

  const materialRows = products.filter(
    (p) => p.bagsFinalized > 0 || p.inputPills > 0 || p.unitsYielded > 0,
  );

  return (
    <div className="flex flex-col gap-3 p-3 min-h-0">
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-amber-400/80 font-medium">
          Right now
        </p>
        <p className="mt-1 text-lg sm:text-xl font-semibold text-slate-50 leading-snug">
          {plant.bagsInFlow} bag{plant.bagsInFlow === 1 ? "" : "s"} in the building
          <span className="text-slate-500 font-normal">
            {" "}
            · {onStationNow.length} on a machine
            {waitingAside.length > 0
              ? ` · ${waitingAside.length} waiting aside`
              : ""}
          </span>
        </p>
        <p className="mt-1 text-sm text-slate-400">
          This shift:{" "}
          <span className="text-slate-200 tabular-nums">
            {plant.bagsFinalizedShift} finalized
          </span>
          ,{" "}
          <span className="text-slate-200 tabular-nums">
            {plant.unitsYieldedShift} units
          </span>
          {oldestWait > 0 && (
            <>
              {" "}
              · longest wait{" "}
              <span
                className={
                  oldestWait > 120 ? floorTokens.danger : floorTokens.warn
                }
              >
                {formatWait(oldestWait)}
              </span>
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <FloorPanel
          title="On a machine now"
          subtitle="What is actively being worked — receipt, product, time on station"
        >
          {onStationNow.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              Nothing scanned at a station. Check waiting list or start a bag.
            </p>
          ) : (
            <BriefTable
              headers={["Station", "Receipt", "Product", "Operator", "On station"]}
              rows={onStationNow.map((s) => [
                s.label,
                receiptLabel(s.receiptNumber),
                s.productName ?? "—",
                s.operatorName ?? "—",
                s.busyForSeconds != null
                  ? formatWait(Math.floor(s.busyForSeconds / 60))
                  : s.idleMinutes != null
                    ? `idle ${formatWait(s.idleMinutes)}`
                    : "—",
              ])}
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Waiting on the floor"
          subtitle="In the building but not at a station — often the real bottleneck"
        >
          {waitingAside.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No bags sitting between steps (or all WIP is on a station).
            </p>
          ) : (
            <BriefTable
              headers={["Receipt", "Where", "Product", "Waiting", "Flags"]}
              rows={waitingAside.slice(0, 12).map((b) => [
                receiptLabel(b.receiptNumber, b.workflowBagId),
                humanStage(b.stage),
                b.productName ?? "—",
                formatWait(b.elapsedMinutes),
                [b.isPaused && "paused", b.isOnHold && "hold"]
                  .filter(Boolean)
                  .join(", ") || "—",
              ])}
              rowTone={(_, i) =>
                (waitingAside[i]?.elapsedMinutes ?? 0) > 120 ? "warn" : undefined
              }
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Last completed"
          subtitle="Most recently finalized bags — what just came off the line"
        >
          {recentFinalized.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No finalized bags in history yet today.
            </p>
          ) : (
            <BriefTable
              headers={["Receipt", "Product", "Units", "Total cycle", "Finished"]}
              rows={recentFinalized.map((b) => [
                receiptLabel(b.receiptNumber),
                b.productName ?? "—",
                String(b.unitsYielded),
                formatCycleSec(b.totalCycleSec),
                formatWait(b.minutesAgo) + " ago",
              ])}
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Time per step (this shift vs 7 days)"
          subtitle="Average minutes per stage for bags finalized this shift"
        >
          {stageCycles.every((s) => s.avgSecShift == null) ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No finalized bags this shift — cycle benchmarks need completed bags.
            </p>
          ) : (
            <BriefTable
              headers={["Step", "Shift avg", "7-day avg", "Bags this shift"]}
              rows={stageCycles.map((s) => {
                const pace = paceLabel(s.avgSecShift, s.avgSec7d);
                return [
                  s.label,
                  formatCycleSec(s.avgSecShift),
                  formatCycleSec(s.avgSec7d),
                  String(s.bagsShift),
                  pace.text,
                ];
              })}
              extraColumn="Vs average"
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Machines vs normal"
          subtitle="Shift cycle time compared to each machine’s 7-day average"
        >
          {machinesWithPace.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              Not enough finalized data to compare machine pace yet.
            </p>
          ) : (
            <>
              {slowMachines.length > 0 && (
                <p className="text-xs text-red-400/90 mb-2 px-1">
                  Slower than usual:{" "}
                  {slowMachines.map((m) => m.name).join(", ")}
                </p>
              )}
              <BriefTable
                headers={[
                  "Machine",
                  "Now / last",
                  "Shift avg",
                  "7d avg",
                  "Pace",
                ]}
                rows={machinesWithPace.slice(0, 10).map((m) => [
                  m.name,
                  m.currentReceiptNumber
                    ? receiptLabel(m.currentReceiptNumber)
                    : "idle",
                  formatCycleSec(m.avgCycleSecShift),
                  formatCycleSec(m.avgCycleSec7d),
                  m.pace.text,
                ])}
                rowTone={(_, i) =>
                  machinesWithPace[i]?.pace.tone === "slow" ? "warn" : undefined
                }
              />
            </>
          )}
        </FloorPanel>

        <FloorPanel
          title="Material → units (this shift)"
          subtitle="Pills in, units out, yield — by product"
        >
          {materialRows.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No material consumption recorded this shift.
            </p>
          ) : (
            <BriefTable
              headers={[
                "Product",
                "Bags",
                "Pills in",
                "Units out",
                "Yield",
                "Damage",
              ]}
              rows={materialRows.map((p) => [
                p.productName,
                String(p.bagsFinalized),
                p.inputPills > 0 ? String(p.inputPills) : "—",
                String(p.unitsYielded),
                p.yieldPct != null ? `${p.yieldPct}%` : "—",
                p.damageRatePct != null ? `${p.damageRatePct}%` : "—",
              ])}
            />
          )}
        </FloorPanel>
      </div>

      {wipByStage.length > 0 && (
        <FloorPanel
          title="WIP by stage"
          subtitle="Count and oldest wait at each workflow stage"
          className="xl:col-span-2"
        >
          <BriefTable
            headers={["Stage", "Bags", "Oldest wait"]}
            rows={wipByStage.map((w) => [
              w.label,
              String(w.count),
              formatWait(w.oldestMinutes),
            ])}
          />
        </FloorPanel>
      )}

      <p className="text-[10px] text-slate-600 text-center pb-1">
        <Link href="/metrics?days=7" className="text-sky-500/80 hover:text-sky-400">
          Full metrics & history →
        </Link>
      </p>
    </div>
  );
}

function BriefTable({
  headers,
  rows,
  extraColumn,
  rowTone,
}: {
  headers: string[];
  rows: string[][];
  extraColumn?: string;
  rowTone?: (row: string[], index: number) => "warn" | undefined;
}) {
  const cols = extraColumn ? [...headers, extraColumn] : headers;
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-left text-[12px] border-collapse">
        <thead>
          <tr className="text-slate-500 border-b border-white/[0.06]">
            {cols.map((h) => (
              <th key={h} className="py-1.5 pr-3 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => {
            const tone = rowTone?.(cells, i);
            const display =
              extraColumn && cells.length > headers.length
                ? cells
                : cells.slice(0, cols.length);
            return (
              <tr
                key={i}
                className={[
                  "border-b border-white/[0.04]",
                  tone === "warn" ? "bg-red-500/[0.06]" : "",
                ].join(" ")}
              >
                {display.map((cell, j) => (
                  <td
                    key={j}
                    className={[
                      "py-1.5 pr-3 tabular-nums",
                      j === 0 ? "text-slate-200 font-medium" : "text-slate-400",
                      j === cols.length - 1 && extraColumn
                        ? tone === "warn"
                          ? "text-red-400"
                          : "text-slate-500"
                        : "",
                    ].join(" ")}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
