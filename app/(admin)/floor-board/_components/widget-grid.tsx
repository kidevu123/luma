// app/(admin)/floor-board/_components/widget-grid.tsx
"use client";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useCallback } from "react";
import GridLayout, { type Layout, type LayoutItem, WidthProvider } from "react-grid-layout/legacy";
import { WIDGET_CATALOG, type WidgetKey, type WidgetLayout } from "@/lib/floor-command/types";
import type { QueueHealthRow, StationWithLive, OperatorDailyRow, ThroughputDataPoint } from "@/lib/floor-command/types";
import type { RecentEventRow } from "@/lib/production/floor-command";
import { FloorMapWidget } from "./widgets/floor-map-widget";
import { QueueHealthWidget } from "./widgets/queue-health-widget";
import { QualityWatchWidget } from "./widgets/quality-watch-widget";
import { ThroughputChartWidget } from "./widgets/throughput-chart-widget";
import { OperatorBoardWidget } from "./widgets/operator-board-widget";
import { MachineFocusWidget } from "./widgets/machine-focus-widget";
import { RecentEventsWidget } from "./widgets/recent-events-widget";
import { X, GripVertical } from "lucide-react";

export type WidgetGridData = {
  stations: StationWithLive[];
  queues: QueueHealthRow[];
  operators: OperatorDailyRow[];
  recentEvents: RecentEventRow[];
  throughputPoints: ThroughputDataPoint[];
  targetBagsPerHour: number | null;
};

const ResponsiveGridLayout = WidthProvider(GridLayout);

function WidgetShell({
  title,
  isEditing,
  onRemove,
  children,
}: {
  title: string;
  isEditing: boolean;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-slate-900 border border-white/10 rounded overflow-hidden">
      {isEditing && (
        <div className="flex items-center justify-between px-2 py-1 bg-slate-800 border-b border-white/10 cursor-grab active:cursor-grabbing">
          <div className="flex items-center gap-1 text-slate-500">
            <GripVertical size={12} />
            <span className="text-[10px]">{title}</span>
          </div>
          <button
            onClick={onRemove}
            className="text-slate-600 hover:text-red-400 transition-colors"
            aria-label={`Remove ${title} widget`}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function widgetTitle(key: WidgetKey): string {
  return WIDGET_CATALOG.find((w) => w.key === key)?.label ?? key;
}

function renderWidget(
  key: WidgetKey,
  config: WidgetLayout["config"],
  data: WidgetGridData,
  isEditing: boolean,
): React.ReactNode {
  switch (key) {
    case "floor-map":
      return <FloorMapWidget stations={data.stations} />;
    case "queue-health":
      return <QueueHealthWidget queues={data.queues} />;
    case "quality-watch":
      return <QualityWatchWidget events={data.recentEvents} />;
    case "throughput-chart":
      return (
        <ThroughputChartWidget
          data={data.throughputPoints}
          targetBagsPerHour={data.targetBagsPerHour}
        />
      );
    case "operator-board":
      return <OperatorBoardWidget operators={data.operators} />;
    case "machine-focus": {
      const station =
        data.stations.find((s) => s.id === config?.stationId) ?? null;
      return (
        <MachineFocusWidget
          station={station}
          stationId={config?.stationId}
          isEditing={isEditing}
        />
      );
    }
    case "recent-events":
      return <RecentEventsWidget events={data.recentEvents} />;
    default:
      return null;
  }
}

export function WidgetGrid({
  layout,
  onLayoutChange,
  data,
  isEditing,
  onRemoveWidget,
}: {
  layout: WidgetLayout[];
  onLayoutChange: (next: WidgetLayout[]) => void;
  data: WidgetGridData;
  isEditing: boolean;
  onRemoveWidget: (key: WidgetKey) => void;
}) {
  const glLayout: LayoutItem[] = layout.map((w) => ({
    i: w.key,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    minW: WIDGET_CATALOG.find((c) => c.key === w.key)?.minW ?? 2,
    minH: WIDGET_CATALOG.find((c) => c.key === w.key)?.minH ?? 2,
    isDraggable: isEditing,
    isResizable: isEditing,
  }));

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      if (!isEditing) return;
      const updated: WidgetLayout[] = layout.map((w) => {
        const item = newLayout.find((l) => l.i === w.key);
        if (!item) return w;
        return { ...w, x: item.x, y: item.y, w: item.w, h: item.h };
      });
      onLayoutChange(updated);
    },
    [layout, isEditing, onLayoutChange],
  );

  return (
    <ResponsiveGridLayout
      layout={glLayout}
      cols={12}
      rowHeight={60}
      margin={[8, 8]}
      containerPadding={[8, 8]}
      onLayoutChange={handleLayoutChange}
      isDraggable={isEditing}
      isResizable={isEditing}
      draggableHandle=".cursor-grab"
    >
      {layout.map((w) => (
        <div key={w.key}>
          <WidgetShell
            title={widgetTitle(w.key)}
            isEditing={isEditing}
            onRemove={() => onRemoveWidget(w.key)}
          >
            {renderWidget(w.key, w.config, data, isEditing)}
          </WidgetShell>
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
