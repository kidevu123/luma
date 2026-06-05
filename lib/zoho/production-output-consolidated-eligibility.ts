// Consolidated production-output commit eligibility (no preview/approve required).

import {
  isConsolidatedLumaProductionOutputPayload,
  type LumaProductionOutputPayload,
} from "@/lib/zoho/luma-production-output-payload";
import type { ZohoProductionOutputOpStatus } from "@/lib/zoho/production-output-approval";

export type ConsolidatedProductionOutputProcessBlocker = {
  code: string;
  message: string;
};

export type ConsolidatedProductionOutputProcessInput = {
  opExists: boolean;
  status: ZohoProductionOutputOpStatus | null;
  voidedAt: Date | null;
  payloadKind: string | null;
  requestPayload: unknown;
  commitIdempotencyKey: string | null;
  finishedLotExists: boolean;
  committedOpExists: boolean;
  legacyAssemblyOpExists: boolean;
  legacyZohoPushExists: boolean;
  productionOutputEnabled: boolean;
};

export function evaluateConsolidatedProductionOutputProcessCommitEligibility(
  op: ConsolidatedProductionOutputProcessInput,
): { eligible: boolean; blockers: ConsolidatedProductionOutputProcessBlocker[] } {
  const blockers: ConsolidatedProductionOutputProcessBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  if (!op.opExists) add("OP_NOT_FOUND", "Production output operation not found.");
  if (op.voidedAt != null || op.status === "VOIDED") {
    add("VOIDED", "This operation is voided.");
  }
  if (op.status !== "QUEUED" && op.status !== "FAILED") {
    add("NOT_PROCESSABLE", "Operation must be QUEUED or FAILED to process commit.");
  }
  if (op.payloadKind !== "consolidated") {
    add("NOT_CONSOLIDATED", "This processor only handles consolidated production-output ops.");
  }
  if (!isConsolidatedLumaProductionOutputPayload(op.requestPayload)) {
    add("INVALID_PAYLOAD", "Stored request payload is not a consolidated LUMA payload.");
  }
  if (!op.commitIdempotencyKey?.trim()) {
    add("MISSING_IDEMPOTENCY_KEY", "Commit idempotency key is missing.");
  } else if (op.requestPayload && isConsolidatedLumaProductionOutputPayload(op.requestPayload)) {
    if (op.commitIdempotencyKey !== op.requestPayload.idempotency_key) {
      add("IDEMPOTENCY_KEY_MISMATCH", "Commit idempotency key does not match payload.");
    }
  }
  if (!op.finishedLotExists) add("FINISHED_LOT_MISSING", "Finished lot no longer exists.");
  if (op.committedOpExists) {
    add("ALREADY_COMMITTED", "A committed production-output operation already exists for this lot.");
  }
  if (op.legacyAssemblyOpExists) {
    add(
      "LEGACY_ASSEMBLY_OP_EXISTS",
      "Legacy Zoho assembly operations exist for this lot. Consolidated commit is blocked to prevent double-posting.",
    );
  }
  if (op.legacyZohoPushExists) {
    add(
      "LEGACY_ZOHO_PUSH_EXISTS",
      "A successful legacy Zoho push exists for this lot. Consolidated commit is blocked.",
    );
  }
  if (!op.productionOutputEnabled) {
    add(
      "PRODUCTION_OUTPUT_DISABLED",
      "ZOHO_PRODUCTION_OUTPUT_ENABLED is false — live commit is disabled.",
    );
  }

  return { eligible: blockers.length === 0, blockers };
}

export function firstSourceReceiptPoId(
  payload: LumaProductionOutputPayload,
): string | null {
  return payload.source_receipts[0]?.zoho_purchaseorder_id ?? null;
}

export function firstSourceReceiptPoLineId(
  payload: LumaProductionOutputPayload,
): string | null {
  return payload.source_receipts[0]?.zoho_purchaseorder_line_item_id ?? null;
}
