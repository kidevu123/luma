// GUIDED-CLOSEOUT-1 — pure dependency-ordered step queue for the guided
// "Close this PO" mode. Derived from the command-center row verdicts; adds
// no policy beyond ordering. Fail closed: unknown actions land in REVIEW.

import { describe, expect, it } from "vitest";
import { deriveGuidedCloseoutQueue, resolveGuidedNav } from "./guided-closeout";
import type { CloseoutBucket } from "./po-closeout";

function row(overrides: Record<string, unknown> = {}) {
  return {
    inventoryBagId: "bag-1",
    receiptNumber: "352001",
    bagNumber: 1,
    tabletName: "Spearmint",
    status: "READY_FOR_ACTION",
    action: "AUTO_ISSUE_FINISHED_LOT",
    reason: "Finalized — ready to issue finished lot",
    actionLabel: "Auto-issue finished lot",
    ...overrides,
  };
}

describe("deriveGuidedCloseoutQueue", () => {
  it("skips DONE rows entirely", () => {
    expect(
      deriveGuidedCloseoutQueue([
        row({ status: "DONE", action: "NONE" }),
        row({ inventoryBagId: "bag-2", receiptNumber: "352002" }),
      ]).steps.map((s) => s.inventoryBagId),
    ).toEqual(["bag-2"]);
  });

  it("maps each verdict action to its phase", () => {
    const cases: Array<[string, string]> = [
      ["REPAIR_QR_RESERVATION", "QR"],
      ["START_OR_FINALIZE_WORKFLOW", "FLOOR"],
      ["CORRECT_STARTING_BALANCE", "PARTIAL"],
      ["RECORD_REMAINING_OR_CLOSE_PARTIAL", "PARTIAL"],
      ["AUTO_ISSUE_FINISHED_LOT", "LOT"],
      ["AUTO_RELEASE_FINISHED_LOT", "QC"],
      ["REVIEW_QC_HOLD", "QC"],
      ["QUEUE_OR_RETRY_ZOHO", "ZOHO"],
      ["FIX_PRODUCT_SETUP", "REVIEW"],
      ["REVIEW_MANUALLY", "REVIEW"],
    ];
    for (const [action, phase] of cases) {
      const [step] = deriveGuidedCloseoutQueue([
        row({ action, status: "NEEDS_REVIEW" }),
      ]).steps;
      expect(step?.phase, action).toBe(phase);
    }
  });

  it("orders steps by dependency phase: QR → floor → partial → lot → QC → Zoho → review", () => {
    const queue = deriveGuidedCloseoutQueue([
      row({ inventoryBagId: "z", action: "QUEUE_OR_RETRY_ZOHO" }),
      row({ inventoryBagId: "r", action: "REVIEW_MANUALLY", status: "NEEDS_REVIEW" }),
      row({ inventoryBagId: "q", action: "REPAIR_QR_RESERVATION" }),
      row({ inventoryBagId: "l", action: "AUTO_ISSUE_FINISHED_LOT" }),
      row({ inventoryBagId: "f", action: "START_OR_FINALIZE_WORKFLOW", status: "NEEDS_REVIEW" }),
      row({ inventoryBagId: "p", action: "CORRECT_STARTING_BALANCE" }),
      row({ inventoryBagId: "c", action: "REVIEW_QC_HOLD", status: "NEEDS_REVIEW" }),
    ]).steps;
    expect(queue.map((s) => s.inventoryBagId)).toEqual([
      "q", "f", "p", "l", "c", "z", "r",
    ]);
  });

  it("marks only floor steps as floorOnly (admins cannot fix those here)", () => {
    const queue = deriveGuidedCloseoutQueue([
      row({ action: "START_OR_FINALIZE_WORKFLOW", status: "NEEDS_REVIEW" }),
      row({ inventoryBagId: "bag-2", action: "AUTO_ISSUE_FINISHED_LOT" }),
    ]).steps;
    expect(queue[0]?.floorOnly).toBe(true);
    expect(queue[1]?.floorOnly).toBe(false);
  });

  it("fail closed: unknown actions land in REVIEW (last), never dropped", () => {
    const queue = deriveGuidedCloseoutQueue([
      row({ action: "SOME_FUTURE_ACTION", status: "NEEDS_REVIEW" }),
      row({ inventoryBagId: "bag-2", action: "REPAIR_QR_RESERVATION" }),
    ]).steps;
    expect(queue.map((s) => s.phase)).toEqual(["QR", "REVIEW"]);
  });

  it("stable within a phase by receipt number", () => {
    const queue = deriveGuidedCloseoutQueue([
      row({ inventoryBagId: "b", receiptNumber: "352005" }),
      row({ inventoryBagId: "a", receiptNumber: "352003" }),
    ]).steps;
    expect(queue.map((s) => s.receiptNumber)).toEqual(["352003", "352005"]);
  });

  it("empty input produces an empty queue", () => {
    expect(deriveGuidedCloseoutQueue([]).steps).toEqual([]);
  });
});

// Minimal row helper shared by the two SIMPLIFY-D describes below — distinct
// from the top-of-file `row(overrides)` helper because these tests only need
// to address rows/steps by id.
function idRow(id: string, action = "ISSUE_FINISHED_LOT") {
  return {
    inventoryBagId: id, receiptNumber: id, bagNumber: 1, tabletName: null,
    status: "READY_FOR_ACTION", action, reason: "r", actionLabel: "a",
  };
}

describe("SIMPLIFY-D: bucket-filtered queue", () => {
  it("excludes ON_FLOOR and EMPTY buckets and counts them", () => {
    const buckets = new Map<string, CloseoutBucket>([
      ["a", "DO_HERE"], ["b", "ON_FLOOR"], ["c", "EMPTY"], ["d", "EMPTY"],
    ]);
    const q = deriveGuidedCloseoutQueue(
      [idRow("a"), idRow("b", "START_OR_FINALIZE_WORKFLOW"), idRow("c"), idRow("d")],
      buckets,
    );
    expect(q.steps.map((s) => s.inventoryBagId)).toEqual(["a"]);
    expect(q.excluded).toEqual({ onFloor: 1, empty: 2 });
  });
  it("rows missing from the bucket map are kept (fail open into the queue, never dropped silently)", () => {
    const q = deriveGuidedCloseoutQueue([idRow("x")], new Map());
    expect(q.steps).toHaveLength(1);
  });
});

describe("SIMPLIFY-D: resolveGuidedNav", () => {
  const steps = [idRow("a"), idRow("b"), idRow("c")].map((r) => ({
    inventoryBagId: r.inventoryBagId, receiptNumber: r.receiptNumber, bagNumber: 1,
    tabletName: null, phase: "LOT" as const, floorOnly: false, reason: "r", actionLabel: "a",
  }));
  it("batch step: next is the first bag (or finish when queue empty)", () => {
    expect(resolveGuidedNav(steps, "batch", true)).toEqual({ mode: "batch", index: null, prevTarget: null, nextTarget: "a" });
    expect(resolveGuidedNav([], "batch", true).nextTarget).toBe("finish");
  });
  it("bag steps chain by identity with batch/exit at the head", () => {
    expect(resolveGuidedNav(steps, "a", true)).toEqual({ mode: "bag", index: 0, prevTarget: "batch", nextTarget: "b" });
    expect(resolveGuidedNav(steps, "a", false).prevTarget).toBeNull();
    expect(resolveGuidedNav(steps, "c", true)).toEqual({ mode: "bag", index: 2, prevTarget: "b", nextTarget: "finish" });
  });
  it("a bag no longer in the queue is bag-done, pointing at the live head", () => {
    expect(resolveGuidedNav(steps, "zz", true)).toEqual({ mode: "bag-done", index: null, prevTarget: null, nextTarget: "a" });
    expect(resolveGuidedNav([], "zz", false).nextTarget).toBe("finish");
  });
  it("finish is terminal", () => {
    expect(resolveGuidedNav(steps, "finish", true).mode).toBe("finish");
  });
});
