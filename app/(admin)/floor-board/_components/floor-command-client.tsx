// app/(admin)/floor-board/_components/floor-command-client.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, Edit2 } from "lucide-react";
import {
  DEFAULT_LAYOUT,
  WIDGET_CATALOG,
  type WidgetKey,
  type WidgetLayout,
} from "@/lib/floor-command/types";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { ActNowItem } from "@/lib/floor-command/act-now";
import type { FloorBoardMode } from "@/lib/floor-command/floor-board-mode";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import { ProductionIntelligenceStrip } from "./production-intelligence-strip";
import { ProductionManagerWidget } from "./widgets/production-manager-widget";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { WidgetGrid, type WidgetGridData } from "./widget-grid";
import { WidgetPicker } from "./widget-picker";
import { stageKeyToMetricsLane } from "@/lib/floor-command/metrics-links";
import { MetricsQuickLinks } from "./metrics-quick-links";
import { OwnerPulseStrip } from "./owner-pulse-strip";
import { ActNowPanel } from "./act-now-panel";
import { TvRotationPanel } from "./tv-rotation-panel";
import { CommandCenterView } from "./command-center-view";
import { OperationsBriefingPanel } from "./operations-briefing-panel";
import type { PauseReasonRow } from "../_loaders";

type Props = {
  mode: FloorBoardMode;
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  productionIntelligence: FloorProductionIntelligence;
  managerSnapshot: FloorManagerSnapshot;
  actNowItems: ActNowItem[];
  widgetData: WidgetGridData;
  savedLayout: WidgetLayout[];
  pauseReasons: PauseReasonRow[];
};

export function FloorCommandClient({
  mode,
  shiftStatus,
  kpiData,
  productionIntelligence,
  managerSnapshot,
  actNowItems,
  widgetData,
  savedLayout,
  pauseReasons,
}: Props) {
  const router = useRouter();
  const isTv = mode === "tv";
  const isOwner = mode === "owner";
  const isManager = mode === "manager";

  const [layout, setLayout] = useState<WidgetLayout[]>(
    savedLayout.length > 0 ? savedLayout : DEFAULT_LAYOUT,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(isManager);
  const [showMap, setShowMap] = useState(false);
  const [showBriefing, setShowBriefing] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDetailsOpen(isManager);
    setShowMap(false);
    setShowBriefing(false);
  }, [mode, isManager]);

  useEffect(() => {
    const es = new EventSource("/api/floor-board/stream");
    const handler = () => router.refresh();
    es.addEventListener("floor", handler);
    return () => {
      es.removeEventListener("floor", handler);
      es.close();
    };
  }, [router]);

  const saveLayout = useCallback((next: WidgetLayout[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      fetch("/api/dashboard-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: next }),
      }).catch(console.error);
    }, 800);
  }, []);

  const handleLayoutChange = useCallback(
    (next: WidgetLayout[]) => {
      setLayout(next);
      saveLayout(next);
    },
    [saveLayout],
  );

  const handleAddWidget = useCallback(
    (key: WidgetKey) => {
      const def = WIDGET_CATALOG.find((w) => w.key === key);
      if (!def) return;
      const next: WidgetLayout[] = [
        ...layout,
        { key, x: 0, y: 9999, w: def.defaultW, h: def.defaultH },
      ];
      setLayout(next);
      saveLayout(next);
    },
    [layout, saveLayout],
  );

  const handleRemoveWidget = useCallback(
    (key: WidgetKey) => {
      const next = layout.filter((w) => w.key !== key);
      setLayout(next);
      saveLayout(next);
    },
    [layout, saveLayout],
  );

  const setMode = (next: FloorBoardMode) => {
    const url = new URL(window.location.href);
    if (next === "lead") url.searchParams.delete("mode");
    else url.searchParams.set("mode", next);
    router.push(url.pathname + url.search);
  };

  const rootClass = useMemo(
    () =>
      [
        "flex flex-col h-full min-h-0 bg-slate-950 text-slate-100 overflow-hidden",
        isTv ? "text-lg" : "",
      ].join(" "),
    [isTv],
  );

  const metricsLane = useMemo(() => {
    const sk = productionIntelligence.bottleneck.stageKey;
    if (sk.confidence === "MISSING" || typeof sk.value !== "string") return null;
    return stageKeyToMetricsLane(sk.value);
  }, [productionIntelligence.bottleneck.stageKey]);

  const showCommandCenter = !showMap && !showBriefing;

  return (
    <div className={rootClass}>
      {showBriefing ? (
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] shrink-0">
            <button
              type="button"
              onClick={() => setShowBriefing(false)}
              className="text-[11px] px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"
            >
              ← Command center
            </button>
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">
              Operations briefing
            </span>
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto min-h-0">
              <OperationsBriefingPanel snapshot={managerSnapshot} />
            </div>
            {!isTv && <ActNowPanel items={actNowItems} />}
          </div>
        </div>
      ) : showCommandCenter ? (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <CommandCenterView
              mode={mode}
              shiftStatus={shiftStatus}
              kpiData={kpiData}
              managerSnapshot={managerSnapshot}
              actNowItems={actNowItems}
              widgetData={widgetData}
              pauseReasons={pauseReasons}
              onModeChange={setMode}
              enlarged={isTv}
            />
          </div>
          {isTv && (
            <div className="w-[min(42%,400px)] shrink-0 min-h-0 border-l border-white/10">
              <TvRotationPanel
                shiftStatus={shiftStatus}
                actNowItems={actNowItems}
                intelligence={productionIntelligence}
                throughputPoints={widgetData.throughputPoints}
              />
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-slate-950 shrink-0">
            <button
              type="button"
              onClick={() => setShowMap(false)}
              className="text-[11px] px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"
            >
              ← Command center
            </button>
            {!isTv && (
              <div className="ml-auto flex items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowPicker((p) => !p)}
                      className="text-[11px] text-sky-400 border border-sky-500/40 px-2 py-1 rounded hover:bg-sky-500/10"
                    >
                      + Widget
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditing(false);
                        setShowPicker(false);
                      }}
                      className="flex items-center gap-1 text-[11px] text-emerald-400 border border-emerald-500/40 px-2 py-1 rounded"
                    >
                      <Check size={11} />
                      Done
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsEditing(true)}
                    className="flex items-center gap-1 text-[11px] text-slate-500 border border-white/10 px-2 py-1 rounded hover:text-slate-300"
                  >
                    <Edit2 size={11} />
                    Layout
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto min-h-0">
              <WidgetGrid
                layout={layout}
                onLayoutChange={handleLayoutChange}
                data={widgetData}
                isEditing={isEditing}
                onRemoveWidget={handleRemoveWidget}
              />
            </div>
          </div>
        </>
      )}

      {!isTv && showCommandCenter && (
        <div className="flex items-center justify-end gap-3 px-3 py-1 border-t border-white/[0.06] bg-slate-950/90 shrink-0">
          <button
            type="button"
            onClick={() => setShowBriefing(true)}
            className="text-[11px] text-slate-500 hover:text-amber-300 transition-colors"
          >
            Full operations briefing →
          </button>
          <button
            type="button"
            onClick={() => setShowMap(true)}
            className="text-[11px] text-slate-500 hover:text-sky-300 transition-colors"
          >
            Floor map & widgets →
          </button>
        </div>
      )}

      {!isTv && (
        <OwnerPulseStrip snapshot={managerSnapshot} emphasized={isOwner} />
      )}

      {!isTv && (
        <div className="flex-shrink-0 border-t border-white/10 bg-slate-950">
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03]"
            aria-expanded={detailsOpen}
          >
            <span className="text-[11px] font-medium text-slate-400">
              Production details
              <span className="text-slate-600 font-normal ml-2">
                machines · scans · yield
              </span>
            </span>
            {detailsOpen ? (
              <ChevronUp size={14} className="text-slate-500" aria-hidden />
            ) : (
              <ChevronDown size={14} className="text-slate-500" aria-hidden />
            )}
          </button>
          {detailsOpen && (
            <div className="h-[min(34vh,300px)] border-t border-white/10 overflow-hidden">
              <ProductionManagerWidget snapshot={managerSnapshot} compact />
            </div>
          )}
        </div>
      )}

      {!isTv && showMap && <MetricsQuickLinks lane={metricsLane} />}

      {!showCommandCenter && (
        <div className="flex-shrink-0 border-t border-white/10">
          {(showMap || isManager) && (
            <ProductionIntelligenceStrip data={productionIntelligence} />
          )}
        </div>
      )}
      {showPicker && (
        <WidgetPicker
          currentLayout={layout}
          onAdd={handleAddWidget}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
