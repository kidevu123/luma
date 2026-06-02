"use client";

import Link from "next/link";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
  formatWait,
  humanStage,
  receiptLabel,
} from "@/lib/floor-command/floor-display";
import {
  groupWaitingByStage,
  partitionWip,
} from "@/lib/floor-command/wip-partition";
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
  const {
    plant,
    inFlight,
    recentFinalized,
    wipByStage,
    stageCycles,
    products,
    machines,
  } = snapshot;

  const { onStation, waiting, staleStationScans } = partitionWip(snapshot);
  const waitingGroups = groupWaitingByStage(waiting, humanStage);

  const oldestWait = waiting.reduce(
    (m, b) => Math.max(m, b.elapsedMinutes),
    0,
  );

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

  const wipTotal = inFlight.length;
  const countsLine =
    onStation.length + waiting.length === wipTotal
      ? `${wipTotal} in progress · ${onStation.length} at a station · ${waiting.length} between steps`
      : `${plant.bagsInFlow} in progress · ${onStation.length} at a station · ${waiting.length} between steps`;

  return (
    <div className="flex flex-col gap-3 p-3 min-h-0">
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-amber-400/80 font-medium">
          Right now
        </p>
        <p className="mt-1 text-lg sm:text-xl font-semibold text-slate-50 leading-snug">
          {countsLine}
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
        {staleStationScans.length > 0 && (
          <p className="mt-2 text-xs text-amber-400/90">
            {staleStationScans.length} station
            {staleStationScans.length === 1 ? "" : "s"} show an old scan (not
            counted as active):{" "}
            {staleStationScans.map((s) => s.label).join(", ")}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <FloorPanel
          title="At a station now"
          subtitle="Scanned and actively tied to equipment"
        >
          {onStation.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No bag is scanned at a station right now.
            </p>
          ) : (
            <BriefTable
              headers={["Station", "Receipt", "Product", "Operator", "On station"]}
              rows={onStation.map(({ station, bag }) => [
                station.label,
                receiptLabel(
                  bag.receiptNumber ?? station.receiptNumber,
                  bag.workflowBagId,
                ),
                bag.productName ?? station.productName ?? "—",
                station.operatorName ?? "—",
                station.busyForSeconds != null
                  ? formatWait(Math.floor(station.busyForSeconds / 60))
                  : formatWait(bag.elapsedMinutes),
              ])}
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Waiting between steps"
          subtitle="In the building but not at a station — grouped by stage"
        >
          {waitingGroups.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              Nothing waiting on the floor between stations.
            </p>
          ) : (
            <ul className="space-y-2 px-1 py-1">
              {waitingGroups.map((g) => (
                <li
                  key={g.stage ?? "unknown"}
                  className={[
                    "rounded-lg border px-3 py-2",
                    g.oldestMinutes > 120
                      ? "border-red-500/30 bg-red-500/[0.06]"
                      : "border-white/[0.08] bg-white/[0.02]",
                  ].join(" ")}
                >
                  <div className="flex justify-between gap-2">
                    <span className="text-sm text-slate-200 font-medium">
                      {g.label}
                    </span>
                    <span className="text-sm tabular-nums text-slate-400 shrink-0">
                      {g.count} bag{g.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Oldest {formatWait(g.oldestMinutes)}
                    {g.bags[0]?.productName
                      ? ` · ${g.bags[0].productName}`
                      : ""}
                  </p>
                </li>
              ))}
              <li>
                <Link
                  href="/workflow-submissions"
                  className="text-xs text-sky-500/90 hover:text-sky-400"
                >
                  Open all in-flight bags →
                </Link>
              </li>
            </ul>
          )}
        </FloorPanel>

        <FloorPanel
          title="Last completed"
          subtitle="Most recently finalized bags"
        >
          {recentFinalized.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              Nothing finalized yet — cycle times appear after bags complete.
            </p>
          ) : (
            <BriefTable
              headers={["Receipt", "Product", "Units", "Total cycle", "Finished"]}
              rows={recentFinalized.map((b) => [
                receiptLabel(b.receiptNumber),
                b.productName ?? "—",
                String(b.unitsYielded),
                formatCycleSec(b.totalCycleSec),
                `${formatWait(b.minutesAgo)} ago`,
              ])}
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Time per step (shift vs 7 days)"
          subtitle="Average minutes for bags finalized this shift"
        >
          {stageCycles.every((s) => s.avgSecShift == null) ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No completed bags this shift yet.
            </p>
          ) : (
            <BriefTable
              headers={["Step", "Shift", "7-day", "Bags", "Vs avg"]}
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
            />
          )}
        </FloorPanel>

        <FloorPanel
          title="Machines vs normal"
          subtitle="Slower than each machine’s 7-day average"
        >
          {machinesWithPace.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              Not enough history to compare machine pace.
            </p>
          ) : (
            <>
              {slowMachines.length > 0 && (
                <p className="text-xs text-red-400/90 mb-2 px-1">
                  Slower than usual: {slowMachines.map((m) => m.name).join(", ")}
                </p>
              )}
              <BriefTable
                headers={["Machine", "Working on", "Shift", "7-day", "Pace"]}
                rows={machinesWithPace.slice(0, 8).map((m) => [
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
          subtitle="Input pills and output units by product"
        >
          {materialRows.length === 0 ? (
            <p className="text-sm text-slate-500 px-1 py-2">
              No material usage recorded this shift.
            </p>
          ) : (
            <BriefTable
              headers={["Product", "Bags", "Pills in", "Units out", "Yield"]}
              rows={materialRows.map((p) => [
                p.productName,
                String(p.bagsFinalized),
                p.inputPills > 0 ? String(p.inputPills) : "—",
                String(p.unitsYielded),
                p.yieldPct != null ? `${p.yieldPct}%` : "—",
              ])}
            />
          )}
        </FloorPanel>
      </div>

      {wipByStage.length > 0 && (
        <FloorPanel title="WIP totals by stage" subtitle="From live bag state">
          <BriefTable
            headers={["Stage", "Bags", "Oldest"]}
            rows={wipByStage.map((w) => [
              w.label,
              String(w.count),
              formatWait(w.oldestMinutes),
            ])}
          />
        </FloorPanel>
      )}
    </div>
  );
}

function BriefTable({
  headers,
  rows,
  rowTone,
}: {
  headers: string[];
  rows: string[][];
  rowTone?: (row: string[], index: number) => "warn" | undefined;
}) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-left text-[12px] border-collapse">
        <thead>
          <tr className="text-slate-500 border-b border-white/[0.06]">
            {headers.map((h) => (
              <th key={h} className="py-1.5 pr-3 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => {
            const tone = rowTone?.(cells, i);
            return (
              <tr
                key={i}
                className={[
                  "border-b border-white/[0.04]",
                  tone === "warn" ? "bg-red-500/[0.06]" : "",
                ].join(" ")}
              >
                {cells.map((cell, j) => (
                  <td
                    key={j}
                    className={[
                      "py-1.5 pr-3 tabular-nums",
                      j === 0 ? "text-slate-200 font-medium" : "text-slate-400",
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
