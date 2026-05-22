// PRODUCT-MAP-2 — Pure helpers for product floor-readiness classification.
// Used by the product detail page (display) and product-mapping.test.ts.
// No DB calls; pure functions so they are trivially testable.

export type FloorReadinessLevel = "ready" | "no-tablet-mapping" | "inactive";

export function floorReadinessLevel({
  isActive,
  tabletMappingCount,
}: {
  isActive: boolean;
  tabletMappingCount: number;
}): FloorReadinessLevel {
  if (!isActive) return "inactive";
  if (tabletMappingCount === 0) return "no-tablet-mapping";
  return "ready";
}

export function floorReadinessLabel(level: FloorReadinessLevel): string {
  switch (level) {
    case "ready":
      return "Ready for floor selection";
    case "no-tablet-mapping":
      return "Missing tablet mapping — floor selection unavailable";
    case "inactive":
      return "Inactive — cannot be assigned to new production runs";
  }
}
