import type { ProductionOutputDataQualityState } from "@/lib/zoho/production-output-preview";

export type ZohoProductionOutputOpStatus =
  | "DRAFT"
  | "PREVIEWED"
  | "APPROVED"
  | "VOIDED"
  | "QUEUED"
  | "COMMITTING"
  | "COMMITTED"
  | "FAILED";

export type ZohoProductionOutputApprovalInput = {
  status: ZohoProductionOutputOpStatus;
  voidedAt: Date | null;
  previewResponse: unknown;
  previewHttpStatus: number | null;
  metricsState: ProductionOutputDataQualityState;
  genealogyState: ProductionOutputDataQualityState;
  requestHash: string;
  approvedRequestHash: string | null;
};

export type ZohoProductionOutputApprovalEvaluation = {
  eligible: boolean;
  reasons: string[];
};

export function evaluateZohoProductionOutputApproval(
  op: ZohoProductionOutputApprovalInput,
): ZohoProductionOutputApprovalEvaluation {
  const reasons: string[] = [];

  if (op.voidedAt != null) {
    reasons.push("This operation is voided.");
  }
  if (op.status === "DRAFT") {
    reasons.push("Run a successful Zoho preview before approval.");
  }
  if (op.status === "APPROVED") {
    reasons.push("This preview is already approved.");
  }
  if (op.status === "VOIDED") {
    reasons.push("Voided operations cannot be approved.");
  }
  if (op.status !== "PREVIEWED") {
    if (!reasons.some((r) => r.includes("preview"))) {
      reasons.push("Only PREVIEWED operations can be approved.");
    }
  }
  if (op.previewResponse == null || op.previewHttpStatus == null) {
    reasons.push("No preview response is stored for this operation.");
  }
  if (op.metricsState === "MISSING") {
    reasons.push("Metrics state is MISSING — approval is blocked.");
  }
  if (op.genealogyState === "MISSING") {
    reasons.push("Genealogy state is MISSING — approval is blocked.");
  }
  if (op.genealogyState === "LOW") {
    reasons.push("Genealogy state is LOW — approval is blocked.");
  }
  if (
    op.approvedRequestHash != null &&
    op.approvedRequestHash !== op.requestHash
  ) {
    reasons.push("Approved request hash no longer matches the preview payload.");
  }

  return { eligible: reasons.length === 0, reasons };
}

export function canVoidZohoProductionOutputOp(
  op: Pick<ZohoProductionOutputApprovalInput, "status" | "voidedAt">,
): { ok: true } | { ok: false; error: string } {
  if (op.voidedAt != null || op.status === "VOIDED") {
    return { ok: false, error: "This operation is already voided." };
  }
  if (
    op.status !== "DRAFT" &&
    op.status !== "PREVIEWED" &&
    op.status !== "APPROVED"
  ) {
    return { ok: false, error: "This operation cannot be voided." };
  }
  return { ok: true };
}

export type ZohoProductionOutputCommitReadinessBlockerCode =
  | "NOT_APPROVED"
  | "VOIDED"
  | "APPROVED_HASH_MISMATCH"
  | "MISSING_REQUEST_PAYLOAD"
  | "MISSING_PREVIEW_RESPONSE"
  | "PREVIEW_NOT_SUCCESSFUL"
  | "METRICS_NOT_HIGH"
  | "GENEALOGY_NOT_HIGH"
  | "FINISHED_LOT_MISSING"
  | "ALREADY_COMMITTED"
  | "LEGACY_ASSEMBLY_OP_EXISTS"
  | "LEGACY_ZOHO_PUSH_EXISTS"
  | "CONFIG_MISSING";

export type ZohoProductionOutputCommitReadinessBlocker = {
  code: ZohoProductionOutputCommitReadinessBlockerCode;
  message: string;
};

export type ZohoProductionOutputCommitReadinessInput = {
  status: ZohoProductionOutputOpStatus | null;
  voidedAt: Date | null;
  approvedRequestHash: string | null;
  requestHash: string | null;
  requestPayload: unknown;
  previewResponse: unknown;
  previewHttpStatus: number | null;
  metricsState: ProductionOutputDataQualityState | null;
  genealogyState: ProductionOutputDataQualityState | null;
  finishedLotExists: boolean;
  committedOpExists: boolean;
  legacyAssemblyOpExists: boolean;
  legacyZohoPushExists: boolean;
  configMissing?: boolean;
};

export type ZohoProductionOutputCommitReadiness = {
  ready: boolean;
  blockers: ZohoProductionOutputCommitReadinessBlocker[];
};

export function evaluateZohoProductionOutputCommitReadiness(
  op: ZohoProductionOutputCommitReadinessInput,
): ZohoProductionOutputCommitReadiness {
  const blockers: ZohoProductionOutputCommitReadinessBlocker[] = [];

  const add = (
    code: ZohoProductionOutputCommitReadinessBlockerCode,
    message: string,
  ) => blockers.push({ code, message });

  if (!op.finishedLotExists) {
    add("FINISHED_LOT_MISSING", "Finished lot no longer exists.");
  }
  if (op.voidedAt != null || op.status === "VOIDED") {
    add("VOIDED", "This operation is voided.");
  }
  if (op.status !== "APPROVED") {
    add("NOT_APPROVED", "Operation must be APPROVED before future commit.");
  }
  if (
    op.approvedRequestHash == null ||
    op.requestHash == null ||
    op.approvedRequestHash !== op.requestHash
  ) {
    add(
      "APPROVED_HASH_MISMATCH",
      "Approved request hash does not match the stored preview payload.",
    );
  }
  if (op.requestPayload == null) {
    add("MISSING_REQUEST_PAYLOAD", "Stored preview request payload is missing.");
  }
  if (op.previewResponse == null) {
    add("MISSING_PREVIEW_RESPONSE", "Stored preview response is missing.");
  }
  if (
    op.previewHttpStatus == null ||
    op.previewHttpStatus < 200 ||
    op.previewHttpStatus >= 300
  ) {
    add(
      "PREVIEW_NOT_SUCCESSFUL",
      "Latest stored preview did not return a successful HTTP status.",
    );
  }
  if (op.metricsState !== "HIGH") {
    add(
      "METRICS_NOT_HIGH",
      `Metrics state is ${op.metricsState ?? "Missing"}; future commit requires HIGH.`,
    );
  }
  if (op.genealogyState !== "HIGH") {
    add(
      "GENEALOGY_NOT_HIGH",
      `Genealogy state is ${op.genealogyState ?? "Missing"}; future commit requires HIGH.`,
    );
  }
  if (op.committedOpExists) {
    add("ALREADY_COMMITTED", "A committed production-output operation already exists for this lot.");
  }
  if (op.legacyAssemblyOpExists) {
    add(
      "LEGACY_ASSEMBLY_OP_EXISTS",
      "Legacy Zoho assembly operations exist for this lot. Consolidated production-output commit is blocked to prevent double-posting.",
    );
  }
  if (op.legacyZohoPushExists) {
    add(
      "LEGACY_ZOHO_PUSH_EXISTS",
      "A successful legacy Zoho push exists for this lot. Future commit is blocked to prevent double-posting.",
    );
  }
  if (op.configMissing) {
    add("CONFIG_MISSING", "Zoho service configuration is missing.");
  }

  return { ready: blockers.length === 0, blockers };
}
