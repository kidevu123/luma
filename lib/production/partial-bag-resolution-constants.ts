// Shared constants for partial bag admin resolution (client-safe).

export const PARTIAL_BAG_RESOLUTION_METHODS = [
  "PHYSICAL_COUNT",
  "WEIGH_BACK",
  "SUPERVISOR_ESTIMATE",
] as const;

export type PartialBagResolutionMethod =
  (typeof PARTIAL_BAG_RESOLUTION_METHODS)[number];

export const PARTIAL_BAG_RESOLUTION_METHOD_LABELS: Record<
  PartialBagResolutionMethod,
  string
> = {
  PHYSICAL_COUNT: "Physical tablet count",
  WEIGH_BACK: "Weigh-back",
  SUPERVISOR_ESTIMATE: "Supervisor estimate",
};

export const MIN_SUPERVISOR_ESTIMATE_NOTE_LENGTH = 10;

export function confidenceForResolutionMethod(
  method: PartialBagResolutionMethod,
): "LOW" | "MEDIUM" | "HIGH" {
  switch (method) {
    case "SUPERVISOR_ESTIMATE":
      return "LOW";
    case "WEIGH_BACK":
      return "MEDIUM";
    case "PHYSICAL_COUNT":
      return "MEDIUM";
    default: {
      const _exhaustive: never = method;
      return _exhaustive;
    }
  }
}

// ── Honest remaining-quantity display (client-safe) ─────────────────
//
// No fake precision: a supervisor estimate shows as "~1,220 (supervisor
// estimate)", an unknown shows as "Unknown — closeout required". Only a
// counted/weighed (HIGH) value renders as a plain number.

export function formatRemainingEstimate(args: {
  remainingEstimate: number | null;
  confidence: string | null;
  source: string | null;
}): string {
  const { remainingEstimate, confidence, source } = args;
  if (remainingEstimate == null) return "Unknown — closeout required";
  const n = remainingEstimate.toLocaleString();
  // SPLIT-BAG-1: a system-derived (from production output) remaining is NOT a
  // physical count — always label it as such, even at HIGH confidence, so it is
  // never displayed as a bare authoritative number.
  if (source === "OUTPUT_DERIVED") return `~${n} (system-derived from production)`;
  if (confidence === "HIGH") return n;
  const sourceLabel =
    source === "SUPERVISOR_ESTIMATE"
      ? "supervisor estimate"
      : source === "OPERATOR_ESTIMATE"
        ? "operator estimate"
        : source === "WEIGH_BACK"
          ? "weigh-back"
          : source === "PHYSICAL_COUNT"
            ? "counted"
            : confidence === "MEDIUM"
              ? "estimate"
              : "low confidence";
  return `~${n} (${sourceLabel})`;
}

/** Operator-entered remaining ESTIMATE display (client-safe). Always rendered
 *  as an explicit, non-authoritative estimate so it can never be mistaken for
 *  the system-calculated remaining. Returns null when there is no estimate. */
export function formatOperatorRemainingEstimate(
  estimate: number | null | undefined,
): string | null {
  if (estimate == null) return null;
  return `~${estimate.toLocaleString()} (operator estimate)`;
}

/** Human label for endingBalanceSource on allocation sessions. */
export function labelPartialBagEndingBalanceSource(
  source: string | null | undefined,
): string | null {
  if (!source) return null;
  if (source === "OUTPUT_DERIVED") return "system-derived from production";
  if (source in PARTIAL_BAG_RESOLUTION_METHOD_LABELS) {
    return PARTIAL_BAG_RESOLUTION_METHOD_LABELS[
      source as PartialBagResolutionMethod
    ];
  }
  return source.replace(/_/g, " ").toLowerCase();
}

/** Confidence badge label for partial-bags table. */
export function labelPartialBagConfidence(
  confidence: string | null | undefined,
): string | null {
  if (!confidence) return null;
  switch (confidence) {
    case "LOW":
      return "Low confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "HIGH":
      return "High confidence";
    case "MISSING":
      return "Missing confidence";
    default:
      return confidence;
  }
}
