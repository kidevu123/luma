"use client";

import { CommandCenterCharts } from "./command-center-charts";
import type { ThroughputDataPoint, QueueHealthRow } from "@/lib/floor-command/types";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { PauseReasonRow } from "../_loaders";

type Props = {
  throughputPoints: ThroughputDataPoint[];
  targetBagsPerHour: number | null;
  queues: QueueHealthRow[];
  pauseReasons: PauseReasonRow[];
  dataGaps: FloorManagerSnapshot["dataGaps"];
};

export function TrendsPanel({
  throughputPoints,
  targetBagsPerHour,
  queues,
  pauseReasons,
  dataGaps,
}: Props) {
  return (
    <div className="max-h-[24vh] shrink-0 overflow-y-auto border-t border-white/[0.06] bg-[#0a0d12]">
      <div className="border-b border-white/[0.06] px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Trends & downtime
        </span>
      </div>
      <CommandCenterCharts
        throughputPoints={throughputPoints}
        targetBagsPerHour={targetBagsPerHour}
        queues={queues}
        pauseReasons={pauseReasons}
        dataGaps={dataGaps}
      />
    </div>
  );
}
