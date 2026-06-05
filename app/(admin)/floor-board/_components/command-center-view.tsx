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
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { WidgetGridData } from "./widget-grid";
import type { PauseReasonRow } from "../_loaders";
import { useEffect, useMemo, useState } from "react";
import { ActNowPanel } from "./act-now-panel";
import { CommandCenterHeader } from "./command-center-header";
import {
  DualFlowStatusBar,
  type LineViewMode,
} from "./dual-flow-status-bar";
import { MachineCommandGrid } from "./machine-command-grid";
import { CompactShiftStrip } from "./compact-shift-strip";
import { CommandCenterProductionAnswers } from "./command-center-production-answers";
import { KpiRibbon } from "./kpi-ribbon";
import { PackOutHero } from "./pack-out-hero";
import { QueueWipRail } from "./queue-wip-rail";
import { ShiftDeck, type ShiftDeckTabId } from "./shift-deck";
import { TrendsPanel } from "./trends-drawer";

const LINE_VIEW_KEY = "luma-floor-line-view";

type Props = {
  mode: FloorBoardMode;
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  productionIntelligence: FloorProductionIntelligence;
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
  if (lineView === "both") return inferred;
  return inferred;
}

export function CommandCenterView({
  mode,
  shiftStatus,
  kpiData,
  productionIntelligence,
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
  const [deckOpen, setDeckOpen] = useState(isManager);
  const [trendsOpen, setTrendsOpen] = useState(isManager);
  const [deckTab, setDeckTab] = useState<ShiftDeckTabId>("machines");
  const [lineView, setLineView] = useState<LineViewMode>("auto");

  useEffect(() => {
    setDeckOpen(isManager);
    setTrendsOpen(isManager);
  }, [isManager]);

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

  const openStagingDeck = () => {
    setDeckTab("staging");
    setDeckOpen(true);
  };

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
        lineView={lineView}
        liveStatus={liveStatus}
        lastUpdatedAt={lastUpdatedAt}
        compact
        {...(isLead || isTv ? { snapshot: managerSnapshot } : {})}
      />

      <CompactShiftStrip
        activity={managerSnapshot.shiftActivity}
        snapshot={managerSnapshot}
        intelligence={productionIntelligence}
      />

      {isManager && (
        <>
          <KpiRibbon
            shiftStatus={shiftStatus}
            kpiData={kpiData}
            plant={managerSnapshot.plant}
            dataGaps={managerSnapshot.dataGaps}
            throughputPoints={widgetData.throughputPoints}
            showQuality
          />
          <PackOutHero
            intelligence={productionIntelligence}
            snapshot={managerSnapshot}
            kpiData={kpiData}
            liveStatus={liveStatus}
            lastUpdatedAt={lastUpdatedAt}
          />
        </>
      )}

      <DualFlowStatusBar
        rows={managerSnapshot.stationCommandRows}
        lineView={lineView}
        onLineViewChange={setLineViewPersist}
        queueRail={
          <QueueWipRail
            intelligence={productionIntelligence}
            onSelect={openStagingDeck}
          />
        }
      />

      {isManager && (
        <CommandCenterProductionAnswers snapshot={managerSnapshot} />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <MachineCommandGrid
          rows={managerSnapshot.stationCommandRows}
          displayLine={displayLine}
          lineView={lineView}
          onLineViewChange={setLineViewPersist}
          fillViewport
          dense={isLead || isTv}
        />
        {!isTv && (
          <aside
            className="flex w-[min(100%,240px)] shrink-0 flex-col border-l border-amber-500/20 bg-[#0b0e14]"
            aria-label="Andon"
          >
            <header className="shrink-0 border-b border-amber-500/25 bg-amber-500/[0.06] px-2 py-1.5">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
                Andon
              </h2>
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ActNowPanel items={actNowItems} compact hideHeader />
            </div>
          </aside>
        )}
      </div>

      {trendsOpen && !isTv && isManager && (
        <TrendsPanel
          throughputPoints={widgetData.throughputPoints}
          targetBagsPerHour={widgetData.targetBagsPerHour}
          queues={widgetData.queues}
          pauseReasons={pauseReasons}
          dataGaps={managerSnapshot.dataGaps}
        />
      )}

      {deckOpen && !isTv && (
        <ShiftDeck
          key={deckTab}
          snapshot={managerSnapshot}
          queues={widgetData.queues}
          pauseReasons={pauseReasons}
          defaultTab={deckTab}
        />
      )}

      {!isTv && (isLead || isManager) && (
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-white/[0.06] bg-[#0a0d12] px-3 py-1">
          {onOpenBriefing && (
            <button
              type="button"
              onClick={onOpenBriefing}
              className="text-[10px] text-slate-500 hover:text-amber-300"
            >
              Full briefing →
            </button>
          )}
          {isManager && (
            <button
              type="button"
              onClick={() => setTrendsOpen((v) => !v)}
              className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300"
            >
              {trendsOpen ? "Hide trends" : "Trends ↓"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDeckOpen((v) => !v)}
            className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300"
          >
            {deckOpen ? "Hide tables" : "Tables ↓"}
          </button>
        </div>
      )}
    </div>
  );
}
