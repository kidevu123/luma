// Confidence pill — every MetricResult gets one. Dark command-
// center palette: cyan border, subtle fill, semantic color per
// confidence level. The pill is intentionally compact (h-5) so a
// dense KPI strip can fit one per card without crowding.

import { cn } from "@/lib/utils";
import type { Confidence } from "@/lib/production/types";

const STYLES: Record<Confidence, string> = {
  HIGH:    "bg-emerald-500/10 text-emerald-300 border-emerald-500/40",
  MEDIUM:  "bg-amber-500/10 text-amber-200 border-amber-500/40",
  LOW:     "bg-orange-500/10 text-orange-200 border-orange-500/40",
  MISSING: "bg-slate-700/50 text-slate-400 border-slate-600/60",
};

const LABELS: Record<Confidence, string> = {
  HIGH: "live",
  MEDIUM: "partial",
  LOW: "estimated",
  MISSING: "no data",
};

export function ConfidenceBadge({
  confidence,
  className,
}: {
  confidence: Confidence;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider",
        STYLES[confidence],
        className,
      )}
      title={`Confidence: ${confidence}`}
    >
      {LABELS[confidence]}
    </span>
  );
}
