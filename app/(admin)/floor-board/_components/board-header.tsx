import { LiveRefresh } from "../live-refresh";
import { BoardClock } from "./board-clock";
import { formatWait } from "@/lib/floor-command/floor-display";
import { SHIFT_END_HOUR, SHIFT_START_HOUR } from "@/lib/production/shift-window";

type Props = {
  tz: string;
  shiftMinutesElapsed: number;
  shiftMinutesRemaining: number;
  dayKey: string;
};

export function BoardHeader({
  tz,
  shiftMinutesElapsed,
  shiftMinutesRemaining,
  dayKey,
}: Props) {
  const shiftTotal = shiftMinutesElapsed + shiftMinutesRemaining;
  const inShift = shiftMinutesRemaining > 0 && shiftTotal > 0;
  const pctComplete = inShift
    ? Math.min(100, Math.round((shiftMinutesElapsed / shiftTotal) * 100))
    : 100;
  const shiftWindow = `${String(SHIFT_START_HOUR).padStart(2, "0")}:00–${String(SHIFT_END_HOUR).padStart(2, "0")}:00`;

  return (
    <header className="flex items-center justify-between gap-4 border-b border-white/[0.07] bg-slate-950/70 px-4 py-2.5">
      <div className="flex items-baseline gap-3 min-w-0">
        <h1 className="text-base font-semibold tracking-tight text-slate-100 whitespace-nowrap">
          Floor Command
        </h1>
        <LiveRefresh />
      </div>

      <div className="flex items-center gap-5 text-[12px] text-slate-400">
        <div className="hidden sm:flex items-center gap-2">
          <span className="text-slate-500">Shift {shiftWindow}</span>
          {inShift ? (
            <>
              <div className="h-1.5 w-24 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-400/80"
                  style={{ width: `${pctComplete}%` }}
                />
              </div>
              <span className="tabular-nums">
                {formatWait(shiftMinutesElapsed)} in · {formatWait(shiftMinutesRemaining)} left
              </span>
            </>
          ) : (
            <span className="text-slate-500">off shift</span>
          )}
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold text-slate-100 leading-none">
            <BoardClock tz={tz} />
          </div>
          <div className="text-[10px] text-slate-500 tabular-nums mt-0.5">{dayKey}</div>
        </div>
      </div>
    </header>
  );
}
