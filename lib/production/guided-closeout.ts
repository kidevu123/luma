// GUIDED-CLOSEOUT-1 — pure dependency-ordered step queue for the guided
// "Close this PO" mode. Consumes the command-center row verdicts the page
// already computed; adds no policy beyond ordering and the floor-only
// marker. Recomputed from live rows on every server render, so steps
// disappear as work completes (never snapshotted). Fail closed: unknown
// actions land in REVIEW at the end — never dropped.

import type { CloseoutBucket } from "./po-closeout";

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
    case "ISSUE_FINISHED_LOT":
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
  buckets?: Map<string, CloseoutBucket>,
): { steps: GuidedStep[]; excluded: { onFloor: number; empty: number } } {
  let onFloor = 0;
  let empty = 0;
  const actionable = rows.filter((r) => {
    if (r.status === "DONE") return false;
    const bucket = buckets?.get(r.inventoryBagId);
    if (bucket === "ON_FLOOR") {
      onFloor += 1;
      return false;
    }
    if (bucket === "EMPTY") {
      empty += 1;
      return false;
    }
    return true; // no bucket info: fail open — a bag is never silently dropped
  });
  const steps = actionable
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
  return { steps, excluded: { onFloor, empty } };
}

// ── SIMPLIFY-D · bag-addressed navigation ───────────────────────────────────
// Steps are addressed by inventoryBagId (never by index) so a bag resolved
// out-of-band shortens the queue instead of silently skipping a neighbor.
// "batch" and "finish" are sentinels; a bag id not in the live queue is
// "bag-done" — the operator sees it completed and continues at the head.

export type GuidedTarget = "batch" | "finish" | (string & {});

export function resolveGuidedNav(
  steps: GuidedStep[],
  current: GuidedTarget,
  hasSafeBatch: boolean,
): {
  mode: "batch" | "finish" | "bag" | "bag-done";
  index: number | null;
  prevTarget: GuidedTarget | null;
  nextTarget: GuidedTarget;
} {
  const first: GuidedTarget = steps[0]?.inventoryBagId ?? "finish";
  if (current === "batch") return { mode: "batch", index: null, prevTarget: null, nextTarget: first };
  if (current === "finish") return { mode: "finish", index: null, prevTarget: null, nextTarget: "finish" };
  const index = steps.findIndex((s) => s.inventoryBagId === current);
  if (index === -1) return { mode: "bag-done", index: null, prevTarget: null, nextTarget: first };
  const prevTarget: GuidedTarget | null =
    index > 0 ? steps[index - 1]!.inventoryBagId : hasSafeBatch ? "batch" : null;
  const nextTarget: GuidedTarget = steps[index + 1]?.inventoryBagId ?? "finish";
  return { mode: "bag", index, prevTarget, nextTarget };
}
