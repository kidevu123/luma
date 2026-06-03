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
