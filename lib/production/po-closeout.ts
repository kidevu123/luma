// PO-CLOSEOUT-COMMAND-CENTER-1 — pure classifier for a single bag/receipt row on
// the PO Closeout Command Center. It COMPOSES the outputs of the existing pure
// classifiers (floor readiness, inventory-bag lifecycle, auto-issue backlog
// eligibility, finished-lot release eligibility, QR intake guard, open-session
// rebase) into one closeout verdict — it does NOT re-implement any of them.
//
// The verdict answers, per bag: "what is the single most important next step,
// and can Luma safely do it (READY), does a human need to decide (NEEDS_REVIEW),
// or is it stuck on missing data/setup (BLOCKED), or is it DONE?"
//
// Fail closed: anything ambiguous or unexpected → NEEDS_REVIEW with a precise
// reason. Never throws.

export type PoCloseoutRowStatus =
  | "DONE"
  | "READY_FOR_ACTION"
  | "NEEDS_REVIEW"
  | "BLOCKED";

/** Which safe action (if any) the row recommends. Batch buttons act only on the
 *  two Luma-owned safe transitions; everything else links to an existing page. */
export type PoCloseoutAction =
  | "NONE"
  | "REPAIR_QR_RESERVATION"
  | "START_OR_FINALIZE_WORKFLOW"
  | "CORRECT_STARTING_BALANCE"
  | "RECORD_REMAINING_OR_CLOSE_PARTIAL"
  | "AUTO_ISSUE_FINISHED_LOT"
  | "AUTO_RELEASE_FINISHED_LOT"
  | "REVIEW_QC_HOLD"
  | "FIX_PRODUCT_SETUP"
  | "QUEUE_OR_RETRY_ZOHO"
  | "REVIEW_MANUALLY";

export type PoCloseoutZohoStatus =
  | "NOT_APPLICABLE"
  | "NOT_READY"
  | "READY_TO_QUEUE"
  | "QUEUED"
  | "COMMITTED"
  | "FAILED"
  | "UNCLEAR";

/** Per-step checklist. `null` = not applicable / not yet reached. */
export type PoCloseoutChecklist = {
  received: boolean;
  qrReadyOrReleased: boolean;
  floorFinalizedOrExcluded: boolean;
  allocationResolved: boolean;
  partialResolved: boolean;
  finishedLotIssued: boolean;
  finishedLotReleasedOrHeld: boolean;
  zohoQueuedOrCommittedOrNa: boolean;
  noBlocker: boolean;
};

export type PoCloseoutRowInput = {
  // ---- identity / display ----
  inventoryBagId: string;
  bagNumber: number | null;
  receiptNumber: string | null;
  tabletName: string | null;
  bagQrCode: string | null;
  workflowBagId: string | null;
  finishedLotId: string | null;
  finishedLotNumber: string | null;
  receiveId: string | null;

  // ---- normalized facts ----
  bagStatus: string;
  hasReceiveContext: boolean;
  tabletTypeId: string | null;
  hasWorkflow: boolean;
  workflowFinalized: boolean;
  excludedFromOutput: boolean;
  hasFinishedLot: boolean;
  lotStatus: string | null; // finished_lots.status

  // ---- outputs of existing classifiers (already evaluated by the loader) ----
  /** floor-readiness codes for the bag (BLOCKED_* / WARNING_*). */
  floorReadinessCodes: string[];
  /** canRepairQrReservation(...).ok — a genuine AVAILABLE lost intake reservation. */
  qrRepairSafe: boolean;
  /** true when the bag's QR is idle-pointed but NOT a safe intake reservation. */
  qrIdleUnsafe: boolean;
  /** evaluateAutoLotBacklogRow verdict, only when finalized + no lot. */
  autoIssue:
    | {
        autoIssuable: boolean;
        action: "AUTO_ISSUE_NOW" | "REPAIR_ALLOCATION" | "FIX_PRODUCT_SETUP" | "REVIEW_MANUALLY" | "NONE";
        label: string;
        nextStep: string;
      }
    | null;
  /** computeOpenSessionRebaseEligibility(...).available — a safe starting-balance correction. */
  rebaseAvailable: boolean;
  /** classifyFinishedLotReleaseEligibility verdict, only when lot is PENDING_QC. */
  releaseStatus: "AUTO_RELEASE_READY" | "NEEDS_QC_REVIEW" | "BLOCKED" | "ALREADY_RELEASED" | "NOT_FOUND" | null;
  releaseMessage: string | null;
  zoho: PoCloseoutZohoStatus;
};

export type PoCloseoutRowVerdict = {
  status: PoCloseoutRowStatus;
  reason: string;
  action: PoCloseoutAction;
  /** Short imperative label for the recommended next action. */
  actionLabel: string;
  checklist: PoCloseoutChecklist;
};

const FLOOR_BLOCK_CODES = new Set([
  "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT",
  "BLOCKED_MISSING_RECEIPT",
  "BLOCKED_MISSING_TABLET",
  "BLOCKED_MISSING_QR_LINK",
  "BLOCKED_MISSING_INVENTORY_BAG_LINK",
  "BLOCKED_QR_NOT_RAW_BAG",
]);

function firstFloorBlock(codes: string[]): string | null {
  for (const c of codes) if (FLOOR_BLOCK_CODES.has(c)) return c;
  return null;
}

function floorBlockReason(code: string): { reason: string; action: PoCloseoutAction; label: string } {
  switch (code) {
    case "BLOCKED_MISSING_RECEIPT":
      return { reason: "Missing receipt number", action: "REVIEW_MANUALLY", label: "Fix at receiving" };
    case "BLOCKED_MISSING_TABLET":
      return { reason: "Missing tablet/flavor", action: "REVIEW_MANUALLY", label: "Fix at receiving" };
    case "BLOCKED_MISSING_QR_LINK":
      return { reason: "No physical QR assigned", action: "REVIEW_MANUALLY", label: "Assign QR at receiving" };
    case "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT":
      return { reason: "Missing receive / PO link", action: "REVIEW_MANUALLY", label: "Fix receive linkage" };
    default:
      return { reason: "Receiving data incomplete", action: "REVIEW_MANUALLY", label: "Fix at receiving" };
  }
}

/** Terminal, resolved allocation states (bag is closed out on the ledger). */
function allocationIsResolved(input: PoCloseoutRowInput): boolean {
  // A finalized bag with a finished lot has had its allocation closed at issue.
  // A depleted/available bag is resolved. An open allocation with no finalized
  // finalize/lot is either active (fine) or awaiting lot (handled elsewhere).
  if (input.hasFinishedLot) return true;
  if (input.bagStatus === "EMPTIED" || input.bagStatus === "AVAILABLE") return true;
  return false;
}

export function classifyPoCloseoutRow(input: PoCloseoutRowInput): PoCloseoutRowVerdict {
  const checklist: PoCloseoutChecklist = {
    received: input.hasReceiveContext && !!input.receiptNumber,
    qrReadyOrReleased: false,
    floorFinalizedOrExcluded: input.workflowFinalized || input.excludedFromOutput,
    allocationResolved: allocationIsResolved(input),
    partialResolved: allocationIsResolved(input),
    finishedLotIssued: input.hasFinishedLot,
    finishedLotReleasedOrHeld:
      input.lotStatus === "RELEASED" ||
      input.lotStatus === "ON_HOLD" ||
      input.lotStatus === "SHIPPED" ||
      input.lotStatus === "RECALLED",
    zohoQueuedOrCommittedOrNa:
      input.zoho === "COMMITTED" || input.zoho === "QUEUED" || input.zoho === "NOT_APPLICABLE",
    noBlocker: true,
  };

  const done = (reason: string): PoCloseoutRowVerdict => ({
    status: "DONE",
    reason,
    action: "NONE",
    actionLabel: "Done — no action needed",
    checklist: { ...checklist, noBlocker: true },
  });
  const verdict = (
    status: PoCloseoutRowStatus,
    reason: string,
    action: PoCloseoutAction,
    actionLabel: string,
  ): PoCloseoutRowVerdict => ({
    status,
    reason,
    action,
    actionLabel,
    checklist: { ...checklist, noBlocker: status !== "BLOCKED" },
  });

  // ── Step 0 — receiving data completeness (hard blockers) ────────────────
  const block = firstFloorBlock(input.floorReadinessCodes);
  if (block) {
    checklist.qrReadyOrReleased = false;
    const b = floorBlockReason(block);
    return verdict("BLOCKED", b.reason, b.action, b.label);
  }

  // ── Step 1 — QR reservation state ───────────────────────────────────────
  if (input.bagStatus === "AVAILABLE" && input.qrRepairSafe) {
    checklist.qrReadyOrReleased = false;
    return verdict(
      "READY_FOR_ACTION",
      "QR is set but idle (reservation lost)",
      "REPAIR_QR_RESERVATION",
      "Repair QR reservation",
    );
  }
  // QR that is idle on an AVAILABLE bag but not safe-repairable = review.
  if (input.bagStatus === "AVAILABLE" && input.qrIdleUnsafe) {
    checklist.qrReadyOrReleased = false;
    return verdict(
      "NEEDS_REVIEW",
      "QR idle and not safely re-reservable",
      "REVIEW_MANUALLY",
      "Review QR state",
    );
  }
  // Past this point the QR is either assigned, released post-production, or NA.
  checklist.qrReadyOrReleased = true;

  // ── Step 2 — floor workflow ─────────────────────────────────────────────
  if (input.excludedFromOutput) {
    checklist.floorFinalizedOrExcluded = true;
    return done("Excluded from output — no finished lot expected");
  }
  if (!input.hasWorkflow) {
    // Received but never started on the floor. Depleted-with-no-workflow is odd.
    if (input.bagStatus === "EMPTIED") {
      return verdict("NEEDS_REVIEW", "Emptied but no production run recorded", "REVIEW_MANUALLY", "Review manually");
    }
    return verdict(
      "NEEDS_REVIEW",
      "Received, not yet processed on the floor",
      "START_OR_FINALIZE_WORKFLOW",
      "Start on floor (or exclude)",
    );
  }
  if (!input.workflowFinalized) {
    return verdict(
      "NEEDS_REVIEW",
      "Production run in progress on the floor",
      "START_OR_FINALIZE_WORKFLOW",
      "Finalize on floor",
    );
  }
  checklist.floorFinalizedOrExcluded = true;

  // ── Step 3 — finalized, awaiting finished lot ───────────────────────────
  if (!input.hasFinishedLot) {
    checklist.finishedLotIssued = false;
    const ai = input.autoIssue;
    if (ai?.autoIssuable) {
      return verdict("READY_FOR_ACTION", "Finalized — ready to issue finished lot", "AUTO_ISSUE_FINISHED_LOT", "Auto-issue finished lot");
    }
    if (ai?.action === "REPAIR_ALLOCATION") {
      if (input.rebaseAvailable) {
        return verdict("READY_FOR_ACTION", "Split/partial bag: starting balance can be corrected", "CORRECT_STARTING_BALANCE", "Correct starting balance");
      }
      return verdict("NEEDS_REVIEW", ai.nextStep || "Split/partial bag needs a remaining balance", "RECORD_REMAINING_OR_CLOSE_PARTIAL", "Record remaining / close partial");
    }
    if (ai?.action === "FIX_PRODUCT_SETUP") {
      return verdict("BLOCKED", ai.nextStep || "Product setup incomplete", "FIX_PRODUCT_SETUP", "Fix product setup");
    }
    // Unknown / review / no eval → fail closed.
    return verdict("NEEDS_REVIEW", ai?.nextStep || "Finalized but not yet issued — review", "REVIEW_MANUALLY", "Review manually");
  }
  checklist.finishedLotIssued = true;

  // ── Step 4 — finished lot QC / release ──────────────────────────────────
  if (input.lotStatus === "PENDING_QC") {
    checklist.finishedLotReleasedOrHeld = false;
    switch (input.releaseStatus) {
      case "AUTO_RELEASE_READY":
        return verdict("READY_FOR_ACTION", "Pending QC — safe to release", "AUTO_RELEASE_FINISHED_LOT", "Auto-release lot");
      case "NEEDS_QC_REVIEW":
        return verdict("NEEDS_REVIEW", input.releaseMessage || "Pending QC — needs review", "REVIEW_QC_HOLD", "Review QC");
      case "BLOCKED":
        return verdict("BLOCKED", input.releaseMessage || "Pending QC — blocked", "FIX_PRODUCT_SETUP", "Resolve blocker");
      default:
        return verdict("NEEDS_REVIEW", "Pending QC — status unclear", "REVIEW_MANUALLY", "Review manually");
    }
  }
  if (input.lotStatus === "ON_HOLD") {
    checklist.finishedLotReleasedOrHeld = true; // held is a valid resting state
    return verdict("NEEDS_REVIEW", "Finished lot is on QC hold", "REVIEW_QC_HOLD", "Review QC hold");
  }
  if (input.lotStatus !== "RELEASED" && input.lotStatus !== "SHIPPED" && input.lotStatus !== "RECALLED") {
    return verdict("NEEDS_REVIEW", `Finished lot status ${input.lotStatus ?? "unknown"} — review`, "REVIEW_MANUALLY", "Review manually");
  }
  checklist.finishedLotReleasedOrHeld = true;

  // ── Step 5 — Zoho output ────────────────────────────────────────────────
  switch (input.zoho) {
    case "COMMITTED":
      return done("Released and committed to Zoho");
    case "QUEUED":
      return done("Released — Zoho output queued");
    case "NOT_APPLICABLE":
      return done("Released — Zoho output not required");
    case "FAILED":
      return verdict("BLOCKED", "Failed Zoho output op", "QUEUE_OR_RETRY_ZOHO", "Retry in Zoho operations");
    case "READY_TO_QUEUE":
      return verdict("READY_FOR_ACTION", "Released — ready to queue for Zoho", "QUEUE_OR_RETRY_ZOHO", "Queue in Zoho operations");
    case "NOT_READY":
      return verdict("NEEDS_REVIEW", "Released — Zoho output not ready", "QUEUE_OR_RETRY_ZOHO", "Review Zoho readiness");
    default:
      return verdict("NEEDS_REVIEW", "Zoho status unclear", "REVIEW_MANUALLY", "Review Zoho status");
  }
}

// ── PO-level rollup ─────────────────────────────────────────────────────────

export type PoCloseoutOverallStatus = "DONE" | "ACTION_READY" | "NEEDS_REVIEW" | "BLOCKED";

export function derivePoOverallStatus(rowStatuses: PoCloseoutRowStatus[]): PoCloseoutOverallStatus {
  if (rowStatuses.some((s) => s === "BLOCKED")) return "BLOCKED";
  if (rowStatuses.some((s) => s === "NEEDS_REVIEW")) return "NEEDS_REVIEW";
  if (rowStatuses.some((s) => s === "READY_FOR_ACTION")) return "ACTION_READY";
  return "DONE";
}

export function summarizeRowStatuses(rowStatuses: PoCloseoutRowStatus[]): {
  total: number;
  done: number;
  readyForAction: number;
  needsReview: number;
  blocked: number;
} {
  return {
    total: rowStatuses.length,
    done: rowStatuses.filter((s) => s === "DONE").length,
    readyForAction: rowStatuses.filter((s) => s === "READY_FOR_ACTION").length,
    needsReview: rowStatuses.filter((s) => s === "NEEDS_REVIEW").length,
    blocked: rowStatuses.filter((s) => s === "BLOCKED").length,
  };
}
