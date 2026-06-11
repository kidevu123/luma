// Production Output backlog — auto-issue / repair eligibility (pure evaluation).

import {
  computeEndingBalanceFromConsumption,
  computeExpectedTabletConsumptionFromProduct,
} from "@/lib/production/expected-tablet-consumption";
import {
  buildAutoFinishedLotDraft,
  computePackagingUnitsProduced,
  type PackagingFinishedLotCounts,
} from "@/lib/db/queries/finished-lots";
import { resolveReopenStartingBalance } from "@/lib/production/bag-allocation";

export type AutoLotBacklogBlockerCode =
  | "READY_TO_AUTO_ISSUE"
  | "MISSING_ALLOCATION_SESSION"
  | "MISSING_STARTING_BALANCE"
  | "MISSING_TABLETS_PER_UNIT"
  | "MISSING_OUTPUT_QUANTITY"
  | "MISSING_PRODUCT"
  | "MISSING_RECEIPT_NUMBER"
  | "MISSING_SHELF_LIFE"
  | "MISSING_PACKAGING_STRUCTURE"
  | "MISSING_INVENTORY_BAG"
  | "NEGATIVE_ENDING_BALANCE"
  | "MULTIPLE_SOURCE_BAGS_NEED_REVIEW"
  | "OPEN_ALLOCATION_ON_OTHER_WORKFLOW"
  | "FINISHED_LOT_EXISTS"
  | "ZOHO_OUTPUT_COMMITTED"
  | "LOT_NUMBER_CONFLICT"
  | "WORKFLOW_BAG_NOT_FINALIZED"
  | "MANUAL_REVIEW_REQUIRED";

export type AutoLotBacklogAction =
  | "AUTO_ISSUE_NOW"
  | "REPAIR_ALLOCATION"
  | "FIX_PRODUCT_SETUP"
  | "REVIEW_MANUALLY"
  | "NONE";

export type AutoLotBacklogRowInput = {
  workflowBagId: string;
  productId: string | null;
  productName: string | null;
  inventoryBagId: string | null;
  /** When >1 inventory bags could apply, repair is blocked. */
  ambiguousSourceBagCount: number;
  inventoryPillCount: number | null;
  lastClosedSessionEndingBalance: number | null;
  lastClosedSessionStartingBalance: number | null;
  lastClosedSessionConsumedQty: number | null;
  tabletsPerUnit: number | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  defaultShelfLifeDays: number | null;
  inventoryReceiptNumber: string | null;
  workflowReceiptNumber: string | null;
  unitsYielded: number | null;
  counts: PackagingFinishedLotCounts;
  finalizedAt: Date | null;
  excludedFromOutput: boolean;
  hasFinishedLot: boolean;
  openAllocationSessionId: string | null;
  openAllocationStartingBalance: number | null;
  openAllocationOnOtherWorkflow: boolean;
  zohoOutputCommitted: boolean;
  lotNumberConflict: boolean;
};

export type AutoLotBacklogEvaluation = {
  code: AutoLotBacklogBlockerCode;
  label: string;
  nextStep: string;
  action: AutoLotBacklogAction;
  repairable: boolean;
  autoIssuable: boolean;
  expectedConsumedQty: number | null;
  expectedEndingBalanceQty: number | null;
  productId: string | null;
};

const BLOCKER_LABELS: Record<AutoLotBacklogBlockerCode, string> = {
  READY_TO_AUTO_ISSUE: "Ready to auto-issue",
  MISSING_ALLOCATION_SESSION: "Missing allocation session",
  MISSING_STARTING_BALANCE: "Missing starting balance",
  MISSING_TABLETS_PER_UNIT: "Missing tablets per unit",
  MISSING_OUTPUT_QUANTITY: "Missing output quantity",
  MISSING_PRODUCT: "Missing product",
  MISSING_RECEIPT_NUMBER: "Missing receipt / lot number",
  MISSING_SHELF_LIFE: "Missing shelf life / expiry",
  MISSING_PACKAGING_STRUCTURE: "Missing packaging structure",
  MISSING_INVENTORY_BAG: "Missing source inventory bag",
  NEGATIVE_ENDING_BALANCE: "Negative ending balance",
  MULTIPLE_SOURCE_BAGS_NEED_REVIEW: "Multiple source bags need review",
  OPEN_ALLOCATION_ON_OTHER_WORKFLOW: "Source bag open on another run",
  FINISHED_LOT_EXISTS: "Finished lot already exists",
  ZOHO_OUTPUT_COMMITTED: "Zoho output already committed",
  LOT_NUMBER_CONFLICT: "Lot number conflict",
  WORKFLOW_BAG_NOT_FINALIZED: "Workflow bag not finalized",
  MANUAL_REVIEW_REQUIRED: "Manual review required",
};

const NEXT_STEPS: Record<AutoLotBacklogBlockerCode, string> = {
  READY_TO_AUTO_ISSUE: "Auto-issue now",
  MISSING_ALLOCATION_SESSION: "Repair allocation",
  MISSING_STARTING_BALANCE: "Enter starting balance in repair flow",
  MISSING_TABLETS_PER_UNIT: "Fix product setup",
  MISSING_OUTPUT_QUANTITY: "Review manually",
  MISSING_PRODUCT: "Correct workflow/product mapping",
  MISSING_RECEIPT_NUMBER: "Review manually",
  MISSING_SHELF_LIFE: "Fix product setup",
  MISSING_PACKAGING_STRUCTURE: "Fix product setup",
  MISSING_INVENTORY_BAG: "Review manually",
  NEGATIVE_ENDING_BALANCE: "Review starting balance / consumption",
  MULTIPLE_SOURCE_BAGS_NEED_REVIEW: "Review manually",
  OPEN_ALLOCATION_ON_OTHER_WORKFLOW: "Close the other allocation session first",
  FINISHED_LOT_EXISTS: "Review manually",
  ZOHO_OUTPUT_COMMITTED: "Review manually",
  LOT_NUMBER_CONFLICT: "Review manually",
  WORKFLOW_BAG_NOT_FINALIZED: "Complete floor finalization first",
  MANUAL_REVIEW_REQUIRED: "Review manually",
};

const BLOCKER_ACTIONS: Record<AutoLotBacklogBlockerCode, AutoLotBacklogAction> = {
  READY_TO_AUTO_ISSUE: "AUTO_ISSUE_NOW",
  MISSING_ALLOCATION_SESSION: "REPAIR_ALLOCATION",
  MISSING_STARTING_BALANCE: "REPAIR_ALLOCATION",
  MISSING_TABLETS_PER_UNIT: "FIX_PRODUCT_SETUP",
  MISSING_OUTPUT_QUANTITY: "REVIEW_MANUALLY",
  MISSING_PRODUCT: "REVIEW_MANUALLY",
  MISSING_RECEIPT_NUMBER: "REVIEW_MANUALLY",
  MISSING_SHELF_LIFE: "FIX_PRODUCT_SETUP",
  MISSING_PACKAGING_STRUCTURE: "FIX_PRODUCT_SETUP",
  MISSING_INVENTORY_BAG: "REVIEW_MANUALLY",
  NEGATIVE_ENDING_BALANCE: "REVIEW_MANUALLY",
  MULTIPLE_SOURCE_BAGS_NEED_REVIEW: "REVIEW_MANUALLY",
  OPEN_ALLOCATION_ON_OTHER_WORKFLOW: "REVIEW_MANUALLY",
  FINISHED_LOT_EXISTS: "REVIEW_MANUALLY",
  ZOHO_OUTPUT_COMMITTED: "REVIEW_MANUALLY",
  LOT_NUMBER_CONFLICT: "REVIEW_MANUALLY",
  WORKFLOW_BAG_NOT_FINALIZED: "REVIEW_MANUALLY",
  MANUAL_REVIEW_REQUIRED: "REVIEW_MANUALLY",
};

export function resolveInferredStartingBalance(
  input: Pick<
    AutoLotBacklogRowInput,
    | "openAllocationStartingBalance"
    | "lastClosedSessionEndingBalance"
    | "lastClosedSessionStartingBalance"
    | "lastClosedSessionConsumedQty"
    | "inventoryPillCount"
  >,
): number | null {
  if (input.openAllocationStartingBalance != null) {
    return input.openAllocationStartingBalance;
  }
  return resolveReopenStartingBalance(
    input.lastClosedSessionEndingBalance != null ||
      input.lastClosedSessionStartingBalance != null
      ? {
          endingBalanceQty: input.lastClosedSessionEndingBalance,
          startingBalanceQty: input.lastClosedSessionStartingBalance,
          consumedQty: input.lastClosedSessionConsumedQty,
        }
      : null,
    input.inventoryPillCount,
  );
}

function finishEvaluation(
  code: AutoLotBacklogBlockerCode,
  input: AutoLotBacklogRowInput,
  expectedConsumedQty: number | null,
  expectedEndingBalanceQty: number | null,
): AutoLotBacklogEvaluation {
  return {
    code,
    label: BLOCKER_LABELS[code],
    nextStep: NEXT_STEPS[code],
    action: BLOCKER_ACTIONS[code],
    repairable:
      code === "MISSING_ALLOCATION_SESSION" || code === "MISSING_STARTING_BALANCE",
    autoIssuable: code === "READY_TO_AUTO_ISSUE",
    expectedConsumedQty,
    expectedEndingBalanceQty,
    productId: input.productId,
  };
}

/** Pure eligibility for a finalized backlog row (no DB). */
export function evaluateAutoLotBacklogRow(
  input: AutoLotBacklogRowInput,
): AutoLotBacklogEvaluation {
  if (!input.finalizedAt) {
    return finishEvaluation("WORKFLOW_BAG_NOT_FINALIZED", input, null, null);
  }
  if (input.hasFinishedLot) {
    return finishEvaluation("FINISHED_LOT_EXISTS", input, null, null);
  }
  if (input.zohoOutputCommitted) {
    return finishEvaluation("ZOHO_OUTPUT_COMMITTED", input, null, null);
  }
  if (input.excludedFromOutput) {
    return finishEvaluation("MANUAL_REVIEW_REQUIRED", input, null, null);
  }
  if (input.lotNumberConflict) {
    return finishEvaluation("LOT_NUMBER_CONFLICT", input, null, null);
  }
  if (!input.productId) {
    return finishEvaluation("MISSING_PRODUCT", input, null, null);
  }
  if (input.ambiguousSourceBagCount > 1) {
    return finishEvaluation("MULTIPLE_SOURCE_BAGS_NEED_REVIEW", input, null, null);
  }
  if (!input.inventoryBagId) {
    return finishEvaluation("MISSING_INVENTORY_BAG", input, null, null);
  }
  if (input.openAllocationOnOtherWorkflow) {
    return finishEvaluation("OPEN_ALLOCATION_ON_OTHER_WORKFLOW", input, null, null);
  }

  const draft = buildAutoFinishedLotDraft({
    productId: input.productId,
    unitsPerDisplay: input.unitsPerDisplay,
    displaysPerCase: input.displaysPerCase,
    defaultShelfLifeDays: input.defaultShelfLifeDays,
    inventoryReceiptNumber: input.inventoryReceiptNumber,
    workflowReceiptNumber: input.workflowReceiptNumber,
    packagedAt: input.finalizedAt,
    counts: input.counts,
  });
  if (!draft.ok) {
    const code = draft.reason as AutoLotBacklogBlockerCode;
    if (code in BLOCKER_LABELS) {
      return finishEvaluation(code, input, null, null);
    }
    return finishEvaluation("MANUAL_REVIEW_REQUIRED", input, null, null);
  }

  const unitsProduced =
    input.unitsYielded ??
    computePackagingUnitsProduced(input.counts, {
      unitsPerDisplay: input.unitsPerDisplay,
      displaysPerCase: input.displaysPerCase,
    });
  const consumption = computeExpectedTabletConsumptionFromProduct(
    input.tabletsPerUnit,
    unitsProduced,
  );
  if (!consumption.ok) {
    const code = consumption.blocker as AutoLotBacklogBlockerCode;
    return finishEvaluation(code, input, null, null);
  }

  const startingBalance = resolveInferredStartingBalance(input);
  const endingBalance = computeEndingBalanceFromConsumption(
    startingBalance,
    consumption.expectedConsumed,
  );

  if (startingBalance == null) {
    if (!input.openAllocationSessionId) {
      return finishEvaluation(
        "MISSING_ALLOCATION_SESSION",
        input,
        consumption.expectedConsumed,
        null,
      );
    }
    return finishEvaluation(
      "MISSING_STARTING_BALANCE",
      input,
      consumption.expectedConsumed,
      null,
    );
  }

  if (endingBalance != null && endingBalance < 0) {
    return finishEvaluation(
      "NEGATIVE_ENDING_BALANCE",
      input,
      consumption.expectedConsumed,
      endingBalance,
    );
  }

  if (!input.openAllocationSessionId) {
    return finishEvaluation(
      "MISSING_ALLOCATION_SESSION",
      input,
      consumption.expectedConsumed,
      endingBalance,
    );
  }

  return finishEvaluation(
    "READY_TO_AUTO_ISSUE",
    input,
    consumption.expectedConsumed,
    endingBalance,
  );
}

/** Stricter gate for repair/auto-issue mutations. */
export function assertAutoLotRepairAllowed(
  evaluation: AutoLotBacklogEvaluation,
): { ok: true } | { ok: false; code: AutoLotBacklogBlockerCode; message: string } {
  if (evaluation.code === "READY_TO_AUTO_ISSUE") {
    return { ok: true };
  }
  if (evaluation.code === "MISSING_ALLOCATION_SESSION") {
    if (evaluation.expectedConsumedQty == null || evaluation.expectedConsumedQty <= 0) {
      return {
        ok: false,
        code: "MISSING_OUTPUT_QUANTITY",
        message: "Expected tablet consumption must be positive before repair.",
      };
    }
    if (evaluation.expectedEndingBalanceQty == null) {
      return {
        ok: false,
        code: "MISSING_STARTING_BALANCE",
        message:
          "Starting tablet balance is unknown. Use Repair allocation and enter the physical bag count.",
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    code: evaluation.code,
    message: `${evaluation.label}. ${evaluation.nextStep}.`,
  };
}
