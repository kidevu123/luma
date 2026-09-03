// CLOSEOUT-DRAWER-1 — pure gate deciding which action panels a bag's
// drawer renders. Fail closed: anything unmatched renders nothing.

import { describe, expect, it } from "vitest";
import {
  deriveApplicableBagActions,
  derivePrimaryBagAction,
  type BagDrawerActionKey,
} from "./bag-closeout-actions";

function base() {
  return {
    rowStatus: "READY_FOR_ACTION",
    rowAction: "NONE",
    zoho: "NOT_APPLICABLE",
    hasWorkflow: true,
    hasFinishedLot: false,
    lotStatus: null as string | null,
    allocationOpen: false,
  };
}

function expectActions(
  overrides: Partial<ReturnType<typeof base>>,
  expected: BagDrawerActionKey[],
) {
  const got = deriveApplicableBagActions({ ...base(), ...overrides });
  for (const key of expected) expect(got).toContain(key);
  return got;
}

describe("deriveApplicableBagActions — verdict mapping", () => {
  it("QR repair", () => {
    expectActions({ rowAction: "REPAIR_QR_RESERVATION", hasWorkflow: false }, ["REPAIR_QR"]);
  });

  it("auto-issue finished lot", () => {
    expectActions({ rowAction: "AUTO_ISSUE_FINISHED_LOT" }, ["ISSUE_LOT"]);
  });

  it("auto-release lot", () => {
    expectActions(
      { rowAction: "AUTO_RELEASE_FINISHED_LOT", hasFinishedLot: true, lotStatus: "PENDING_QC" },
      ["RELEASE_LOT"],
    );
  });

  it("QC hold review", () => {
    expectActions(
      { rowAction: "REVIEW_QC_HOLD", rowStatus: "NEEDS_REVIEW", hasFinishedLot: true, lotStatus: "ON_HOLD" },
      ["REVIEW_HOLD"],
    );
  });

  it("partial resolution for both partial verdicts", () => {
    expectActions({ rowAction: "CORRECT_STARTING_BALANCE" }, ["RESOLVE_PARTIAL"]);
    // RECORD_REMAINING_OR_CLOSE_PARTIAL only opens the panel when an allocation
    // session is actually open (otherwise the panel has nothing to act on).
    expectActions(
      { rowAction: "RECORD_REMAINING_OR_CLOSE_PARTIAL", rowStatus: "NEEDS_REVIEW", allocationOpen: true },
      ["RESOLVE_PARTIAL"],
    );
  });

  it("partial resolution also offered when allocation is open with no lot yet", () => {
    expectActions(
      { rowAction: "REVIEW_MANUALLY", rowStatus: "NEEDS_REVIEW", allocationOpen: true },
      ["RESOLVE_PARTIAL"],
    );
  });

  it("zoho queue vs retry by zoho status", () => {
    expectActions(
      { rowAction: "QUEUE_OR_RETRY_ZOHO", zoho: "READY_TO_QUEUE", hasFinishedLot: true, lotStatus: "RELEASED" },
      ["ZOHO_QUEUE"],
    );
    expectActions(
      { rowAction: "QUEUE_OR_RETRY_ZOHO", zoho: "FAILED", rowStatus: "NEEDS_REVIEW", hasFinishedLot: true, lotStatus: "RELEASED" },
      ["ZOHO_RETRY"],
    );
  });
});

describe("deriveApplicableBagActions — correction wizard availability", () => {
  it("wizard available for any non-DONE row with a workflow", () => {
    const got = expectActions(
      { rowAction: "REVIEW_MANUALLY", rowStatus: "NEEDS_REVIEW" },
      ["CORRECTION_WIZARD"],
    );
    expect(got).toContain("CORRECTION_WIZARD");
  });

  it("wizard absent without a workflow", () => {
    const got = deriveApplicableBagActions({
      ...base(),
      hasWorkflow: false,
      rowAction: "REVIEW_MANUALLY",
      rowStatus: "NEEDS_REVIEW",
    });
    expect(got).not.toContain("CORRECTION_WIZARD");
  });
});

describe("deriveApplicableBagActions — ISSUE_FINISHED_LOT and partial gate", () => {
  it("ISSUE_FINISHED_LOT maps to the issue-lot panel", () => {
    const actions = deriveApplicableBagActions({
      rowStatus: "READY_FOR_ACTION",
      rowAction: "ISSUE_FINISHED_LOT",
      zoho: "NOT_APPLICABLE",
      hasWorkflow: true,
      hasFinishedLot: false,
      lotStatus: null,
      allocationOpen: false,
    });
    expect(actions).toContain("ISSUE_LOT");
    expect(actions).not.toContain("RESOLVE_PARTIAL");
  });

  it("RECORD_REMAINING_OR_CLOSE_PARTIAL without an open session shows no partial panel", () => {
    const actions = deriveApplicableBagActions({
      rowStatus: "NEEDS_REVIEW",
      rowAction: "RECORD_REMAINING_OR_CLOSE_PARTIAL",
      zoho: "NOT_APPLICABLE",
      hasWorkflow: true,
      hasFinishedLot: false,
      lotStatus: null,
      allocationOpen: false,
    });
    expect(actions).not.toContain("RESOLVE_PARTIAL");
  });

  it("RECORD_REMAINING_OR_CLOSE_PARTIAL with an open session keeps the partial panel", () => {
    const actions = deriveApplicableBagActions({
      rowStatus: "NEEDS_REVIEW",
      rowAction: "RECORD_REMAINING_OR_CLOSE_PARTIAL",
      zoho: "NOT_APPLICABLE",
      hasWorkflow: true,
      hasFinishedLot: false,
      lotStatus: null,
      allocationOpen: true,
    });
    expect(actions).toContain("RESOLVE_PARTIAL");
  });
});

describe("SIMPLIFY-C: Zoho panels only when actionable", () => {
  const base = {
    rowStatus: "NEEDS_REVIEW",
    rowAction: "QUEUE_OR_RETRY_ZOHO",
    hasWorkflow: true,
    hasFinishedLot: true,
    lotStatus: "RELEASED",
    allocationOpen: false,
  };
  it("NOT_READY renders no Zoho panel (mapping is fixed at product/PO level)", () => {
    expect(deriveApplicableBagActions({ ...base, zoho: "NOT_READY" })).not.toContain("ZOHO_QUEUE");
    expect(deriveApplicableBagActions({ ...base, zoho: "NOT_READY" })).not.toContain("ZOHO_RETRY");
  });
  it("READY_TO_QUEUE still queues; FAILED still retries", () => {
    expect(
      deriveApplicableBagActions({ ...base, rowStatus: "READY_FOR_ACTION", zoho: "READY_TO_QUEUE" }),
    ).toContain("ZOHO_QUEUE");
    expect(deriveApplicableBagActions({ ...base, zoho: "FAILED" })).toContain("ZOHO_RETRY");
  });
});

describe("deriveApplicableBagActions — fail closed", () => {
  it("DONE rows render no actions at all", () => {
    expect(
      deriveApplicableBagActions({
        ...base(),
        rowStatus: "DONE",
        rowAction: "NONE",
        hasFinishedLot: true,
        lotStatus: "RELEASED",
        zoho: "COMMITTED",
      }),
    ).toEqual([]);
  });

  it("unknown action strings add nothing beyond the wizard", () => {
    const got = deriveApplicableBagActions({
      ...base(),
      rowStatus: "NEEDS_REVIEW",
      rowAction: "SOME_FUTURE_ACTION",
    });
    expect(got).toEqual(["CORRECTION_WIZARD"]);
  });

  it("unknown row status renders nothing", () => {
    expect(
      deriveApplicableBagActions({
        ...base(),
        rowStatus: "SOMETHING_NEW",
        rowAction: "AUTO_ISSUE_FINISHED_LOT",
      }),
    ).toEqual([]);
  });
});

describe("SIMPLIFY-D: derivePrimaryBagAction", () => {
  it("first non-correction key wins; correction alone yields null", () => {
    expect(derivePrimaryBagAction(["ISSUE_LOT", "CORRECTION_WIZARD"])).toBe("ISSUE_LOT");
    expect(derivePrimaryBagAction(["CORRECTION_WIZARD"])).toBeNull();
    expect(derivePrimaryBagAction([])).toBeNull();
  });
});
