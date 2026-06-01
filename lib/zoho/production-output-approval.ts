import type { ProductionOutputDataQualityState } from "@/lib/zoho/production-output-preview";

export type ZohoProductionOutputOpStatus =
  | "DRAFT"
  | "PREVIEWED"
  | "APPROVED"
  | "VOIDED";

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
