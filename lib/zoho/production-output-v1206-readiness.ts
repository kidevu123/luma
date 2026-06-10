// ZOHO-PRODUCTION-OUTPUT-V1206 — unified commit/preview readiness gates.

import {
  isConsolidatedLumaProductionOutputPayload,
  type LumaProductionOutputPayload,
} from "@/lib/zoho/luma-production-output-payload";
import type { ZohoProductionOutputOpStatus } from "@/lib/zoho/production-output-approval";
import { parsePreviewWritesAllowed } from "@/lib/zoho/luma-operation-snapshot";
import {
  rejectWorkflowBagAsSourceBagId,
  validateSourceAllocationQuantity,
} from "@/lib/zoho/component-batch-quantity";
import { evaluateChocoDriftPreviewPreflight } from "@/lib/zoho/choco-drift-preview-preflight";
import {
  CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  CHOCO_DRIFT_SKU,
  chocoDriftRequiresComponentBatches,
  isChocoDriftSku,
  skuRequiresComponentBatchesUntilBomConfirmed,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import { evaluateSourceReceiptEvidenceForProductionOutput } from "@/lib/zoho/source-receipt-evidence";

export type V1206ReadinessBlocker = {
  code: string;
  message: string;
};

export type V1206CommitReadinessInput = {
  opExists: boolean;
  status: ZohoProductionOutputOpStatus | null;
  voidedAt: Date | null;
  payloadKind: string | null;
  requestPayload: unknown;
  previewHttpStatus: number | null;
  previewResponse: unknown;
  previewStatus: string | null;
  previewWritesAllowed: boolean;
  commitIdempotencyKey: string | null;
  finishedLotExists: boolean;
  workflowBagId: string | null;
  sourceAllocationCount: number;
  unresolvedBatchCount: number;
  ambiguousBatchCount: number;
  humanReviewRequired: boolean;
  partialFailure: boolean;
  productionOutputEnabled: boolean;
  scriptBypassAttempt?: boolean;
};

export function evaluateV1206ProductionOutputCommitReadiness(
  input: V1206CommitReadinessInput,
): { eligible: boolean; blockers: V1206ReadinessBlocker[] } {
  const blockers: V1206ReadinessBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  if (input.scriptBypassAttempt) {
    add(
      "SCRIPT_BYPASS_BLOCKED",
      "Direct script commits are blocked. Create a persisted zoho_production_output_ops row from a finalized finished lot.",
    );
  }

  if (!input.opExists) {
    add("OP_NOT_PERSISTED", "A persisted production-output operation is required.");
    return { eligible: false, blockers };
  }

  if (input.voidedAt != null || input.status === "VOIDED") {
    add("VOIDED", "This operation is voided.");
  }

  if (input.status !== "QUEUED" && input.status !== "FAILED") {
    add("NOT_PROCESSABLE", "Operation must be QUEUED or FAILED to commit.");
  }

  if (!input.finishedLotExists) {
    add("FINISHED_LOT_MISSING", "Finished lot no longer exists.");
  }

  if (!input.workflowBagId) {
    add("WORKFLOW_BAG_MISSING", "Workflow bag linkage is required.");
  }

  if (input.sourceAllocationCount <= 0) {
    add(
      "MISSING_SOURCE_ALLOCATIONS",
      "Persisted source raw-bag allocations are required.",
    );
  }

  let isChocoDrift = false;

  if (!isConsolidatedLumaProductionOutputPayload(input.requestPayload)) {
    add("INVALID_PAYLOAD", "Stored payload is not a consolidated LUMA payload.");
  } else {
    const payload = input.requestPayload as LumaProductionOutputPayload;
    isChocoDrift = isChocoDriftSku(payload.product.sku);

    const requiresComponentBatches =
      !isChocoDrift &&
      (payload.product.sku.includes("variety") ||
        skuRequiresComponentBatchesUntilBomConfirmed(payload.product.sku) ||
        payload.component_batches.length > 0);

    if (requiresComponentBatches && payload.component_batches.length === 0) {
      add(
        "MISSING_COMPONENT_BATCHES",
        "Payload must include resolved component_batches for batch-tracked assembly.",
      );
    }

    if (isChocoDrift && payload.component_batches.length > 0) {
      add(
        "UNEXPECTED_COMPONENT_BATCHES",
        "Choco Drift must not send component_batches; raw and packaging items are not batch-tracked.",
      );
    }

    const unitAssemblyQuantity = payload.output?.units_produced;
    if (unitAssemblyQuantity != null && unitAssemblyQuantity > 0) {
      const snapshot = payload.luma_operation_snapshot;
      if (isChocoDrift && snapshot) {
        for (const allocation of snapshot.source_allocations) {
          if (allocation.item_id !== CHOCO_DRIFT_RAW_TABLET_ITEM_ID) continue;
          const qtyCheck = validateSourceAllocationQuantity({
            allocatedQuantity: allocation.quantity,
            bomQuantityPerUnit: CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
            unitAssemblyQuantity,
          });
          if (!qtyCheck.ok) {
            add(qtyCheck.code, qtyCheck.message);
          }
          const bagCheck = rejectWorkflowBagAsSourceBagId(
            allocation.source_bag_id,
            input.workflowBagId,
          );
          if (!bagCheck.ok) {
            add(bagCheck.code, bagCheck.message);
          }
        }

        const preflight = evaluateChocoDriftPreviewPreflight({
          sku: CHOCO_DRIFT_SKU,
          unitAssemblyQuantity,
          previewHttpStatus: input.previewHttpStatus,
          previewResponse: input.previewResponse,
        });
        for (const blocker of preflight.blockers) {
          add(blocker.code, blocker.message);
        }
      }
    }

    if (!input.commitIdempotencyKey?.trim()) {
      add("MISSING_IDEMPOTENCY_KEY", "Commit idempotency key is missing.");
    } else if (input.commitIdempotencyKey !== payload.idempotency_key) {
      add("IDEMPOTENCY_KEY_MISMATCH", "Commit idempotency key does not match payload.");
    }

    if (payload.source_receipt_evidence && payload.source_receipt_evidence.length > 0) {
      const receiptGate = evaluateSourceReceiptEvidenceForProductionOutput(
        payload.source_receipt_evidence,
      );
      if (!receiptGate.ok) {
        for (const blocker of receiptGate.blockers) {
          add(blocker.code, blocker.message);
        }
      }
    }
  }

  if (
    input.previewHttpStatus == null ||
    input.previewHttpStatus < 200 ||
    input.previewHttpStatus >= 300
  ) {
    add(
      "PREVIEW_NOT_SUCCESSFUL",
      "A successful Zoho preview is required before commit.",
    );
  }

  if (input.previewResponse == null) {
    add("MISSING_PREVIEW_RESPONSE", "Preview response is not stored.");
  }

  if (!input.previewWritesAllowed) {
    add(
      "PREVIEW_WRITES_NOT_ALLOWED",
      "Zoho preview must return writes_allowed=true before queue or commit.",
    );
  }

  if (input.previewStatus != null && input.previewStatus.toLowerCase() !== "ready") {
    add(
      "PREVIEW_NOT_READY",
      `Preview status is ${input.previewStatus}; commit is blocked.`,
    );
  }

  if (!isChocoDrift && (input.unresolvedBatchCount > 0 || input.ambiguousBatchCount > 0)) {
    add(
      "BATCH_RESOLUTION_INCOMPLETE",
      "All component batches must be uniquely resolved before commit.",
    );
  }

  if (input.humanReviewRequired) {
    add(
      "HUMAN_REVIEW_REQUIRED",
      "Human review is required before commit can proceed.",
    );
  }

  if (input.partialFailure) {
    add(
      "PARTIAL_FAILURE",
      "Partial failure state requires human review; automatic retry is blocked.",
    );
  }

  if (!input.productionOutputEnabled) {
    add(
      "PRODUCTION_OUTPUT_COMMIT_DISABLED",
      "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED is false — live commit is disabled.",
    );
  }

  return { eligible: blockers.length === 0, blockers };
}

export function derivePreviewStatus(input: {
  previewHttpStatus: number | null;
  previewResponse: unknown;
  blockers: V1206ReadinessBlocker[];
}): string {
  if (input.blockers.some((b) => b.code === "PO_OUTPUT_FAMILY_MISMATCH")) {
    return "blocked";
  }
  if (input.previewHttpStatus == null) return "pending";
  if (input.previewHttpStatus >= 200 && input.previewHttpStatus < 300) {
    if (!parsePreviewWritesAllowed(input.previewResponse)) return "blocked";
    return input.blockers.length > 0 ? "blocked" : "ready";
  }
  return "preview_failed";
}

export function deriveUiOperationStatus(input: {
  status: ZohoProductionOutputOpStatus | null;
  previewStatus: string | null;
  humanReviewRequired: boolean;
  partialFailure: boolean;
  voidedAt: Date | null;
}): string {
  if (input.voidedAt != null || input.status === "VOIDED") return "cancelled/invalid test";
  if (input.partialFailure) return "partial failure";
  if (input.humanReviewRequired) return "human review required";
  if (input.status === "COMMITTED") return "committed";
  if (input.status === "COMMITTING" || input.status === "QUEUED") {
    return "commit pending";
  }
  if (input.status === "FAILED") return "preview failed";
  if (input.previewStatus === "blocked" || input.status === "NEEDS_MAPPING") {
    return "blocked";
  }
  if (input.previewStatus === "ready" || input.status === "READY") return "ready";
  return "blocked";
}

export { chocoDriftRequiresComponentBatches };
