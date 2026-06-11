// Last finalized bags — proof of life with cycle times.

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import {
  formatCycleSec,
  formatWait,
  receiptLabel,
} from "@/lib/floor-command/floor-display";
import { board } from "./board-ui";

export function RecentCompletions({
  rows,
}: {
  rows: FloorManagerSnapshot["recentFinalized"];
}) {
  return (
    <section className={`${board.panel} ${board.panelPad}`}>
      <div className="flex items-baseline justify-between">
        <p className={board.eyebrow}>Recent completions</p>
        <p className={board.subtle}>units · cycle · when</p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-[12px] text-slate-500">No bags finalized recently.</p>
      ) : (
        <ul className="mt-2 divide-y divide-white/[0.04]">
          {rows.slice(0, 6).map((r, i) => (
            <li key={`${r.finalizedAt}-${i}`} className="flex items-baseline justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <p className="text-[12px] text-slate-200 truncate">
                  {r.productName ?? "Unknown product"}
                </p>
                <p className="text-[10.5px] text-slate-500 tabular-nums">
                  {receiptLabel(r.receiptNumber)}
                </p>
              </div>
              <p className="text-[11px] tabular-nums text-slate-400 shrink-0 text-right">
                <span className="text-slate-200">{r.unitsYielded.toLocaleString()}</span>
                {" · "}
                {formatCycleSec(r.totalCycleSec)}
                {" · "}
                {formatWait(r.minutesAgo)} ago
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
