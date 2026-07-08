// CLOSEOUT-DRAWER-1 — pure gate deciding which action panels a bag's
// drawer on the PO Closeout page renders. Derived from the row verdict the
// command-center classifier already computed — this module adds no policy of
// its own beyond mapping verdict → panel. Fail closed: DONE rows and
// unknown statuses render nothing; unknown actions add nothing.

export type BagDrawerActionKey =
  | "REPAIR_QR"
  | "ISSUE_LOT"
  | "RELEASE_LOT"
  | "REVIEW_HOLD"
  | "RESOLVE_PARTIAL"
  | "ZOHO_QUEUE"
  | "ZOHO_RETRY"
  | "CORRECTION_WIZARD";

const KNOWN_ROW_STATUSES = new Set([
  "DONE",
  "READY_FOR_ACTION",
  "NEEDS_REVIEW",
  "BLOCKED",
]);

export function deriveApplicableBagActions(input: {
  rowStatus: string;
  rowAction: string;
  zoho: string;
  hasWorkflow: boolean;
  hasFinishedLot: boolean;
  lotStatus: string | null;
  allocationOpen: boolean;
}): BagDrawerActionKey[] {
  if (!KNOWN_ROW_STATUSES.has(input.rowStatus)) return [];
  if (input.rowStatus === "DONE") return [];

  const actions: BagDrawerActionKey[] = [];

  switch (input.rowAction) {
    case "REPAIR_QR_RESERVATION":
      actions.push("REPAIR_QR");
      break;
    case "AUTO_ISSUE_FINISHED_LOT":
      actions.push("ISSUE_LOT");
      break;
    case "AUTO_RELEASE_FINISHED_LOT":
      actions.push("RELEASE_LOT");
      break;
    case "REVIEW_QC_HOLD":
      actions.push("REVIEW_HOLD");
      break;
    case "CORRECT_STARTING_BALANCE":
    case "RECORD_REMAINING_OR_CLOSE_PARTIAL":
      actions.push("RESOLVE_PARTIAL");
      break;
    case "QUEUE_OR_RETRY_ZOHO":
      actions.push(input.zoho === "FAILED" ? "ZOHO_RETRY" : "ZOHO_QUEUE");
      break;
    default:
      // Unknown / NONE / REVIEW_MANUALLY / FIX_PRODUCT_SETUP /
      // START_OR_FINALIZE_WORKFLOW — no direct panel; the drawer still
      // shows the verify panel and the row's reason.
      break;
  }

  // An open allocation with no lot yet is resolvable inline even when the
  // classifier's headline action points elsewhere.
  if (
    input.allocationOpen &&
    !input.hasFinishedLot &&
    input.lotStatus == null &&
    !actions.includes("RESOLVE_PARTIAL")
  ) {
    actions.push("RESOLVE_PARTIAL");
  }

  // The correction wizard is available for any non-DONE bag that has a
  // workflow — admins may need it regardless of the headline action.
  if (input.hasWorkflow) {
    actions.push("CORRECTION_WIZARD");
  }

  return actions;
}
