// Standard renderer for a MetricResult. Honest by default — a
// MISSING result shows the canonical empty-state label; a numeric
// result shows the value + unit + confidence pill.
//
// React-side rules (no exceptions):
//  • This component MUST NOT compute any number. Inputs come from
//    lib/production/metrics.ts. We format only.
//  • Zero is rendered as "0" with a HIGH/zero label, not as
//    Insufficient data.
//  • MISSING never shows a numeric value.

import { cn } from "@/lib/utils";
import type { MetricResult } from "@/lib/production/types";
import { ConfidenceBadge } from "./confidence-badge";

export function MetricCard({
  label,
  metric,
  className,
  hint,
  size = "md",
}: {
  label: string;
  metric: MetricResult;
  className?: string;
  hint?: string;
  size?: "sm" | "md" | "lg";
}) {
  const isMissing = metric.confidence === "MISSING";
  const valueText = formatValue(metric);
  const unit = metric.unit ?? "";
  const valueClass = cn(
    "font-mono tabular-nums tracking-tight",
    isMissing ? "text-slate-400" : "text-slate-50",
    size === "sm" && "text-lg",
    size === "md" && "text-2xl",
    size === "lg" && "text-3xl",
  );
  return (
    <div
      className={cn(
        "rounded-md border bg-slate-900/60 border-slate-700/60 px-3 py-2.5",
        "shadow-[inset_0_1px_0_0_rgb(148_163_184_/_0.05)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.10em] text-slate-400 leading-tight">
          {label}
        </div>
        <ConfidenceBadge confidence={metric.confidence} />
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
        {isMissing ? (
          <div className="text-sm text-slate-300 leading-tight">
            {metric.label ?? "—"}
          </div>
        ) : (
          <>
            <div className={valueClass}>{valueText}</div>
            {unit && (
              <div className="text-xs text-slate-400 truncate">{unit}</div>
            )}
          </>
        )}
      </div>
      {(metric.explanation || hint) && !isMissing && (
        <div className="mt-1 text-[10px] text-slate-500 leading-tight line-clamp-2">
          {metric.explanation ?? hint}
        </div>
      )}
      {isMissing && metric.missingInputs.length > 0 && (
        <div className="mt-1 text-[10px] text-slate-500 leading-tight">
          missing: {metric.missingInputs.join(", ")}
        </div>
      )}
    </div>
  );
}

function formatValue(m: MetricResult): string {
  if (m.value == null) return "—";
  if (typeof m.value === "string") return m.value;
  if (Number.isInteger(m.value)) return m.value.toLocaleString();
  return Number(m.value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}
