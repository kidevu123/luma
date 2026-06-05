"use client";

import type { ActNowItem } from "@/lib/floor-command/act-now";
import type { FloorBoardMode } from "@/lib/floor-command/floor-board-mode";
import {
  BOTTLE_PRODUCTION_LINE,
  CARD_PRODUCTION_LINE,
  primaryLineForRows,
} from "@/lib/floor-command/production-lines";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { FloorLiveStatus } from "@/app/(admin)/floor-board/_hooks/use-floor-live-refresh";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { WidgetGridData } from "./widget-grid";
import type { PauseReasonRow } from "../_loaders";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ActNowPanel } from "./act-now-panel";
import { CommandCenterCharts } from "./command-center-charts";
import { CommandCenterHeader } from "./command-center-header";
import {
  DualFlowStatusBar,
  type LineViewMode,
} from "./dual-flow-status-bar";
import { KpiRibbon } from "./kpi-ribbon";
import { MachineCommandGrid } from "./machine-command-grid";
import { OperationsPulseStrip } from "./operations-pulse-strip";
import { CommandCenterProductionAnswers } from "./command-center-production-answers";
import { ProductionManagerWidget } from "./widgets/production-manager-widget";

const LINE_VIEW_KEY = "luma-floor-line-view";

type Props = {
  mode: FloorBoardMode;
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  managerSnapshot: FloorManagerSnapshot;
  actNowItems: ActNowItem[];
  widgetData: WidgetGridData;
  pauseReasons: PauseReasonRow[];
  onModeChange: (mode: FloorBoardMode) => void;
  onOpenBriefing?: () => void;
  liveStatus: FloorLiveStatus;
  lastUpdatedAt: number | null;
  enlarged?: boolean;
};

function resolveDisplayLine(
  lineView: LineViewMode,
  inferred: ReturnType<typeof primaryLineForRows>,
) {
  if (lineView === "card_route") return CARD_PRODUCTION_LINE;
  if (lineView === "bottle_route") return BOTTLE_PRODUCTION_LINE;
  return inferred;
}

export function CommandCenterView({
  mode,
  shiftStatus,
  kpiData,
  managerSnapshot,
  actNowItems,
  widgetData,
  pauseReasons,
  onModeChange,
  onOpenBriefing,
  liveStatus,
  lastUpdatedAt,
  enlarged = false,
}: Props) {
  const isTv = mode === "tv";
  const isLead = mode === "lead";
  const isManager = mode === "manager";
  const isOwner = mode === "owner";
  const showManagerChrome = isManager || isOwner;
  const [metricsOpen, setMetricsOpen] = useState(isManager);
  const [tablesOpen, setTablesOpen] = useState(false);
  const [lineView, setLineView] = useState<LineViewMode>("auto");

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(LINE_VIEW_KEY);
      if (
        saved === "auto" ||
        saved === "card_route" ||
        saved === "bottle_route" ||
        saved === "both"
      ) {
        setLineView(saved);
      }
    } catch {
      /* private mode */
    }
  }, []);

  const setLineViewPersist = (next: LineViewMode) => {
    setLineView(next);
    try {
      sessionStorage.setItem(LINE_VIEW_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const inferredLine = useMemo(
    () => primaryLineForRows(managerSnapshot.stationCommandRows),
    [managerSnapshot.stationCommandRows],
  );

  const displayLine = useMemo(
    () => resolveDisplayLine(lineView, inferredLine),
    [lineView, inferredLine],
  );

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
        displayLine={displayLine}
        liveStatus={liveStatus}
        lastUpdatedAt={lastUpdatedAt}
        {...(isLead || isTv ? { snapshot: managerSnapshot } : {})}
      />

      <KpiRibbon
        shiftStatus={shiftStatus}
        kpiData={kpiData}
        plant={managerSnapshot.plant}
        dataGaps={managerSnapshot.dataGaps}
        throughputPoints={widgetData.throughputPoints}
      />

      <DualFlowStatusBar
        rows={managerSnapshot.stationCommandRows}
        lineView={lineView}
        onLineViewChange={setLineViewPersist}
      />

      {showManagerChrome && (
        <>
          <OperationsPulseStrip snapshot={managerSnapshot} />
          <CommandCenterProductionAnswers snapshot={managerSnapshot} />
          <button
            type="button"
            onClick={() => setMetricsOpen((v) => !v)}
            className="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0a0d12] px-4 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300"
          >
            <span>Charts & downtime</span>
            {metricsOpen ? (
              <ChevronUp size={14} aria-hidden />
            ) : (
              <ChevronDown size={14} aria-hidden />
            )}
          </button>
          {metricsOpen && (
            <div className="max-h-[28vh] shrink-0 overflow-y-auto border-b border-white/[0.06]">
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
          displayLine={displayLine}
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

      {tablesOpen && (
        <div className="max-h-[32vh] shrink-0 overflow-y-auto border-t border-white/[0.06] bg-[#07090d]">
          <ProductionManagerWidget snapshot={managerSnapshot} compact />
        </div>
      )}

      {(isLead || isManager) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] bg-[#0a0d12] px-3 py-1.5">
          <div className="flex items-center gap-2">
            {lineView !== "auto" && (
              <button
                type="button"
                onClick={() => setLineViewPersist("auto")}
                className="text-[10px] font-semibold uppercase tracking-wider text-sky-400 hover:text-sky-300"
              >
                ← Auto line
              </button>
            )}
            {onOpenBriefing && (
              <button
                type="button"
                onClick={onOpenBriefing}
                className="text-[10px] text-slate-500 hover:text-amber-300"
              >
                Full briefing →
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setTablesOpen((v) => !v)}
            className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300"
          >
            {tablesOpen ? "Hide shift tables" : "Shift tables ↓"}
          </button>
        </div>
      )}
    </div>
  );
}
