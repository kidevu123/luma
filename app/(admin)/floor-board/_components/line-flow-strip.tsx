"use client";

import { Users } from "lucide-react";
import { groupStationsByStep, PACK_OUT_KINDS } from "@/lib/floor-command/step-groups";
import {
  formatBusyTime,
  getLiveStationStatus,
  LIVE_STATUS_STYLES,
} from "@/lib/floor-command/station-live-status";
import {
  formatCycleSec,
  formatWait,
  trustedCycleSec,
} from "@/lib/floor-command/floor-display";
import type { StationWithLive } from "@/lib/floor-command/types";
import type { MachineProductionRow } from "@/lib/production/floor-manager-snapshot-types";

function machineForStation(
  machines: MachineProductionRow[],
  machineId: string | null,
): MachineProductionRow | undefined {
  if (!machineId) return undefined;
  return machines.find((m) => m.machineId === machineId);
}

function StationTile({
  station,
  machines,
}: {
  station: StationWithLive;
  machines: MachineProductionRow[];
}) {
  const status = getLiveStationStatus(station);
  const style = LIVE_STATUS_STYLES[status];
  const isPack = PACK_OUT_KINDS.includes(station.kind);
  const machine = machineForStation(machines, station.machineId);
  const shiftCycle = trustedCycleSec(machine?.avgCycleSecShift);
  const baseline7d = trustedCycleSec(machine?.avgCycleSec7d);
  const onBagMin =
    station.busyForSeconds != null
      ? Math.floor(station.busyForSeconds / 60)
      : null;

  return (
    <div
      className={`flex flex-col rounded-lg border ${style.border} bg-slate-900/80 p-2.5 min-w-[128px] max-w-[160px] flex-1`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="text-xs font-semibold text-slate-200 leading-tight">
          {station.label}
        </span>
        <span
          className={`text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${style.badge}`}
        >
          {style.label}
        </span>
      </div>
      {isPack ? (
        <div className="flex items-center gap-1.5 mt-3 text-slate-500">
          <Users size={16} aria-hidden />
          <span className="text-[11px]">Hand pack</span>
        </div>
      ) : (
        <div className="mt-1.5 space-y-0.5 min-h-[40px]">
          <div className="text-[11px] text-slate-400">
            Cycle:{" "}
            <span className="text-slate-200 tabular-nums">
              {shiftCycle != null ? formatCycleSec(shiftCycle) : "—"}
            </span>
          </div>
          {baseline7d != null && (
            <div className="text-[10px] text-slate-600">
              7d {formatCycleSec(baseline7d)}
            </div>
          )}
          {onBagMin != null && onBagMin > 15 && (
            <div className="text-[10px] text-amber-400/90">
              On bag {formatWait(onBagMin)}
            </div>
          )}
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-white/[0.06] space-y-0.5">
        {station.currentReceiptNumber ? (
          <div className="text-[11px] font-mono text-emerald-400/90 truncate">
            {station.currentReceiptNumber}
          </div>
        ) : (
          <div className="text-[11px] text-slate-600">No bag scanned</div>
        )}
        {station.currentProductName && (
          <div className="text-[10px] text-slate-500 truncate">
            {station.currentProductName}
          </div>
        )}
        {station.currentEmployeeName && (
          <div className="text-[10px] text-slate-600 truncate">
            {station.currentEmployeeName}
          </div>
        )}
      </div>
    </div>
  );
}

type Props = {
  stations: StationWithLive[];
  machines: MachineProductionRow[];
};

export function LineFlowStrip({ stations, machines }: Props) {
  const groups = groupStationsByStep(stations);

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        No active stations configured.
      </div>
    );
  }

  return (
    <section className="flex flex-col min-h-0 flex-1 p-2 shrink-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400/90 mb-2">
        Line status · live
      </h2>
      <div className="flex items-stretch gap-2 overflow-x-auto pb-1 min-h-[120px] max-h-[38vh]">
        {groups.map((group, gi) => (
          <div key={group.label} className="flex items-stretch gap-2 shrink-0">
            <div className="flex flex-col gap-2">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 px-1">
                {group.label}
              </div>
              <div className="flex gap-2 items-stretch">
                {group.stations.map((s) => (
                  <StationTile key={s.id} station={s} machines={machines} />
                ))}
              </div>
            </div>
            {gi < groups.length - 1 && (
              <div className="flex items-center self-center px-1">
                <div className="w-8 h-px bg-gradient-to-r from-slate-600 to-slate-500" />
                <div className="w-0 h-0 border-t-[5px] border-b-[5px] border-l-[6px] border-t-transparent border-b-transparent border-l-slate-500" />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
