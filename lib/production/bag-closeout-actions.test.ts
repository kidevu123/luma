// CLOSEOUT-DRAWER-1 — pure gate deciding which action panels a bag's
// drawer renders. Fail closed: anything unmatched renders nothing.

import { describe, expect, it } from "vitest";
import {
  deriveApplicableBagActions,
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
    expectActions(
      { rowAction: "RECORD_REMAINING_OR_CLOSE_PARTIAL", rowStatus: "NEEDS_REVIEW" },
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
      { rowAction: "QUEUE_OR_RETRY_ZOHO", zoho: "FAILED", rowStatus: "BLOCKED", hasFinishedLot: true, lotStatus: "RELEASED" },
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
