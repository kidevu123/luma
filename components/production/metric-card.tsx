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
  variant = "dark",
  showConfidence = true,
}: {
  label: string;
  metric: MetricResult;
  className?: string;
  hint?: string;
  size?: "sm" | "md" | "lg";
  variant?: "dark" | "light";
  /** Floor board hides per-card LIVE chips — one live indicator per strip is enough. */
  showConfidence?: boolean;
}) {
  const isMissing = metric.confidence === "MISSING";
  const valueText = formatValue(metric);
  const unit = metric.unit ?? "";

  const isLight = variant === "light";

  const containerClass = isLight
    ? "rounded-md border border-border bg-surface px-3 py-2.5"
    : cn(
        "rounded-md border bg-slate-900/60 border-slate-700/60 px-3 py-2.5",
        "shadow-[inset_0_1px_0_0_rgb(148_163_184_/_0.05)]",
      );

  const labelClass = isLight
    ? "text-[10px] uppercase tracking-[0.10em] text-text-subtle leading-tight"
    : "text-[10px] uppercase tracking-[0.10em] text-slate-400 leading-tight";

  const valueClass = cn(
    "font-mono tabular-nums tracking-tight",
    isLight
      ? isMissing ? "text-text-muted" : "text-text-strong"
      : isMissing ? "text-slate-400" : "text-slate-50",
    size === "sm" && "text-lg",
    size === "md" && "text-2xl",
    size === "lg" && "text-3xl",
  );

  const missingLabelClass = isLight ? "text-sm text-text-muted leading-tight" : "text-sm text-slate-300 leading-tight";
  const unitClass = isLight ? "text-xs text-text-muted truncate" : "text-xs text-slate-400 truncate";
  const hintClass = isLight ? "mt-1 text-[10px] text-text-subtle leading-tight line-clamp-2" : "mt-1 text-[10px] text-slate-500 leading-tight line-clamp-2";
  const missingInputsClass = isLight ? "mt-1 text-[10px] text-text-subtle leading-tight" : "mt-1 text-[10px] text-slate-500 leading-tight";

  return (
    <div className={cn(containerClass, className)}>
      <div className="flex items-start justify-between gap-2">
        <div className={labelClass}>{label}</div>
        {showConfidence && <ConfidenceBadge confidence={metric.confidence} />}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
        {isMissing ? (
          <div className={missingLabelClass}>{metric.label ?? "—"}</div>
        ) : (
          <>
            <div className={valueClass}>{valueText}</div>
            {unit && <div className={unitClass}>{unit}</div>}
          </>
        )}
      </div>
      {(metric.explanation || hint) && !isMissing && (
        <div className={hintClass}>{metric.explanation ?? hint}</div>
      )}
      {isMissing && metric.missingInputs.length > 0 && (
        <div className={missingInputsClass}>missing: {metric.missingInputs.join(", ")}</div>
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
