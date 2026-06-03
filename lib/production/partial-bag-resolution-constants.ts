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

/** Human label for endingBalanceSource on allocation sessions. */
export function labelPartialBagEndingBalanceSource(
  source: string | null | undefined,
): string | null {
  if (!source) return null;
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
