// Confidence pill — semantic-token palette (good/warn/crit/muted)
// reads cleanly on both light admin surfaces and the dark floor-board.
// Filled chip (solid light bg + dark text) beats translucent tints for
// accessibility on any background.

import { cn } from "@/lib/utils";
import type { Confidence } from "@/lib/production/types";

const STYLES: Record<Confidence, string> = {
  HIGH:    "bg-good-50 text-good-700 border-good-500/40",
  MEDIUM:  "bg-warn-50 text-warn-700 border-warn-500/40",
  LOW:     "bg-crit-50 text-crit-700 border-crit-500/40",
  MISSING: "bg-muted-50 text-muted-700 border-muted-500/40",
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
