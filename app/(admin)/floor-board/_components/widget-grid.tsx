// app/(admin)/floor-board/_components/widget-grid.tsx
// STUB — full implementation lands in Task 13.
// WidgetGridData is defined here so floor-command-client.tsx can import it.
"use client";

import type {
  WidgetKey,
  WidgetLayout,
  StationWithLive,
  QueueHealthRow,
  OperatorDailyRow,
  ShiftTargetStatus,
  AttentionItem,
  ThroughputDataPoint,
} from "@/lib/floor-command/types";
import type { RecentEventRow } from "@/lib/production/floor-command";

export type WidgetGridData = {
  stations: StationWithLive[];
  queueHealth: QueueHealthRow[];
  operators: OperatorDailyRow[];
  recentEvents: RecentEventRow[];
  shiftTarget: ShiftTargetStatus;
  attentionItems: AttentionItem[];
  hourlyThroughput: ThroughputDataPoint[];
};

type Props = {
  layout: WidgetLayout[];
  onLayoutChange: (next: WidgetLayout[]) => void;
  data: WidgetGridData;
  isEditing: boolean;
  onRemoveWidget: (key: WidgetKey) => void;
};

export function WidgetGrid(_props: Props) {
  // TODO(Task 13): implement full react-grid-layout widget grid
  return null;
}
