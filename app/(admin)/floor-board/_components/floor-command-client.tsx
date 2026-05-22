// app/(admin)/floor-board/_components/floor-command-client.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Edit2 } from "lucide-react";
import {
  DEFAULT_LAYOUT,
  WIDGET_CATALOG,
  type WidgetKey,
  type WidgetLayout,
} from "@/lib/floor-command/types";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { KpiStripData } from "@/lib/production/floor-command";
import { StatusBar } from "./status-bar";
import { KpiStrip } from "./kpi-strip";
import { WidgetGrid, type WidgetGridData } from "./widget-grid";
import { WidgetPicker } from "./widget-picker";

// TODO(Task 15): reconcile WidgetGridData with widget-grid.tsx once Task 13 lands.
// If widget-grid.tsx doesn't export WidgetGridData, this re-export keeps page.tsx
// compiling in the meantime.
export type { WidgetGridData };

type Props = {
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  widgetData: WidgetGridData;
  savedLayout: WidgetLayout[];
};

export function FloorCommandClient({
  shiftStatus,
  kpiData,
  widgetData,
  savedLayout,
}: Props) {
  const router = useRouter();
  const [layout, setLayout] = useState<WidgetLayout[]>(
    savedLayout.length > 0 ? savedLayout : DEFAULT_LAYOUT,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SSE — re-fetch server data on any floor event
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

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Zone 1: Shift Status Bar */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="flex-1">
          <StatusBar data={shiftStatus} />
        </div>
        <div className="px-3 flex-shrink-0">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowPicker((p) => !p)}
                className="text-[11px] text-sky-400 border border-sky-500/40 px-2 py-1 rounded hover:bg-sky-500/10"
              >
                + Add Widget
              </button>
              <button
                onClick={handleDoneEditing}
                className="flex items-center gap-1 text-[11px] text-emerald-400 border border-emerald-500/40 px-2 py-1 rounded hover:bg-emerald-500/10"
              >
                <Check size={11} />
                Done
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-1 text-[11px] text-slate-500 border border-white/10 px-2 py-1 rounded hover:text-slate-300 hover:border-white/20"
            >
              <Edit2 size={11} />
              Edit Layout
            </button>
          )}
        </div>
      </div>

      {/* Zone 2: Configurable Widget Grid */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto">
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

      {/* Zone 3: KPI Strip */}
      <div className="flex-shrink-0">
        <KpiStrip data={kpiData} />
      </div>
    </div>
  );
}
