// app/(admin)/floor-board/_components/floor-command-client.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, Edit2, Monitor, User, Users } from "lucide-react";
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
import { StatusBar } from "./status-bar";
import { KpiStrip } from "./kpi-strip";
import { ProductionIntelligenceStrip } from "./production-intelligence-strip";
import { ProductionManagerWidget } from "./widgets/production-manager-widget";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { WidgetGrid, type WidgetGridData } from "./widget-grid";
import { WidgetPicker } from "./widget-picker";
import { stageKeyToMetricsLane } from "@/lib/floor-command/metrics-links";
import { ActNowPanel } from "./act-now-panel";
import { MetricsQuickLinks } from "./metrics-quick-links";
import { OwnerPulseStrip } from "./owner-pulse-strip";
import { TvRotationPanel } from "./tv-rotation-panel";
import { OperationsBriefingPanel } from "./operations-briefing-panel";

type Props = {
  mode: FloorBoardMode;
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  productionIntelligence: FloorProductionIntelligence;
  managerSnapshot: FloorManagerSnapshot;
  actNowItems: ActNowItem[];
  widgetData: WidgetGridData;
  savedLayout: WidgetLayout[];
};

const MODE_OPTIONS: Array<{ id: FloorBoardMode; label: string; icon: typeof Users }> = [
  { id: "lead", label: "Lead", icon: Users },
  { id: "manager", label: "Manager", icon: User },
  { id: "owner", label: "Owner", icon: User },
  { id: "tv", label: "TV", icon: Monitor },
];

export function FloorCommandClient({
  mode,
  shiftStatus,
  kpiData,
  productionIntelligence,
  managerSnapshot,
  actNowItems,
  widgetData,
  savedLayout,
}: Props) {
  const router = useRouter();
  const isTv = mode === "tv";
  const isOwner = mode === "owner";

  const [layout, setLayout] = useState<WidgetLayout[]>(
    savedLayout.length > 0 ? savedLayout : DEFAULT_LAYOUT,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(mode === "manager");
  const [showMap, setShowMap] = useState(mode !== "lead");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDetailsOpen(mode === "manager");
    setShowMap(mode !== "lead");
  }, [mode]);

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
        "flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden",
        isTv ? "text-lg" : "",
      ].join(" "),
    [isTv],
  );

  const metricsLane = useMemo(() => {
    const sk = productionIntelligence.bottleneck.stageKey;
    if (sk.confidence === "MISSING" || typeof sk.value !== "string") return null;
    return stageKeyToMetricsLane(sk.value);
  }, [productionIntelligence.bottleneck.stageKey]);

  return (
    <div className={rootClass}>
      <div className="flex items-center gap-2 flex-shrink-0 border-b border-white/10">
        <div className={`flex-1 min-w-0 ${isTv ? "scale-105 origin-left" : ""}`}>
          <StatusBar data={shiftStatus} />
        </div>
        {!isTv && (
          <div className="flex items-center gap-1 px-2 shrink-0">
            {MODE_OPTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={[
                  "flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors",
                  mode === id
                    ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                    : "border-white/10 text-slate-500 hover:text-slate-300",
                ].join(" ")}
              >
                <Icon size={11} aria-hidden />
                {label}
              </button>
            ))}
          </div>
        )}
        {!isTv && (
          <div className="px-2 flex-shrink-0">
            {isEditing ? (
              <div className="flex items-center gap-2">
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
              </div>
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

      {!isTv && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-white/[0.06] bg-slate-950/80 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            Main view
          </span>
          <button
            type="button"
            onClick={() => setShowMap(false)}
            className={[
              "text-[11px] px-2.5 py-1 rounded border transition-colors",
              !showMap
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-white/10 text-slate-500 hover:text-slate-300",
            ].join(" ")}
          >
            Operations briefing
          </button>
          <button
            type="button"
            onClick={() => setShowMap(true)}
            className={[
              "text-[11px] px-2.5 py-1 rounded border transition-colors",
              showMap
                ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                : "border-white/10 text-slate-500 hover:text-slate-300",
            ].join(" ")}
          >
            Floor map & widgets
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto min-h-0">
          {isTv ? (
            <WidgetGrid
              layout={layout}
              onLayoutChange={handleLayoutChange}
              data={widgetData}
              isEditing={false}
              onRemoveWidget={handleRemoveWidget}
            />
          ) : showMap ? (
            <WidgetGrid
              layout={layout}
              onLayoutChange={handleLayoutChange}
              data={widgetData}
              isEditing={isEditing}
              onRemoveWidget={handleRemoveWidget}
            />
          ) : (
            <OperationsBriefingPanel snapshot={managerSnapshot} />
          )}
        </div>
        {!isTv && <ActNowPanel items={actNowItems} />}
        {isTv && (
          <div className="w-[min(42%,400px)] shrink-0 min-h-0">
            <TvRotationPanel
              shiftStatus={shiftStatus}
              actNowItems={actNowItems}
              intelligence={productionIntelligence}
              throughputPoints={widgetData.throughputPoints}
            />
          </div>
        )}
      </div>

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

      {!isTv && <MetricsQuickLinks lane={metricsLane} />}
      <div className={isTv ? "scale-110 origin-bottom" : ""}>
        {(isTv || showMap || mode === "manager") && (
          <ProductionIntelligenceStrip data={productionIntelligence} />
        )}
        {!isTv && <KpiStrip data={kpiData} />}
      </div>
    </div>
  );
}
