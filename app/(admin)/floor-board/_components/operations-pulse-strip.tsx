"use client";

import Link from "next/link";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
  formatWait,
  humanStage,
  receiptLabel,
  trustedCycleSec,
  MAX_TRUSTED_CYCLE_SEC,
} from "@/lib/floor-command/floor-display";
import {
  groupWaitingByStage,
  partitionWip,
} from "@/lib/floor-command/wip-partition";

type Props = {
  snapshot: FloorManagerSnapshot;
};

export function OperationsPulseStrip({ snapshot }: Props) {
  const { plant, recentFinalized, machines } = snapshot;
  const { onStation, waiting } = partitionWip(snapshot);
  const waitingGroups = groupWaitingByStage(waiting, humanStage);
  const oldestWait = waiting.reduce((m, b) => Math.max(m, b.elapsedMinutes), 0);

  const last = recentFinalized[0];
  const slowMachine = machines.find((m) => {
    const s = trustedCycleSec(m.avgCycleSecShift);
    const b = trustedCycleSec(m.avgCycleSec7d);
    return s != null && b != null && s / b > 1.2;
  });

  const avgCycle = trustedCycleSec(plant.avgCycleSecShift);

  return (
    <section className="shrink-0 border-b border-amber-500/20 bg-amber-500/[0.05] px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-slate-100">
          {plant.bagsInFlow} in progress
          <span className="font-normal text-slate-400">
            {" "}
            · {onStation.length} at a station · {waiting.length} waiting
          </span>
        </p>
        <p className="text-xs text-slate-500">
          Shift:{" "}
          <span className="text-slate-300 tabular-nums">
            {plant.bagsFinalizedShift} finalized
          </span>
          ,{" "}
          <span className="text-slate-300 tabular-nums">
            {plant.unitsYieldedShift.toLocaleString()} units yielded
          </span>
          {avgCycle != null && (
            <>
              {" "}
              · avg cycle{" "}
              <span className="text-slate-300">{formatCycleSec(avgCycle)}</span>
            </>
          )}
          {plant.avgCycleSecShift != null &&
            plant.avgCycleSecShift > MAX_TRUSTED_CYCLE_SEC && (
              <span className="text-amber-400/90">
                {" "}
                (full avg skewed by a long-running bag — see Andon)
              </span>
            )}
          {oldestWait > 0 && (
            <>
              {" "}
              · longest wait{" "}
              <span
                className={
                  oldestWait > 120 ? "text-red-400" : "text-amber-400/90"
                }
              >
                {formatWait(oldestWait)}
              </span>
            </>
          )}
        </p>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-2 text-[11px]">
        {onStation.length > 0 ? (
          onStation.slice(0, 4).map(({ station, bag }) => (
            <span
              key={bag.workflowBagId}
              className="rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-2 py-0.5 text-emerald-200/90"
            >
              {station.label}:{" "}
              {receiptLabel(
                bag.receiptNumber ?? station.receiptNumber,
                bag.workflowBagId,
              )}
              {station.busyForSeconds != null &&
                station.busyForSeconds > 3600 && (
                  <span className="text-amber-300/90">
                    {" "}
                    ({formatWait(Math.floor(station.busyForSeconds / 60))} on
                    station)
                  </span>
                )}
            </span>
          ))
        ) : (
          <span className="text-slate-600">No bag scanned at a station</span>
        )}

        {waitingGroups.slice(0, 3).map((g) => (
          <span
            key={g.stage ?? "unknown"}
            className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-slate-400"
          >
            {g.count} waiting · {g.label} (oldest {formatWait(g.oldestMinutes)})
          </span>
        ))}

        {last && (
          <span className="text-slate-500">
            Last done:{" "}
            <span className="text-slate-300">
              {receiptLabel(last.receiptNumber, null)}
            </span>
            {last.totalCycleSec > 0 && (
              <> · {formatCycleSec(last.totalCycleSec)}</>
            )}
          </span>
        )}

        {slowMachine && (
          <span className="text-amber-400/90">
            {slowMachine.name} slower than normal this shift
          </span>
        )}

        <Link
          href="/workflow-submissions"
          className="text-sky-500/80 hover:text-sky-400 ml-auto"
        >
          All in-flight →
        </Link>
      </div>
    </section>
  );
}
