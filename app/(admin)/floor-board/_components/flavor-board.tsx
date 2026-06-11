// Per-flavor output: what the machine made this week, with today's
// contribution called out. Answers "what are they making" over time.

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { FlavorOutputRow } from "../_data";
import { board, compactUnits } from "./board-ui";

export function FlavorBoard({
  flavor7d,
  flavorToday,
}: {
  flavor7d: FlavorOutputRow[];
  flavorToday: FloorManagerSnapshot["flavorToday"];
}) {
  const todayByName = new Map(flavorToday.map((f) => [f.productName, f.units]));
  const max = Math.max(...flavor7d.map((f) => f.units7d), 1);

  return (
    <section className={`${board.panel} ${board.panelPad}`}>
      <div className="flex items-baseline justify-between">
        <p className={board.eyebrow}>Output by flavor — 7 days</p>
        <p className={board.subtle}>units · bags</p>
      </div>

      {flavor7d.length === 0 ? (
        <p className="mt-3 text-[12px] text-slate-500">
          No finalized output in the last 7 days.
        </p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {flavor7d.map((f) => {
            const today = todayByName.get(f.productName) ?? 0;
            const widthPct = Math.max(2, (f.units7d / max) * 100);
            return (
              <li key={f.productName}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[12px] text-slate-200 truncate">{f.productName}</p>
                  <p className="text-[11px] tabular-nums text-slate-400 shrink-0">
                    {compactUnits(f.units7d)}
                    {today > 0 ? (
                      <span className="text-emerald-300"> (+{compactUnits(today)} today)</span>
                    ) : null}
                    <span className="text-slate-600"> · {f.bags7d}</span>
                  </p>
                </div>
                <div className="mt-1 h-1 rounded-full bg-white/[0.05] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-slate-400/60"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
