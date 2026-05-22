// app/(admin)/floor-board/_components/widget-picker.tsx
"use client";

import { WIDGET_CATALOG, type WidgetKey, type WidgetLayout } from "@/lib/floor-command/types";
import { Plus, X } from "lucide-react";

export function WidgetPicker({
  currentLayout,
  onAdd,
  onClose,
}: {
  currentLayout: WidgetLayout[];
  onAdd: (key: WidgetKey) => void;
  onClose: () => void;
}) {
  const activeKeys = new Set(currentLayout.map((w) => w.key));

  return (
    <div className="flex flex-col w-64 bg-slate-800 border-l border-white/10 h-full overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-xs font-semibold text-slate-300">Add Widget</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1 p-2">
        {WIDGET_CATALOG.map((w) => {
          const isActive = activeKeys.has(w.key);
          return (
            <button
              key={w.key}
              onClick={() => !isActive && onAdd(w.key)}
              disabled={isActive}
              className={`flex items-start gap-2 p-2 rounded text-left transition-colors ${
                isActive
                  ? "opacity-40 cursor-not-allowed bg-slate-700/30"
                  : "hover:bg-slate-700/60 cursor-pointer"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-slate-300">{w.label}</div>
                <div className="text-[10px] text-slate-500 leading-snug">{w.description}</div>
              </div>
              {!isActive && <Plus size={12} className="text-slate-500 flex-shrink-0 mt-0.5" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
