// Six tiles, every one of them carrying trailing-7-day context so the
// board reads as "how is the machine doing" even at 6:05 AM when the
// shift counters are still zero.

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { formatWait, fmtPct } from "@/lib/floor-command/floor-display";
import type { DamageContext, SevenDayContext } from "../_data";
import { board, Chip, compactUnits } from "./board-ui";

type Props = {
  snapshot: FloorManagerSnapshot;
  sevenDay: SevenDayContext;
  damage: DamageContext;
  shiftMinutesElapsed: number;
};

function Tile({
  label,
  hero,
  heroTone = "text-slate-50",
  sub,
  context,
}: {
  label: string;
  hero: string;
  heroTone?: string;
  sub: string;
  context?: React.ReactNode;
}) {
  return (
    <div className={`${board.panel} ${board.panelPad} flex flex-col gap-1 min-w-0`}>
      <p className={board.eyebrow}>{label}</p>
      <p className={`${board.heroValue} ${heroTone}`}>{hero}</p>
      <p className={`${board.sub} truncate`}>{sub}</p>
      {context ? <div className="mt-auto pt-1">{context}</div> : null}
    </div>
  );
}

export function KpiDeck({ snapshot, sevenDay, damage, shiftMinutesElapsed }: Props) {
  const { plant, shiftActivity, wipByStage } = snapshot;
  const act = shiftActivity;

  // Pace: units/hr this shift vs the 7-day average converted to the
  // same 10-hour shift basis. Suppress until 30 minutes in.
  const elapsedHours = shiftMinutesElapsed / 60;
  const unitsPerHourShift =
    elapsedHours >= 0.5 ? Math.round(act.unitsFinalizedShift / elapsedHours) : null;
  const avg = sevenDay.avgUnitsPerDay;
  const avgUnitsPerHour = avg != null ? Math.round(avg / 10) : null;
  const paceDeltaPct =
    unitsPerHourShift != null && avgUnitsPerHour != null && avgUnitsPerHour > 0
      ? Math.round(((unitsPerHourShift - avgUnitsPerHour) / avgUnitsPerHour) * 100)
      : null;

  const oldestWaitingMin = wipByStage.reduce((m, s) => Math.max(m, s.oldestMinutes), 0);
  const waiting = Math.max(0, plant.bagsInFlow - act.atStation);

  const runway = plant.materialRunwayDays;
  const damageRate7d = damage.ratePct7d;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <Tile
        label="Finished this shift"
        hero={compactUnits(act.unitsFinalizedShift)}
        sub={`${act.finalizedShift} bags · ${act.displaysShift} displays · ${act.casesShift} cases`}
        context={
          avg != null ? (
            <span className={board.subtle}>7-day avg {compactUnits(avg)} units/day</span>
          ) : (
            <span className={board.subtle}>no 7-day history yet</span>
          )
        }
      />
      <Tile
        label="Pace"
        hero={unitsPerHourShift != null ? `${compactUnits(unitsPerHourShift)}/hr` : "—"}
        sub={
          avgUnitsPerHour != null
            ? `7-day norm ${compactUnits(avgUnitsPerHour)}/hr`
            : "no baseline yet"
        }
        context={
          paceDeltaPct != null ? (
            <Chip tone={paceDeltaPct >= 0 ? "ok" : paceDeltaPct > -25 ? "warn" : "crit"}>
              {paceDeltaPct >= 0 ? `+${paceDeltaPct}%` : `${paceDeltaPct}%`} vs 7-day
            </Chip>
          ) : (
            <span className={board.subtle}>early shift — pace settles after 30m</span>
          )
        }
      />
      <Tile
        label="Work in process"
        hero={`${plant.bagsInFlow}`}
        sub={`${act.atStation} on a machine · ${waiting} waiting between steps`}
        context={
          oldestWaitingMin > 0 ? (
            <Chip tone={oldestWaitingMin > 24 * 60 ? "crit" : oldestWaitingMin > 180 ? "warn" : "muted"}>
              oldest {formatWait(oldestWaitingMin)}
            </Chip>
          ) : (
            <span className={board.subtle}>nothing waiting</span>
          )
        }
      />
      <Tile
        label="Damage — 7 days"
        hero={damageRate7d != null ? `${damageRate7d.toFixed(2)}%` : "—"}
        heroTone={
          damageRate7d == null
            ? "text-slate-50"
            : damageRate7d > 2
              ? "text-red-300"
              : damageRate7d > 1
                ? "text-amber-300"
                : "text-emerald-300"
        }
        sub={`${damage.damaged7d.toLocaleString()} damaged of ${compactUnits(damage.units7d)} units`}
        context={
          <span className={board.subtle}>
            this shift {plant.damageRatePctShift != null ? fmtPct(plant.damageRatePctShift) : "—"}
          </span>
        }
      />
      <Tile
        label="Paused today"
        hero={plant.pauseMinutesToday > 0 ? formatWait(plant.pauseMinutesToday) : "0m"}
        heroTone={plant.pauseMinutesToday > 120 ? "text-amber-300" : "text-slate-50"}
        sub={`≈ $${Math.round(plant.pauseCostUsdToday).toLocaleString()} in labor`}
        context={
          plant.laneImbalanceLabel ? (
            <Chip tone="warn">{plant.laneImbalanceLabel}</Chip>
          ) : (
            <span className={board.subtle}>lanes balanced</span>
          )
        }
      />
      <Tile
        label="Material runway"
        hero={runway != null ? `${runway.toFixed(1)}d` : "—"}
        heroTone={
          runway == null
            ? "text-slate-50"
            : runway < 1
              ? "text-red-300"
              : runway < 3
                ? "text-amber-300"
                : "text-emerald-300"
        }
        sub={runway != null ? "at current burn rate" : "no burn data yet"}
        context={
          runway != null && runway < 3 ? (
            <Chip tone={runway < 1 ? "crit" : "warn"}>order materials</Chip>
          ) : undefined
        }
      />
    </div>
  );
}
