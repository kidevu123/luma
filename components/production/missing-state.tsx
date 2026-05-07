// Inline empty-state strip — used by panels that need more than a
// MetricCard's compact label. Same vocabulary, same honesty:
// surface the label + missingInputs, nothing else.

import { cn } from "@/lib/utils";
import type { MetricResult } from "@/lib/production/types";

export function MissingState({
  metric,
  fallback = "No data",
  className,
}: {
  metric: MetricResult;
  fallback?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-400 leading-relaxed",
        className,
      )}
    >
      <div className="font-medium text-slate-300">
        {metric.label ?? fallback}
      </div>
      {metric.missingInputs.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-500">
          missing inputs: {metric.missingInputs.join(", ")}
        </div>
      )}
      {metric.explanation && (
        <div className="mt-1 text-[11px] text-slate-500">
          {metric.explanation}
        </div>
      )}
    </div>
  );
}
