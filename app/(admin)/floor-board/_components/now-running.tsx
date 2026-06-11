// "What are they making, and how long has it been?" — one card per bag
// that is physically on a machine right now, plus the last completed
// bag so the board never looks dead between runs.

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
  formatWait,
  receiptLabel,
} from "@/lib/floor-command/floor-display";
import { resolveLinePlacement } from "@/lib/floor-command/production-lines";
import { board, Chip, lineAccents } from "./board-ui";

export function NowRunning({ snapshot }: { snapshot: FloorManagerSnapshot }) {
  const active = snapshot.stationCommandRows.filter((r) => r.workflowBagId);
  const last = snapshot.recentFinalized[0];

  return (
    <section className={board.panel}>
      <div className="flex items-center justify-between px-4 pt-3">
        <p className={board.eyebrow}>Now running</p>
        {last ? (
          <p className={board.subtle}>
            Last completed: <span className="text-slate-300">{last.productName ?? "unknown"}</span>
            {" · "}
            <span className="tabular-nums text-slate-300">{last.unitsYielded.toLocaleString()} units</span>
            {" · "}
            <span className="tabular-nums">{formatWait(last.minutesAgo)} ago</span>
            {" · cycle "}
            <span className="tabular-nums">{formatCycleSec(last.totalCycleSec)}</span>
          </p>
        ) : null}
      </div>

      {active.length === 0 ? (
        <div className="px-4 pb-4 pt-2">
          <p className="text-sm text-slate-400">
            Nothing on a machine right now.
            {snapshot.plant.bagsInFlow > 0
              ? ` ${snapshot.plant.bagsInFlow} bags are in flow waiting between steps — see the lanes below.`
              : " The floor is clear."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 px-4 pb-4 pt-2">
          {active.map((r) => {
            const placement = resolveLinePlacement(r.stationKind);
            const accent =
              placement?.line.id === "bottle_route" ? lineAccents.bottle : lineAccents.card;
            const elapsedMin =
              r.elapsedSeconds != null ? Math.floor(r.elapsedSeconds / 60) : null;
            const operator = r.activeOperatorName ?? r.operatorName;
            return (
              <div
                key={r.stationId}
                className={`rounded-lg border border-white/[0.08] bg-white/[0.02] px-3.5 py-3 ${accent.laneBorder}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-[10px] font-semibold tracking-[0.12em] ${accent.headerText}`}>
                    {accent.name}
                    {placement ? ` · ${placement.step.label.toUpperCase()}` : ""}
                  </p>
                  <div className="flex items-center gap-1">
                    {r.isOnHold ? <Chip tone="crit">On hold</Chip> : null}
                    {r.isPaused ? <Chip tone="warn">Paused</Chip> : null}
                  </div>
                </div>
                <p className="mt-1 text-lg font-semibold leading-tight text-slate-50">
                  {r.productName ?? "Product not selected"}
                </p>
                <p className="text-[12px] text-slate-400 tabular-nums">
                  {[r.poNumber, receiptLabel(r.receiptNumber, r.workflowBagId), r.bagLabel]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                  <span className="text-slate-300">{r.stationLabel}</span>
                  {operator ? <span>{operator}</span> : <Chip tone="muted">No operator</Chip>}
                  {elapsedMin != null ? (
                    <span className="tabular-nums">
                      running <span className="text-slate-200">{formatWait(elapsedMin)}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
