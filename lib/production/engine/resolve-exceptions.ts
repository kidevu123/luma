// The single source of "why can't I continue?".
//
// evaluateChecks() produces the ordered checklist the ? Help screen
// renders. blockersFromChecks() reduces the same result to the
// Blocker[] carried by NextAction.BLOCKED. Because both come from one
// evaluation, the help screen can never disagree with the button state.

import type { Blocker } from "./types";

export type EngineFacts = {
  bagRecognized: boolean;
  productResolved: boolean;
  operationResolved: boolean;
  materialsAvailable: boolean;
  upstreamStageComplete: boolean;
  bagPaused: boolean;
  bagFinalized: boolean;
  bagOnHold: boolean;
  /** Where the bag is actually waiting, for the WAIT_UPSTREAM message. */
  waitingForLabel: string | null;
};

export type CheckResult = {
  id: string;
  label: string;
  passed: boolean;
  blocker: Blocker | null;
};

function check(
  id: string,
  label: string,
  passed: boolean,
  blocker: Blocker,
): CheckResult {
  return { id, label, passed, blocker: passed ? null : blocker };
}

export function evaluateChecks(facts: EngineFacts): CheckResult[] {
  return [
    check("bag", "Bag recognized", facts.bagRecognized, {
      code: "BAG_UNRECOGNIZED",
      operatorSentence: "This code was not recognized. Try scanning again.",
      supervisorDetail: "No qr_card matched the scanned token.",
      suggestedAction: "SCAN_AGAIN",
    }),
    check("product", "Product recognized", facts.productResolved, {
      code: "PRODUCT_UNRESOLVED",
      operatorSentence:
        "Luma cannot tell which product this bag makes. Ask a supervisor.",
      supervisorDetail:
        "No product mapping for this workflow bag; product_allowed_tablets or the first-op product selection is missing.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("operation", "Station correct", facts.operationResolved, {
      code: "OPERATION_UNRESOLVED",
      operatorSentence: "This bag does not belong at this station.",
      supervisorDetail:
        "No route operation matched this station kind for the bag's route.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("materials", "Materials available", facts.materialsAvailable, {
      code: "MATERIALS_UNAVAILABLE",
      operatorSentence: "Materials for this bag are not loaded.",
      supervisorDetail:
        "Required packaging materials or roll lots are not issued to this station.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("upstream", "Previous step complete", facts.upstreamStageComplete, {
      code: "UPSTREAM_INCOMPLETE",
      operatorSentence: facts.waitingForLabel
        ? `This bag is still being worked on at ${facts.waitingForLabel}.`
        : "This bag is still being worked on at an earlier step.",
      supervisorDetail:
        "The bag has not reached the stage this operation requires.",
      suggestedAction: "WAIT_UPSTREAM",
    }),
    check("hold", "Not on hold", !facts.bagOnHold, {
      code: "BAG_ON_HOLD",
      operatorSentence: "This bag is on hold. Ask a supervisor.",
      supervisorDetail: "read_bag_state.is_on_hold is true.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("paused", "Not paused", !facts.bagPaused, {
      code: "BAG_PAUSED",
      operatorSentence: "This bag is paused. Resume it to continue.",
      supervisorDetail: "read_bag_state.is_paused is true.",
      suggestedAction: "NONE",
    }),
    check("finalized", "Not finished", !facts.bagFinalized, {
      code: "BAG_FINALIZED",
      operatorSentence: "This bag is already finished.",
      supervisorDetail: "read_bag_state.is_finalized is true.",
      suggestedAction: "NONE",
    }),
  ];
}

/** The blocker catalogue keyed by code, so callers outside the checklist
 *  (advanceBag) raise the same Blocker the ? Help screen shows instead of
 *  duplicating the literals. Facts are all-false here — every check
 *  produces its blocker, and we pick by code. */
const BLOCKER_CATALOGUE: ReadonlyMap<string, Blocker> = new Map(
  evaluateChecks({
    bagRecognized: false,
    productResolved: false,
    operationResolved: false,
    materialsAvailable: false,
    upstreamStageComplete: false,
    bagPaused: true,
    bagFinalized: true,
    bagOnHold: true,
    waitingForLabel: null,
  })
    .filter((c): c is CheckResult & { blocker: Blocker } => c.blocker !== null)
    .map((c) => [c.blocker.code, c.blocker]),
);

/** Look up a Blocker by its stable code. Unknown codes fall back to a
 *  generic supervisor prompt rather than throwing — a missing catalogue
 *  entry must never take the floor down. */
export function blockerFor(code: string): Blocker {
  return (
    BLOCKER_CATALOGUE.get(code) ?? {
      code,
      operatorSentence: "Luma cannot continue here. Ask a supervisor.",
      supervisorDetail: `No blocker catalogue entry for code ${code}.`,
      suggestedAction: "NOTIFY_SUPERVISOR",
    }
  );
}

export function blockersFromChecks(checks: readonly CheckResult[]): Blocker[] {
  return checks.filter((c) => !c.passed && c.blocker).map((c) => c.blocker as Blocker);
}
