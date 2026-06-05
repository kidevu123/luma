"use client";

import type { ActNowItem } from "@/lib/floor-command/act-now";
import type { FloorBoardMode } from "@/lib/floor-command/floor-board-mode";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { WidgetGridData } from "./widget-grid";
import type { PauseReasonRow } from "../_loaders";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { ActNowPanel } from "./act-now-panel";
import { CommandCenterCharts } from "./command-center-charts";
import { CommandCenterHeader } from "./command-center-header";
import { KpiRibbon } from "./kpi-ribbon";
import { MachineCommandGrid } from "./machine-command-grid";
import { OperationsPulseStrip } from "./operations-pulse-strip";
import { CommandCenterProductionAnswers } from "./command-center-production-answers";

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
  const isLead = mode === "lead";
  const isManager = mode === "manager" || mode === "owner";
  const [metricsOpen, setMetricsOpen] = useState(isManager);

  return (
    <div
      className={[
        "flex h-full min-h-0 flex-col bg-[#07090d]",
        enlarged ? "text-[15px]" : "",
      ].join(" ")}
    >
      <CommandCenterHeader
        mode={mode}
        onModeChange={onModeChange}
        showControls={!isTv}
        {...(isLead ? { snapshot: managerSnapshot } : {})}
      />

      {isManager && (
        <>
          <OperationsPulseStrip snapshot={managerSnapshot} />
          <CommandCenterProductionAnswers snapshot={managerSnapshot} />
          <button
            type="button"
            onClick={() => setMetricsOpen((v) => !v)}
            className="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0a0d12] px-4 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300"
          >
            <span>KPI & charts</span>
            {metricsOpen ? (
              <ChevronUp size={14} aria-hidden />
            ) : (
              <ChevronDown size={14} aria-hidden />
            )}
          </button>
          {metricsOpen && (
            <div className="max-h-[38vh] shrink-0 overflow-y-auto border-b border-white/[0.06]">
              <KpiRibbon
                shiftStatus={shiftStatus}
                kpiData={kpiData}
                plant={managerSnapshot.plant}
                dataGaps={managerSnapshot.dataGaps}
                throughputPoints={widgetData.throughputPoints}
              />
              <CommandCenterCharts
                throughputPoints={widgetData.throughputPoints}
                targetBagsPerHour={widgetData.targetBagsPerHour}
                queues={widgetData.queues}
                pauseReasons={pauseReasons}
                dataGaps={managerSnapshot.dataGaps}
              />
            </div>
          )}
        </>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <MachineCommandGrid
          rows={managerSnapshot.stationCommandRows}
          fillViewport
          dense={isLead || isTv}
        />
        {!isTv && (
          <aside
            className="flex w-[min(100%,280px)] shrink-0 flex-col border-l border-amber-500/20 bg-[#0b0e14]"
            aria-label="Andon"
          >
            <header className="shrink-0 border-b border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-400">
                Andon
              </h2>
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ActNowPanel items={actNowItems} compact hideHeader />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
