// app/(admin)/floor-board/_components/floor-command-client.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, Edit2 } from "lucide-react";
import {
  DEFAULT_LAYOUT,
  WIDGET_CATALOG,
  type WidgetKey,
  type WidgetLayout,
} from "@/lib/floor-command/types";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { KpiStripData } from "@/lib/production/floor-command";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import { StatusBar } from "./status-bar";
import { KpiStrip } from "./kpi-strip";
import { ProductionIntelligenceStrip } from "./production-intelligence-strip";
import { ProductionManagerWidget } from "./widgets/production-manager-widget";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { WidgetGrid, type WidgetGridData } from "./widget-grid";
import { WidgetPicker } from "./widget-picker";

type Props = {
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  productionIntelligence: FloorProductionIntelligence;
  managerSnapshot: FloorManagerSnapshot;
  widgetData: WidgetGridData;
  savedLayout: WidgetLayout[];
};

export function FloorCommandClient({
  shiftStatus,
  kpiData,
  productionIntelligence,
  managerSnapshot,
  widgetData,
  savedLayout,
}: Props) {
  const router = useRouter();
  const [layout, setLayout] = useState<WidgetLayout[]>(
    savedLayout.length > 0 ? savedLayout : DEFAULT_LAYOUT,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleDoneEditing = () => {
    setIsEditing(false);
    setShowPicker(false);
  };

  const wipCount = managerSnapshot.plant.bagsInFlow;

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <StatusBar data={shiftStatus} />
        </div>
        <div className="px-3 flex-shrink-0">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPicker((p) => !p)}
                className="text-[11px] text-sky-400 border border-sky-500/40 px-2 py-1 rounded hover:bg-sky-500/10"
              >
                + Add Widget
              </button>
              <button
                type="button"
                onClick={handleDoneEditing}
                className="flex items-center gap-1 text-[11px] text-emerald-400 border border-emerald-500/40 px-2 py-1 rounded hover:bg-emerald-500/10"
              >
                <Check size={11} />
                Done
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-1 text-[11px] text-slate-500 border border-white/10 px-2 py-1 rounded hover:text-slate-300 hover:border-white/20"
            >
              <Edit2 size={11} />
              Edit Layout
            </button>
          )}
        </div>
      </div>

      {/* Primary: floor map, queues, throughput */}
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
        {isEditing && showPicker && (
          <WidgetPicker
            currentLayout={layout}
            onAdd={handleAddWidget}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>

      {/* Optional: machines / scans / yield (collapsed by default) */}
      <div className="flex-shrink-0 border-t border-white/10 bg-slate-950">
        <button
          type="button"
          onClick={() => setDetailsOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03] transition-colors"
          aria-expanded={detailsOpen}
        >
          <span className="text-[11px] font-medium text-slate-400">
            Production details
            <span className="text-slate-600 font-normal ml-2">
              machines · station scans · material yield
              {wipCount > 0 && (
                <span className="text-slate-500"> · {wipCount} WIP</span>
              )}
            </span>
          </span>
          {detailsOpen ? (
            <ChevronUp size={14} className="text-slate-500 shrink-0" aria-hidden />
          ) : (
            <ChevronDown size={14} className="text-slate-500 shrink-0" aria-hidden />
          )}
        </button>
        {detailsOpen && (
          <div className="h-[min(36vh,320px)] border-t border-white/10 overflow-hidden">
            <ProductionManagerWidget snapshot={managerSnapshot} compact />
          </div>
        )}
      </div>

      <ProductionIntelligenceStrip data={productionIntelligence} />
      <KpiStrip data={kpiData} />
    </div>
  );
}
