// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — pure row classifier.
//
// Given the raw shape of a production-output candidate (workflow bag
// joined with finished_lots and zoho_production_output_ops), decide
// which status badge + next-action belongs on the row.
//
// Pure (no I/O, no DB, no env). The query module gathers the raw
// fields; this module turns them into UI-ready badges. Single source
// of truth for the status taxonomy + action gating.

import type { ProductionOutputStatusFilter } from "./production-output-filters";

export const PRODUCTION_OUTPUT_ROW_STATUSES = [
  "AWAITING_LOT",
  "READY_TO_AUTO_ISSUE",
  "MISSING_ALLOCATION",
  "BLOCKED",
  "ISSUED_LOT",
  "ZOHO_PENDING",
  "ZOHO_COMMITTED",
  "ZOHO_FAILED",
  "PACKAGED_NOT_FINALIZED",
  "EXCLUDED",
] as const;

export type ProductionOutputRowStatus =
  (typeof PRODUCTION_OUTPUT_ROW_STATUSES)[number];

export const PRODUCTION_OUTPUT_ROW_ACTIONS = [
  "AUTO_ISSUE_NOW",
  "REPAIR_ALLOCATION",
  "FIX_PRODUCT_SETUP",
  "REVIEW_MANUALLY",
  "VIEW_FINISHED_LOT",
  "PUSH_TO_ZOHO",
  "VIEW_ZOHO_OP",
  "AWAIT_FINALIZATION",
  "NONE",
] as const;

export type ProductionOutputRowAction =
  (typeof PRODUCTION_OUTPUT_ROW_ACTIONS)[number];

/**
 * Zoho-push gating result.
 *
 * `enabled: true` means the operator can navigate to the finished-lot
 * detail page and run the existing ZohoProductionOutputPreviewCard.
 * The actual commit is gated server-side by the v1.3.0 resolver and
 * (in the future) v1.4.0 capability — this flag only controls the
 * workbench CTA visibility.
 *
 * When `enabled: false`, `blocker` names the most actionable reason
 * the operator can see at a glance.
 */
export type ZohoPushEligibility =
  | { enabled: true }
  | {
      enabled: false;
      blocker:
        | "MISSING_FINISHED_LOT"
        | "MISSING_ALLOCATION"
        | "MISSING_PRODUCT_ZOHO_IDS"
        | "MISSING_TABLETS_PER_UNIT"
        | "ZOHO_ALREADY_COMMITTED"
        | "MANUAL_REVIEW_REQUIRED";
      message: string;
    };

export type ProductionOutputClassifierInput = {
  // Workflow bag shape
  finalizedAt: Date | null;
  startedAt: Date | null;
  stage: string | null; // read_bag_state.stage
  excludedFromOutput: boolean | null;

  // Backlog eligibility (already-computed for rows without lot)
  backlogActionCode: string | null;
  backlogActionLabel: string | null;

  // Finished lot fields (null when no lot exists)
  finishedLotId: string | null;
  finishedLotNumber: string | null;
  finishedLotStatus: string | null;

  // Genealogy hint — count of finished_lot_raw_bags rows linking
  // this finished lot. 0 means "no source allocation recorded yet."
  genealogyLinkCount: number;

  // Product Zoho readiness for the case/display/unit composite items
  productZohoItemIdUnit: string | null;
  productZohoItemIdDisplay: string | null;
  productZohoItemIdCase: string | null;
  productTabletsPerUnit: number | null;

  // Output quantities — used to decide which composite IDs are needed
  casesProduced: number | null;
  displaysProduced: number | null;

  // Zoho production-output op state
  zohoOpId: string | null;
  zohoOpStatus: string | null; // free-text column on the table
  zohoOpCommittedAt: Date | null;
};

export type ProductionOutputClassifiedRow = {
  status: ProductionOutputRowStatus;
  statusLabel: string;
  primaryAction: ProductionOutputRowAction;
  zohoPush: ZohoPushEligibility;
};

const ZOHO_PENDING_STATUSES = new Set<string>([
  "DRAFT",
  "PREVIEWED",
  "APPROVED",
  "QUEUED",
  "PENDING",
  "COMMITTING",
]);

const ZOHO_FAILED_STATUSES = new Set<string>([
  "FAILED",
  "NEEDS_MAPPING",
  "NEEDS_REVIEW",
]);

const BACKLOG_AUTO_ISSUE_CODES = new Set<string>(["OK", "AUTO_ISSUE_NOW"]);
const BACKLOG_ALLOCATION_CODES = new Set<string>([
  "MISSING_ALLOCATION",
  "OPEN_ALLOCATION_ELSEWHERE",
  "MISSING_STARTING_BALANCE",
  "MISSING_OUTPUT_QUANTITY",
]);
const BACKLOG_SETUP_CODES = new Set<string>([
  "MISSING_PRODUCT_SETUP",
  "MISSING_TABLETS_PER_UNIT",
  "MISSING_ZOHO_MAPPING",
]);

/**
 * Classify a row given the raw join shape. Pure — no side effects.
 */
export function classifyProductionOutputRow(
  input: ProductionOutputClassifierInput,
): ProductionOutputClassifiedRow {
  // Stage 1 — terminal states that override everything else.
  if (input.excludedFromOutput === true) {
    return {
      status: "EXCLUDED",
      statusLabel: "Excluded",
      primaryAction: "NONE",
      zohoPush: {
        enabled: false,
        blocker: "MANUAL_REVIEW_REQUIRED",
        message: "Row was excluded from output and is not eligible for Zoho push.",
      },
    };
  }

  // Stage 2 — finished lot exists. Zoho lifecycle dominates.
  if (input.finishedLotId != null) {
    if (input.zohoOpCommittedAt != null) {
      return {
        status: "ZOHO_COMMITTED",
        statusLabel: "Zoho committed",
        primaryAction: "VIEW_ZOHO_OP",
        zohoPush: {
          enabled: false,
          blocker: "ZOHO_ALREADY_COMMITTED",
          message: "Zoho production-output already committed for this finished lot.",
        },
      };
    }
    if (
      input.zohoOpStatus != null &&
      ZOHO_FAILED_STATUSES.has(input.zohoOpStatus)
    ) {
      return {
        status: "ZOHO_FAILED",
        statusLabel: "Zoho needs review",
        primaryAction: "VIEW_ZOHO_OP",
        zohoPush: classifyZohoPushForLot(input, /*hasFailingOp*/ true),
      };
    }
    if (
      input.zohoOpId != null &&
      input.zohoOpStatus != null &&
      ZOHO_PENDING_STATUSES.has(input.zohoOpStatus)
    ) {
      return {
        status: "ZOHO_PENDING",
        statusLabel: `Zoho ${input.zohoOpStatus.toLowerCase()}`,
        primaryAction: "VIEW_ZOHO_OP",
        zohoPush: {
          enabled: false,
          blocker: "MANUAL_REVIEW_REQUIRED",
          message: `Zoho op is ${input.zohoOpStatus}; resolve current op before opening a new push.`,
        },
      };
    }
    // No Zoho op yet — eligible for "Push to Zoho" if everything else
    // lines up.
    return {
      status: "ISSUED_LOT",
      statusLabel: "Finished lot issued",
      primaryAction: pickFinishedLotPrimaryAction(input),
      zohoPush: classifyZohoPushForLot(input, /*hasFailingOp*/ false),
    };
  }

  // Stage 3 — no finished lot. Workflow bag lifecycle decides.
  if (input.finalizedAt == null) {
    if (input.stage === "PACKAGED") {
      return {
        status: "PACKAGED_NOT_FINALIZED",
        statusLabel: "Packaged — awaiting finalization",
        primaryAction: "AWAIT_FINALIZATION",
        zohoPush: {
          enabled: false,
          blocker: "MISSING_FINISHED_LOT",
          message: "Bag is still on the floor; finalize before pushing to Zoho.",
        },
      };
    }
    // No finished lot AND no finalizedAt AND not at PACKAGED — this
    // is a row the unified query surfaced for a search hit on
    // historical workflow data. Mark as awaiting-lot so the badge is
    // honest.
    return {
      status: "AWAITING_LOT",
      statusLabel: "Awaiting lot",
      primaryAction: "REVIEW_MANUALLY",
      zohoPush: {
        enabled: false,
        blocker: "MISSING_FINISHED_LOT",
        message: "No finished lot yet for this workflow bag.",
      },
    };
  }

  // Stage 4 — finalized, no lot. Route on the backlog evaluation code.
  const code = input.backlogActionCode;
  if (code != null && BACKLOG_AUTO_ISSUE_CODES.has(code)) {
    return {
      status: "READY_TO_AUTO_ISSUE",
      statusLabel: "Ready to auto-issue",
      primaryAction: "AUTO_ISSUE_NOW",
      zohoPush: {
        enabled: false,
        blocker: "MISSING_FINISHED_LOT",
        message: "Auto-issue the lot first, then push to Zoho.",
      },
    };
  }
  if (code != null && BACKLOG_ALLOCATION_CODES.has(code)) {
    return {
      status: "MISSING_ALLOCATION",
      statusLabel: "Missing allocation",
      primaryAction: "REPAIR_ALLOCATION",
      zohoPush: {
        enabled: false,
        blocker: "MISSING_ALLOCATION",
        message: "Repair source allocation before issuing the lot.",
      },
    };
  }
  if (code != null && BACKLOG_SETUP_CODES.has(code)) {
    return {
      status: "BLOCKED",
      statusLabel: input.backlogActionLabel ?? "Blocked",
      primaryAction: "FIX_PRODUCT_SETUP",
      zohoPush: {
        enabled: false,
        blocker: "MISSING_PRODUCT_ZOHO_IDS",
        message: "Fix product setup before issuing the lot.",
      },
    };
  }
  return {
    status: "AWAITING_LOT",
    statusLabel: input.backlogActionLabel ?? "Awaiting lot",
    primaryAction: "REVIEW_MANUALLY",
    zohoPush: {
      enabled: false,
      blocker: "MISSING_FINISHED_LOT",
      message: "Issue the finished lot before pushing to Zoho.",
    },
  };
}

function pickFinishedLotPrimaryAction(
  input: ProductionOutputClassifierInput,
): ProductionOutputRowAction {
  const push = classifyZohoPushForLot(input, /*hasFailingOp*/ false);
  if (push.enabled) return "PUSH_TO_ZOHO";
  return "VIEW_FINISHED_LOT";
}

function classifyZohoPushForLot(
  input: ProductionOutputClassifierInput,
  hasFailingOp: boolean,
): ZohoPushEligibility {
  if (input.finishedLotId == null) {
    return {
      enabled: false,
      blocker: "MISSING_FINISHED_LOT",
      message: "Issue the finished lot before pushing to Zoho.",
    };
  }
  if (input.zohoOpCommittedAt != null) {
    return {
      enabled: false,
      blocker: "ZOHO_ALREADY_COMMITTED",
      message: "Zoho production-output already committed.",
    };
  }
  if (input.productTabletsPerUnit == null || input.productTabletsPerUnit <= 0) {
    return {
      enabled: false,
      blocker: "MISSING_TABLETS_PER_UNIT",
      message: "Product is missing tabletsPerUnit — fix product setup before pushing.",
    };
  }
  if (!input.productZohoItemIdUnit) {
    return {
      enabled: false,
      blocker: "MISSING_PRODUCT_ZOHO_IDS",
      message: "Product is missing Zoho unit composite item ID.",
    };
  }
  if (
    (input.displaysProduced ?? 0) > 0 &&
    !input.productZohoItemIdDisplay
  ) {
    return {
      enabled: false,
      blocker: "MISSING_PRODUCT_ZOHO_IDS",
      message: "Product is missing Zoho display composite item ID.",
    };
  }
  if (
    (input.casesProduced ?? 0) > 0 &&
    !input.productZohoItemIdCase
  ) {
    return {
      enabled: false,
      blocker: "MISSING_PRODUCT_ZOHO_IDS",
      message: "Product is missing Zoho case composite item ID.",
    };
  }
  if (input.genealogyLinkCount <= 0) {
    return {
      enabled: false,
      blocker: "MISSING_ALLOCATION",
      message: "No source-bag genealogy recorded; preview will not validate.",
    };
  }
  if (hasFailingOp) {
    return {
      enabled: false,
      blocker: "MANUAL_REVIEW_REQUIRED",
      message: "Resolve the existing Zoho op (NEEDS_MAPPING/REVIEW/FAILED) before opening a new push.",
    };
  }
  return { enabled: true };
}

/**
 * Map a status filter value onto the set of internal statuses it
 * should match. `null` and `all` both match every status.
 */
export function statusFilterMatches(
  filter: ProductionOutputStatusFilter | null,
  status: ProductionOutputRowStatus,
): boolean {
  if (filter == null || filter === "all") return true;
  switch (filter) {
    case "awaiting_lot":
      return (
        status === "AWAITING_LOT" ||
        status === "READY_TO_AUTO_ISSUE" ||
        status === "MISSING_ALLOCATION" ||
        status === "BLOCKED"
      );
    case "ready_to_auto_issue":
      return status === "READY_TO_AUTO_ISSUE";
    case "missing_allocation":
      return status === "MISSING_ALLOCATION";
    case "blocked":
      return status === "BLOCKED";
    case "issued_lot":
      return (
        status === "ISSUED_LOT" ||
        status === "ZOHO_PENDING" ||
        status === "ZOHO_COMMITTED" ||
        status === "ZOHO_FAILED"
      );
    case "zoho_pending":
      return status === "ZOHO_PENDING" || status === "ZOHO_FAILED";
    case "zoho_committed":
      return status === "ZOHO_COMMITTED";
    case "packaged_not_finalized":
      return status === "PACKAGED_NOT_FINALIZED";
  }
}
