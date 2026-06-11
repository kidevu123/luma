// Trailing week of finished output as a simple bar strip — the "is the
// machine healthy" context that shift-scoped counters can't give.

import type { SevenDayContext } from "../_data";
import { board, compactUnits } from "./board-ui";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return WEEKDAY[d.getUTCDay()] ?? "";
}

export function SevenDayPulse({ sevenDay }: { sevenDay: SevenDayContext }) {
  const { daily, avgUnitsPerDay, bestDayUnits } = sevenDay;
  const max = Math.max(bestDayUnits, 1);
  const avgHeightPct =
    avgUnitsPerDay != null ? Math.min(100, (avgUnitsPerDay / max) * 100) : null;

  return (
    <section className={`${board.panel} ${board.panelPad}`}>
      <div className="flex items-baseline justify-between">
        <p className={board.eyebrow}>Daily output — last 7 days + today</p>
        {avgUnitsPerDay != null ? (
          <p className={board.subtle}>avg {compactUnits(avgUnitsPerDay)}/day</p>
        ) : null}
      </div>

      <div className="relative mt-3 flex h-28 items-end gap-1.5">
        {avgHeightPct != null ? (
          <div
            className="absolute inset-x-0 border-t border-dashed border-slate-500/50"
            style={{ bottom: `${avgHeightPct}%` }}
          />
        ) : null}
        {daily.map((d) => {
          const heightPct = Math.max(2, (d.units / max) * 100);
          return (
            <div key={d.day} className="flex h-full flex-1 flex-col justify-end items-center gap-1 min-w-0">
              <span className="text-[9px] tabular-nums text-slate-400 leading-none">
                {d.units > 0 ? compactUnits(d.units) : ""}
              </span>
              <div
                className={`w-full rounded-sm ${
                  d.isToday ? "bg-emerald-400/80" : d.units > 0 ? "bg-slate-500/60" : "bg-white/[0.04]"
                }`}
                style={{ height: `${heightPct}%` }}
              />
              <span
                className={`text-[9px] leading-none ${
                  d.isToday ? "font-semibold text-emerald-300" : "text-slate-500"
                }`}
              >
                {d.isToday ? "Today" : weekdayLabel(d.day)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
