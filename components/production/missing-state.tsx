// Inline empty-state strip — surfaces label + missingInputs with
// system tokens so it reads on both light admin cards and dark surfaces.

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
        "rounded-xl border border-dashed border-border/70 bg-surface-2/40 p-4 text-sm text-text-muted leading-relaxed",
        className,
      )}
    >
      <div className="font-medium text-text">
        {metric.label ?? fallback}
      </div>
      {metric.missingInputs.length > 0 && (
        <div className="mt-1 text-[11px] text-text-subtle">
          missing inputs: {metric.missingInputs.join(", ")}
        </div>
      )}
      {metric.explanation && (
        <div className="mt-1 text-[11px] text-text-subtle">
          {metric.explanation}
        </div>
      )}
    </div>
  );
}
