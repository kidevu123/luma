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
/** Blockers that are NOT checklist rows. The ? Help screen lists things
 *  the operator can reason about ("is the bag on hold?"); these are
 *  Luma-side failures that only advanceBag can hit, so they live in the
 *  catalogue without appearing on the checklist. */
const NON_CHECKLIST_BLOCKERS: readonly Blocker[] = [
  {
    // Distinct from OPERATION_UNRESOLVED ("this bag does not belong at
    // this station"), which is an operator-actionable routing mistake.
    // This one means the stations row itself was not found by id — the
    // station is misconfigured, nothing about the bag is wrong.
    code: "STATION_UNRESOLVED",
    operatorSentence: "Luma does not recognize this station. Ask a supervisor.",
    supervisorDetail: "No stations row matched the stationId on this request.",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
  {
    // P2-QUEUE-1: two stations raced for the same queued bag and this one
    // lost. Distinct from BAG_ON_HOLD (a supervisor decision) and from
    // OPERATION_UNRESOLVED (wrong station for this bag) — the bag is fine
    // and this station is eligible; someone else simply got there first.
    // Not a checklist row: the operator cannot inspect "is another
    // station holding it?" on the tablet, and the answer changes without
    // them doing anything.
    code: "BAG_ALREADY_CLAIMED",
    operatorSentence: "Another station is already working on this bag.",
    supervisorDetail:
      "read_bag_queue.claimed_by_station_id is set to a different station.",
    suggestedAction: "SCAN_AGAIN",
  },
  {
    // raiseProductionException — workflow_events.workflow_bag_id is
    // NOT NULL, so an exception with no workflowBagId supplied falls
    // back to the station's currently pinned bag (read_station_live).
    // When there is no bag active there either, there is nothing to
    // attach the event to. Not a checklist row: this is a precondition
    // of the Report Problem gesture itself, not a reason a bag can't
    // advance.
    code: "PRODUCTION_EXCEPTION_NO_BAG",
    operatorSentence:
      "Scan the bag this is about first, or ask a supervisor to log it.",
    supervisorDetail:
      "No workflowBagId was supplied and read_station_live has no current bag for this station.",
    suggestedAction: "SCAN_AGAIN",
  },
  {
    // raiseProductionException refuses to write an empty exception —
    // an operator-actionable input mistake, not a routing failure.
    code: "PRODUCTION_EXCEPTION_DETAIL_REQUIRED",
    operatorSentence: "Add a short note about what's wrong before sending.",
    supervisorDetail: "raiseProductionException received an empty detail string.",
    suggestedAction: "NONE",
  },
  // ── Dynamic-detail blockers (advance.ts) ─────────────────────────────
  // These four codes have FIXED operator sentences and action hints but
  // RUNTIME supervisorDetail values (an error message from a DB helper or
  // the catch block). They live in the catalogue for the static fields
  // so advance.ts can call blockerForWithDetail(code, runtimeDetail)
  // instead of repeating the operator sentence and suggestedAction inline.
  // P1 deferred "ADVANCE_REJECTED / ADVANCE_FAILED are literals" — now
  // resolved; P5 added OPEN_ALLOCATION_ON_BAG and PRODUCT_ASSIGN_REJECTED,
  // giving four dynamic-detail codes (≥3 → factory built per plan).
  {
    code: "ADVANCE_FAILED",
    operatorSentence: "Something went wrong recording this. Ask a supervisor.",
    supervisorDetail: "(runtime error message)",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
  {
    code: "ADVANCE_REJECTED",
    operatorSentence: "This step could not be recorded. Ask a supervisor.",
    supervisorDetail: "(runtime rejection reason)",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
  {
    code: "OPEN_ALLOCATION_ON_BAG",
    operatorSentence: "This bag is still open from a previous run. Ask a supervisor.",
    supervisorDetail: "(runtime allocation block message)",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
  {
    code: "PRODUCT_ASSIGN_REJECTED",
    operatorSentence:
      "This product could not be saved on the bag. Ask a supervisor.",
    supervisorDetail: "(runtime assignment rejection reason)",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
];

const BLOCKER_CATALOGUE: ReadonlyMap<string, Blocker> = new Map([
  ...NON_CHECKLIST_BLOCKERS.map((b) => [b.code, b] as const),
  ...evaluateChecks({
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
    .map((c) => [c.blocker.code, c.blocker] as const),
]);

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

/** Variant of blockerFor for codes whose operatorSentence and
 *  suggestedAction are fixed (in the catalogue) but whose supervisorDetail
 *  is only known at runtime (e.g. an error message from a DB helper).
 *
 *  Pulls the static fields from BLOCKER_CATALOGUE and substitutes the
 *  caller-supplied detail. Falls back to the same generic Blocker as
 *  blockerFor so an unknown code never throws. */
export function blockerForWithDetail(code: string, supervisorDetail: string): Blocker {
  const base = blockerFor(code);
  return { ...base, supervisorDetail };
}

export function blockersFromChecks(checks: readonly CheckResult[]): Blocker[] {
  return checks.filter((c) => !c.passed && c.blocker).map((c) => c.blocker as Blocker);
}
