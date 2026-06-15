// ZOHO-PRODUCTION-OUTPUT-UI-STATE — operator-facing commit lifecycle labels.

import type { ZohoProductionOutputOpStatus } from "@/lib/zoho/production-output-approval";
import { parseZohoGatewayErrorCode } from "@/lib/zoho/production-output-idempotency";
import { parseZohoCommitResponseIds } from "@/lib/zoho/production-output-source-allocations";

export type ProductionOutputUiCommitState =
  | "READY_TO_COMMIT"
  | "COMMIT_IN_PROGRESS"
  | "COMMITTED"
  | "COMMIT_AMBIGUOUS_NEEDS_REVIEW"
  | "COMMIT_FAILED_SAFE"
  | "COMMITTED_IN_ZOHO_NEEDS_LUMA_RECONCILE";

export type ProductionOutputUiStateInput = {
  status: ZohoProductionOutputOpStatus | null;
  previewStatus: string | null;
  commitStatus: string | null;
  commitError: string | null;
  commitResponse: unknown;
  zohoBundleIds: string[] | null;
  humanReviewRequired: boolean;
  partialFailure: boolean;
  voidedAt: Date | null;
};

export function zohoProofExistsWithoutLumaCommit(input: {
  status: ZohoProductionOutputOpStatus | null;
  commitResponse: unknown;
  zohoBundleIds: string[] | null;
}): boolean {
  if (input.status === "COMMITTED") return false;
  const bundles = input.zohoBundleIds ?? [];
  if (bundles.length > 0) return true;
  const parsed = parseZohoCommitResponseIds(input.commitResponse);
  return parsed.bundleIds.length > 0;
}

export function deriveProductionOutputUiCommitState(
  input: ProductionOutputUiStateInput,
): ProductionOutputUiCommitState {
  if (input.voidedAt != null || input.status === "VOIDED") {
    return "COMMIT_FAILED_SAFE";
  }

  if (input.status === "COMMITTED") {
    return "COMMITTED";
  }

  if (input.status === "COMMITTING") {
    return "COMMIT_IN_PROGRESS";
  }

  if (
    zohoProofExistsWithoutLumaCommit({
      status: input.status,
      commitResponse: input.commitResponse,
      zohoBundleIds: input.zohoBundleIds,
    })
  ) {
    return "COMMITTED_IN_ZOHO_NEEDS_LUMA_RECONCILE";
  }

  if (input.status === "FAILED") {
    if (
      input.commitStatus === "ambiguous_needs_review" ||
      input.humanReviewRequired ||
      parseZohoGatewayErrorCode(input.commitResponse) ===
        "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS"
    ) {
      return "COMMIT_AMBIGUOUS_NEEDS_REVIEW";
    }
    return "COMMIT_FAILED_SAFE";
  }

  if (
    input.status === "READY" ||
    input.status === "QUEUED" ||
    input.status === "APPROVED"
  ) {
    return "READY_TO_COMMIT";
  }

  if (input.previewStatus === "ready") {
    return "READY_TO_COMMIT";
  }

  return "COMMIT_FAILED_SAFE";
}

export function productionOutputUiCommitStateLabel(
  state: ProductionOutputUiCommitState,
): string {
  switch (state) {
    case "READY_TO_COMMIT":
      return "ready to commit";
    case "COMMIT_IN_PROGRESS":
      return "commit in progress";
    case "COMMITTED":
      return "committed";
    case "COMMIT_AMBIGUOUS_NEEDS_REVIEW":
      return "commit ambiguous — needs review";
    case "COMMIT_FAILED_SAFE":
      return "commit failed";
    case "COMMITTED_IN_ZOHO_NEEDS_LUMA_RECONCILE":
      return "committed in Zoho — needs Luma reconcile";
  }
}
