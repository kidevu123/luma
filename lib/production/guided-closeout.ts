// GUIDED-CLOSEOUT-1 — pure dependency-ordered step queue for the guided
// "Close this PO" mode. Consumes the command-center row verdicts the page
// already computed; adds no policy beyond ordering and the floor-only
// marker. Recomputed from live rows on every server render, so steps
// disappear as work completes (never snapshotted). Fail closed: unknown
// actions land in REVIEW at the end — never dropped.

export type GuidedPhase =
  | "QR"
  | "FLOOR"
  | "PARTIAL"
  | "LOT"
  | "QC"
  | "ZOHO"
  | "REVIEW";

export type GuidedStep = {
  inventoryBagId: string;
  receiptNumber: string | null;
  bagNumber: number | null;
  tabletName: string | null;
  phase: GuidedPhase;
  /** True when only the floor can move this bag — the step renders
   *  "needs the floor — skip for now", never an admin fix. */
  floorOnly: boolean;
  reason: string;
  actionLabel: string;
};

const PHASE_RANK: Record<GuidedPhase, number> = {
  QR: 0,
  FLOOR: 1,
  PARTIAL: 2,
  LOT: 3,
  QC: 4,
  ZOHO: 5,
  REVIEW: 6,
};

function phaseForAction(action: string): GuidedPhase {
  switch (action) {
    case "REPAIR_QR_RESERVATION":
      return "QR";
    case "START_OR_FINALIZE_WORKFLOW":
      return "FLOOR";
    case "CORRECT_STARTING_BALANCE":
    case "RECORD_REMAINING_OR_CLOSE_PARTIAL":
      return "PARTIAL";
    case "AUTO_ISSUE_FINISHED_LOT":
      return "LOT";
    case "AUTO_RELEASE_FINISHED_LOT":
    case "REVIEW_QC_HOLD":
      return "QC";
    case "QUEUE_OR_RETRY_ZOHO":
      return "ZOHO";
    default:
      return "REVIEW";
  }
}

export function deriveGuidedCloseoutQueue(
  rows: Array<{
    inventoryBagId: string;
    receiptNumber: string | null;
    bagNumber: number | null;
    tabletName: string | null;
    status: string;
    action: string;
    reason: string;
    actionLabel: string;
  }>,
): GuidedStep[] {
  return rows
    .filter((r) => r.status !== "DONE")
    .map((r) => {
      const phase = phaseForAction(r.action);
      return {
        inventoryBagId: r.inventoryBagId,
        receiptNumber: r.receiptNumber,
        bagNumber: r.bagNumber,
        tabletName: r.tabletName,
        phase,
        floorOnly: phase === "FLOOR",
        reason: r.reason,
        actionLabel: r.actionLabel,
      };
    })
    .sort((a, b) => {
      const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
      if (rank !== 0) return rank;
      return (a.receiptNumber ?? "").localeCompare(b.receiptNumber ?? "");
    });
}
