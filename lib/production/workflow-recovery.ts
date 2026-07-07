// Wrong-route / wrong-product workflow recovery — append-only events.

import { z } from "zod";

export const WORKFLOW_RECOVERY_EVENT_TYPE = "WORKFLOW_RECOVERY" as const;

export const WORKFLOW_RECOVERY_KINDS = [
  "WRONG_ROUTE",
  "WRONG_PRODUCT",
  "WRONG_QR_ASSIGNMENT",
] as const;

export type WorkflowRecoveryKind = (typeof WORKFLOW_RECOVERY_KINDS)[number];

export const WORKFLOW_RECOVERY_STATUS = {
  WRONG_ROUTE_RECOVERED: "WRONG_ROUTE_RECOVERED",
  VOIDED_FROM_OUTPUT: "VOIDED_FROM_OUTPUT",
  EXTERNAL_RECOVERY_REQUIRED: "EXTERNAL_RECOVERY_REQUIRED",
} as const;

export type WorkflowRecoveryStatus =
  (typeof WORKFLOW_RECOVERY_STATUS)[keyof typeof WORKFLOW_RECOVERY_STATUS];

const uuidSchema = z.string().uuid();

/** How the admin intends to resolve the mistake. QUARANTINE_AND_RESTART
 *  quarantines this run and guides starting the correct workflow;
 *  QUARANTINE_ONLY is the legacy flag-for-review behavior. Additive —
 *  older events without this field are QUARANTINE_ONLY semantics. */
export const WORKFLOW_RECOVERY_CORRECTION_MODES = [
  "QUARANTINE_AND_RESTART",
  "QUARANTINE_ONLY",
] as const;

export const workflowRecoveryPayloadSchema = z.object({
  client_event_id: uuidSchema,
  recovery_kind: z.enum(WORKFLOW_RECOVERY_KINDS),
  reason: z.string().min(10).max(500),
  notes: z.string().max(2000).nullable().optional(),
  entered_by_user_id: uuidSchema,
  original_product_id: uuidSchema.nullable().optional(),
  /** ADMIN-CORRECTION-WIZARD-1: the product staff SHOULD have used —
   *  recorded intent that drives the "start correct workflow" guidance. */
  intended_product_id: uuidSchema.nullable().optional(),
  /** Route/kind of the intended product (CARD | BOTTLE | VARIETY). */
  intended_route: z.string().max(50).nullable().optional(),
  correction_mode: z.enum(WORKFLOW_RECOVERY_CORRECTION_MODES).optional(),
  original_route_summary: z.string().min(1).max(500),
  source_inventory_released: z.boolean(),
  finished_lot_existed: z.boolean(),
  finished_lot_id: uuidSchema.nullable().optional(),
  finished_lot_action: z.enum([
    "NONE",
    "ON_HOLD",
    "EXTERNAL_RECOVERY_REQUIRED",
  ]),
  zoho_output_action: z.enum([
    "NONE",
    "VOID_UNCOMMITTED",
    "BLOCKED_COMMITTED",
  ]),
  reset_allowed: z.boolean(),
  reset_performed: z.boolean(),
});

export type WorkflowRecoveryPayload = z.infer<
  typeof workflowRecoveryPayloadSchema
>;

export type WorkflowRecoveryBlocker = {
  code: string;
  message: string;
};

export type WorkflowRecoveryEligibility = {
  eligible: boolean;
  blockers: WorkflowRecoveryBlocker[];
  resetAllowed: boolean;
  zohoCommitted: boolean;
  finishedLotExists: boolean;
  recoveryStatus: WorkflowRecoveryStatus;
};

export function evaluateWorkflowRecoveryEligibility(args: {
  alreadyRecovered: boolean;
  zohoOutputCommitted: boolean;
  isFinalized: boolean;
  finishedLotExists: boolean;
}): WorkflowRecoveryEligibility {
  const blockers: WorkflowRecoveryBlocker[] = [];

  if (args.alreadyRecovered) {
    blockers.push({
      code: "ALREADY_RECOVERED",
      message: "This workflow was already marked as recovered.",
    });
  }

  const resetAllowed =
    !args.isFinalized &&
    !args.finishedLotExists &&
    !args.zohoOutputCommitted;

  let recoveryStatus: WorkflowRecoveryStatus =
    WORKFLOW_RECOVERY_STATUS.WRONG_ROUTE_RECOVERED;
  if (args.zohoOutputCommitted) {
    recoveryStatus = WORKFLOW_RECOVERY_STATUS.EXTERNAL_RECOVERY_REQUIRED;
  } else if (args.finishedLotExists || args.isFinalized) {
    recoveryStatus = WORKFLOW_RECOVERY_STATUS.VOIDED_FROM_OUTPUT;
  }

  return {
    eligible: !args.alreadyRecovered,
    blockers,
    resetAllowed,
    zohoCommitted: args.zohoOutputCommitted,
    finishedLotExists: args.finishedLotExists,
    recoveryStatus,
  };
}

export function buildRouteSummary(args: {
  productName: string | null;
  productKind: string | null;
  stage: string | null;
  eventTypes: readonly string[];
}): string {
  const parts = [
    args.productName ?? "Unknown product",
    args.productKind ? `(${args.productKind})` : null,
    args.stage ? `stage ${args.stage}` : null,
    args.eventTypes.length > 0
      ? `events: ${args.eventTypes.slice(0, 6).join(", ")}`
      : null,
  ].filter((p): p is string => p != null && p.length > 0);
  return parts.join(" · ");
}
