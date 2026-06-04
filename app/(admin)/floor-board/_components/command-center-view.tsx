"use client";

import type { ActNowItem } from "@/lib/floor-command/act-now";
import type { FloorBoardMode } from "@/lib/floor-command/floor-board-mode";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { WidgetGridData } from "./widget-grid";
import type { PauseReasonRow } from "../_loaders";
import { ActNowPanel } from "./act-now-panel";
import { CommandCenterCharts } from "./command-center-charts";
import { CommandCenterHeader } from "./command-center-header";
import { KpiRibbon } from "./kpi-ribbon";
import { LineFlowStrip } from "./line-flow-strip";

type Props = {
  mode: FloorBoardMode;
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  managerSnapshot: FloorManagerSnapshot;
  actNowItems: ActNowItem[];
  widgetData: WidgetGridData;
  pauseReasons: PauseReasonRow[];
  onModeChange: (mode: FloorBoardMode) => void;
  enlarged?: boolean;
};

export function CommandCenterView({
  mode,
  shiftStatus,
  kpiData,
  managerSnapshot,
  actNowItems,
  widgetData,
  pauseReasons,
  onModeChange,
  enlarged = false,
}: Props) {
  const isTv = mode === "tv";

  return (
    <div
      className={[
        "flex flex-col flex-1 min-h-0 bg-[#07090d]",
        enlarged ? "text-[15px]" : "",
      ].join(" ")}
    >
      <CommandCenterHeader
        mode={mode}
        onModeChange={onModeChange}
        showControls={!isTv}
      />
      <div className={enlarged ? "scale-[1.08] origin-top" : ""}>
        <KpiRibbon
          shiftStatus={shiftStatus}
          kpiData={kpiData}
          plant={managerSnapshot.plant}
          throughputPoints={widgetData.throughputPoints}
        />
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-col flex-1 min-w-0 min-h-0 border-r border-white/[0.06]">
          <LineFlowStrip
            stations={widgetData.stations}
            machines={managerSnapshot.machines}
          />
          <CommandCenterCharts
            throughputPoints={widgetData.throughputPoints}
            targetBagsPerHour={widgetData.targetBagsPerHour}
            queues={widgetData.queues}
            pauseReasons={pauseReasons}
          />
        </div>
        {!isTv && (
          <aside
            className="w-[min(100%,300px)] shrink-0 flex flex-col bg-[#0b0e14] border-l border-amber-500/20"
            aria-label="Andon"
          >
            <header className="px-3 py-2.5 border-b border-amber-500/25 bg-amber-500/[0.06] shrink-0">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-400">
                Andon
              </h2>
              <p className="text-[10px] text-amber-200/50 mt-0.5">
                Act on exceptions first
              </p>
            </header>
            <div className="flex-1 min-h-0 overflow-hidden">
              <ActNowPanel items={actNowItems} compact hideHeader />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
