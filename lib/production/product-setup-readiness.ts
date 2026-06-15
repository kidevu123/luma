// Field-specific product setup readiness for the Production Output queue.
//
// The auto-issue eligibility evaluator in
// `auto-lot-backlog-eligibility.ts` returns ONE blocker code per row —
// the first one that fires short-circuits the rest. That's correct for
// the "next safe action" the row button drives, but it's bad UX in
// the queue: the operator fixes shelf life, comes back, sees "Missing
// packaging structure", fixes that, comes back, sees "Missing Zoho
// item IDs", and so on.
//
// This module collects ALL product-setup blockers in one pass so the
// chip can say "Multiple fields missing" with a complete tooltip, and
// so the product detail page can highlight every input that still
// needs attention before the bag is fully ready to ship.
//
// Zoho item IDs aren't part of auto-issue eligibility (the finished
// lot can be created without them — they're only needed for the
// downstream Zoho push). They appear here as an informational signal,
// not a hard blocker.

export type ProductSetupFieldCode =
  | "MISSING_SHELF_LIFE"
  | "MISSING_TABLETS_PER_UNIT"
  | "MISSING_PACKAGING_STRUCTURE"
  | "MISSING_ZOHO_ITEM_IDS";

export type ProductSetupFieldKind = "AUTO_ISSUE_BLOCKER" | "ZOHO_PUSH_BLOCKER";

export type ProductSetupFieldDetail = {
  code: ProductSetupFieldCode;
  label: string;
  kind: ProductSetupFieldKind;
};

export type ProductSetupReadiness = {
  /** All missing product-setup fields, in stable display order. */
  missingFields: ProductSetupFieldDetail[];
  /** Subset that block auto-issue (= finished-lot creation). */
  autoIssueBlockers: ProductSetupFieldDetail[];
  /** True when every Zoho item ID is filled at every level. */
  zohoReady: boolean;
  /** No product mapped → can't meaningfully evaluate setup. */
  unknown: boolean;
};

export type ProductSetupReadinessInput = {
  productId: string | null;
  tabletsPerUnit: number | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  defaultShelfLifeDays: number | null;
  zohoItemIdUnit: string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase: string | null;
};

const FIELD_LABELS: Record<ProductSetupFieldCode, string> = {
  MISSING_SHELF_LIFE: "Missing shelf life / expiry",
  MISSING_TABLETS_PER_UNIT: "Missing tablets per unit",
  MISSING_PACKAGING_STRUCTURE: "Missing packaging structure",
  MISSING_ZOHO_ITEM_IDS: "Missing Zoho item IDs",
};

const FIELD_KINDS: Record<ProductSetupFieldCode, ProductSetupFieldKind> = {
  MISSING_SHELF_LIFE: "AUTO_ISSUE_BLOCKER",
  MISSING_TABLETS_PER_UNIT: "AUTO_ISSUE_BLOCKER",
  MISSING_PACKAGING_STRUCTURE: "AUTO_ISSUE_BLOCKER",
  MISSING_ZOHO_ITEM_IDS: "ZOHO_PUSH_BLOCKER",
};

function nonEmptyString(s: string | null): boolean {
  return typeof s === "string" && s.trim() !== "";
}

export function evaluateProductSetupReadiness(
  input: ProductSetupReadinessInput,
): ProductSetupReadiness {
  if (!input.productId) {
    return {
      missingFields: [],
      autoIssueBlockers: [],
      zohoReady: false,
      unknown: true,
    };
  }
  const missing: ProductSetupFieldCode[] = [];
  if (input.tabletsPerUnit == null || input.tabletsPerUnit <= 0) {
    missing.push("MISSING_TABLETS_PER_UNIT");
  }
  if (input.defaultShelfLifeDays == null || input.defaultShelfLifeDays <= 0) {
    missing.push("MISSING_SHELF_LIFE");
  }
  if (
    input.unitsPerDisplay == null ||
    input.unitsPerDisplay <= 0 ||
    input.displaysPerCase == null ||
    input.displaysPerCase <= 0
  ) {
    missing.push("MISSING_PACKAGING_STRUCTURE");
  }
  const zohoReady =
    nonEmptyString(input.zohoItemIdUnit) &&
    nonEmptyString(input.zohoItemIdDisplay) &&
    nonEmptyString(input.zohoItemIdCase);
  if (!zohoReady) missing.push("MISSING_ZOHO_ITEM_IDS");

  const missingFields = missing.map<ProductSetupFieldDetail>((code) => ({
    code,
    label: FIELD_LABELS[code],
    kind: FIELD_KINDS[code],
  }));
  return {
    missingFields,
    autoIssueBlockers: missingFields.filter(
      (f) => f.kind === "AUTO_ISSUE_BLOCKER",
    ),
    zohoReady,
    unknown: false,
  };
}

/** Short summary for the queue chip — picks "Multiple fields missing"
 *  when more than one auto-issue blocker is present, otherwise the
 *  specific blocker label.
 *
 *  Zoho-only gaps are excluded from the primary chip because they
 *  don't block auto-issue. The row renders a separate Zoho-ready chip
 *  for those.
 */
export function summarizeAutoIssueStatus(
  readiness: ProductSetupReadiness,
): { label: string; multi: boolean } {
  const auto = readiness.autoIssueBlockers;
  if (auto.length === 0) {
    return { label: "Auto-issue ready", multi: false };
  }
  if (auto.length === 1) {
    return { label: auto[0]!.label, multi: false };
  }
  return { label: "Multiple fields missing", multi: true };
}
