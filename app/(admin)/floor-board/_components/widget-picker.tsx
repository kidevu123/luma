// app/(admin)/floor-board/_components/widget-picker.tsx
// STUB — full implementation lands in Task 13.
"use client";

import type { WidgetKey, WidgetLayout } from "@/lib/floor-command/types";

type Props = {
  currentLayout: WidgetLayout[];
  onAdd: (key: WidgetKey) => void;
  onClose: () => void;
};

export function WidgetPicker(_props: Props) {
  // TODO(Task 13): implement widget picker panel
  return null;
}
