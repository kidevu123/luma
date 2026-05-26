export type ZohoReadinessLevel = "ready" | "partial" | "missing" | "inactive";

export type ZohoReadinessReason =
  | "no_unit_id"
  | "no_display_id"
  | "no_case_id";

export interface ZohoReadinessResult {
  level: ZohoReadinessLevel;
  reasons: ZohoReadinessReason[];
}

export function classifyProductZohoReadiness(product: {
  isActive: boolean;
  zohoItemIdUnit: string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase: string | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
}): ZohoReadinessResult {
  if (!product.isActive) return { level: "inactive", reasons: [] };

  const reasons: ZohoReadinessReason[] = [];

  if (!product.zohoItemIdUnit) reasons.push("no_unit_id");
  if ((product.unitsPerDisplay ?? 0) > 0 && !product.zohoItemIdDisplay)
    reasons.push("no_display_id");
  if ((product.displaysPerCase ?? 0) > 0 && !product.zohoItemIdCase)
    reasons.push("no_case_id");

  const requiredCount =
    1 +
    ((product.unitsPerDisplay ?? 0) > 0 ? 1 : 0) +
    ((product.displaysPerCase ?? 0) > 0 ? 1 : 0);

  const level: ZohoReadinessLevel =
    reasons.length === 0
      ? "ready"
      : reasons.length === requiredCount
        ? "missing"
        : "partial";

  return { level, reasons };
}

export function zohoReadinessLabel(level: ZohoReadinessLevel): string {
  switch (level) {
    case "ready":
      return "Ready for Zoho assembly operations";
    case "partial":
      return "Partially mapped — some Zoho item IDs missing";
    case "missing":
      return "Missing — Zoho assembly IDs not configured";
    case "inactive":
      return "Inactive — product excluded from assembly operations";
  }
}

export function zohoReadinessReasonLabel(reason: ZohoReadinessReason): string {
  switch (reason) {
    case "no_unit_id":
      return "Missing single-unit Zoho item ID";
    case "no_display_id":
      return "Missing display Zoho item ID";
    case "no_case_id":
      return "Missing case Zoho item ID";
  }
}
