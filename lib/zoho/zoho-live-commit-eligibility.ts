// ZOHO-STAGING-BUFFER-v1.1.0 — data-driven live-commit eligibility.
//
// Replaces lib/zoho/push-to-zoho-go-live-allowlist.ts (deleted). The
// old allowlist hard-coded two specific product UUIDs and entity IDs;
// rolling out a third product required a code change. The new rule is
// purely data-driven and reads from product columns:
//
//   eligible_for_live_commit =
//       product.zohoLiveCommitEnabled = true        (operator toggle)
//     AND all required Zoho IDs present              (data-driven readiness)
//     AND product structure valid                    (units_per_display,
//                                                     displays_per_case)
//     AND no mapping blockers on the staged op       (caller-supplied)
//
// The operator flag (zohoLiveCommitEnabled, added in migration 0063)
// exists because "can technically commit" (all IDs present, structure
// valid) is not the same as "we trust this product in live Zoho yet."
// Until a product has been proven in preview, the operator keeps it
// off. Once they're comfortable, they toggle it on. No code change.
//
// Per the spec: do NOT introduce another allowlist under a different
// name. If a per-product behavior needs to differ, it must come from
// product fields, mapping tables, BOM rows, or explicit override
// columns — never a hard-coded array of IDs in source.

import {
  classifyProductZohoReadiness,
  type ZohoReadinessReason,
} from "@/lib/zoho/product-zoho-readiness";

export type LiveCommitBlockerCode =
  | "OPERATOR_FLAG_OFF"
  | "PRODUCT_INACTIVE"
  | "ZOHO_READINESS_NOT_READY"
  | "MAPPING_BLOCKERS_PRESENT";

export type LiveCommitBlocker = {
  code: LiveCommitBlockerCode;
  message: string;
  /** When ZOHO_READINESS_NOT_READY, the underlying readiness reasons
   *  (no_unit_id / no_display_id / no_case_id) for surfacing on the UI. */
  readinessReasons?: ZohoReadinessReason[];
};

export type LiveCommitEligibility =
  | { eligible: true }
  | { eligible: false; blockers: LiveCommitBlocker[] };

export type LiveCommitEligibilityInput = {
  product: {
    isActive: boolean;
    zohoLiveCommitEnabled: boolean;
    zohoItemIdUnit: string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase: string | null;
    unitsPerDisplay: number | null;
    displaysPerCase: number | null;
  };
  /** Any mapping blockers already present on the staged op. If
   *  unsupplied or empty, no mapping-blocker objection is raised. */
  mappingBlockers?: ReadonlyArray<{ code: string; message: string }>;
};

export function evaluateLiveCommitEligibility(
  input: LiveCommitEligibilityInput,
): LiveCommitEligibility {
  const blockers: LiveCommitBlocker[] = [];

  if (!input.product.isActive) {
    blockers.push({
      code: "PRODUCT_INACTIVE",
      message: "Product is inactive — activate it before live commit.",
    });
  }

  // Operator flag is the SECOND check (not first) so the UI can show
  // BOTH "product inactive" and "operator flag off" together when both
  // apply — readiness flags should always be batched, not stair-stepped.
  if (!input.product.zohoLiveCommitEnabled) {
    blockers.push({
      code: "OPERATOR_FLAG_OFF",
      message:
        "Live commit not enabled for this product. Toggle 'Zoho live commit' on the product page once you trust it.",
    });
  }

  const readiness = classifyProductZohoReadiness({
    isActive: input.product.isActive,
    zohoItemIdUnit: input.product.zohoItemIdUnit,
    zohoItemIdDisplay: input.product.zohoItemIdDisplay,
    zohoItemIdCase: input.product.zohoItemIdCase,
    unitsPerDisplay: input.product.unitsPerDisplay,
    displaysPerCase: input.product.displaysPerCase,
  });
  if (readiness.level !== "ready" && readiness.level !== "inactive") {
    blockers.push({
      code: "ZOHO_READINESS_NOT_READY",
      message:
        "Product is missing one or more Zoho item IDs. Fix on the product page.",
      readinessReasons: readiness.reasons,
    });
  }

  if (input.mappingBlockers && input.mappingBlockers.length > 0) {
    blockers.push({
      code: "MAPPING_BLOCKERS_PRESENT",
      message: `${input.mappingBlockers.length} mapping blocker${
        input.mappingBlockers.length === 1 ? "" : "s"
      } present on the staged op. Resolve before live commit.`,
    });
  }

  if (blockers.length === 0) return { eligible: true };
  return { eligible: false, blockers };
}

/** Compact label for chips / queue badges. */
export function liveCommitEligibilityShortLabel(
  eligibility: LiveCommitEligibility,
): string {
  if (eligibility.eligible) return "Live commit ready";
  // Prefer surfacing the operator flag when it's off — it's the
  // signal the operator most often needs ("I haven't approved this
  // product for live yet"), and it's actionable in one click.
  const operatorOff = eligibility.blockers.find(
    (b) => b.code === "OPERATOR_FLAG_OFF",
  );
  if (operatorOff) return "Live commit disabled by operator";
  const inactive = eligibility.blockers.find((b) => b.code === "PRODUCT_INACTIVE");
  if (inactive) return "Product inactive";
  return "Not live-commit ready";
}
