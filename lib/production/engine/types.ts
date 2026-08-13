// The engine's public contract. Code under app/(floor)/ imports from
// lib/production/engine and nowhere else in lib/production — see the
// ESLint boundary added in Task 5.

export type Blocker = {
  /** Stable, greppable identifier. Never shown to operators. */
  code: string;
  /** Plain language, no jargon, no stage names. Shown on the tablet. */
  operatorSentence: string;
  /** The real reason, shown only under supervisor unlock. */
  supervisorDetail: string;
  suggestedAction:
    | "SCAN_AGAIN"
    | "NOTIFY_SUPERVISOR"
    | "WAIT_UPSTREAM"
    | "ENTER_QUANTITY"
    | "NONE";
};

/** One physical input the operator must supply to complete this
 *  operation. Derived from route_operations, never from a station-kind
 *  switch statement. */
export type CompletionInput = {
  key: "counter" | "damaged" | "cases" | "displays" | "loose";
  label: string;
  unit: string | null;
  required: boolean;
};

export type CurrentWork = {
  workflowBagId: string;
  /** buildCurrentBagDisplayLabel().primary — e.g. "PO 1234 - Chocolate Brown - Bag 12". */
  bagLabel: string;
  /** buildCurrentBagDisplayLabel().secondary — the raw QR card label, shown as
   *  a subline beneath bagLabel. page.tsx renders this today; dropping it
   *  would be a visible change, which Phase 1 forbids. */
  bagSubLabel: string | null;
  productName: string | null;
  /** Operator-facing status, e.g. "Ready to seal". Never a stage name. */
  statusLine: string;
  progress: { done: number; expected: number; unit: string } | null;
};

export type UpNextBag = {
  workflowBagId: string;
  bagLabel: string;
  productName: string | null;
  readyState: "READY" | "UPSTREAM_RUNNING";
  etaMinutes: number | null;
};

export type NextAction =
  | { kind: "OPEN_SHIFT" }
  | { kind: "SCAN_TO_CLAIM"; expected: UpNextBag | null }
  | { kind: "START"; label: string }
  | { kind: "COMPLETE"; label: string; inputs: CompletionInput[] }
  | { kind: "CONFIRM_BAG_EMPTY" }
  | { kind: "RESOLVE_PARTIAL"; estimate: number | null; needsEntry: boolean }
  | { kind: "BLOCKED"; blockers: Blocker[] };

export type StationView = {
  station: {
    id: string;
    label: string;
    kind: string;
    machineName: string | null;
  };
  operator: { sessionId: string; name: string } | null;
  supervisor: { employeeName: string; expiresAt: string } | null;
  current: CurrentWork | null;
  upNext: UpNextBag[];
  nextAction: NextAction;
  capabilities: { canPause: boolean; canReportProblem: boolean };
};

export type AdvanceIntent =
  | "CLAIM"
  | "COMPLETE"
  | "CONFIRM_BAG_EMPTY"
  | "RESOLVE_PARTIAL";

export type AdvanceInput = {
  stationId: string;
  workflowBagId: string;
  /** Currently UNREAD. advanceBag() does not look at this field — the
   *  accountable employee is resolved inside recordStageEvent from the
   *  station's active session. Kept because Phase 2 needs it to attribute
   *  the write to the session that actually made the gesture (and to carry
   *  an overrideEmployeeCode); see the Phase 2 preconditions on advanceBag. */
  operatorSessionId: string;
  intent: AdvanceIntent;
  /** Sealing's bag-level close mode: "whole" (default) or "partial". Read
   *  only when the intent/operation pair resolves to SEALING_COMPLETE on a
   *  pure SEALING station; ignored everywhere else. */
  sealingCloseMode?: string;
  /** Required alongside sealingCloseMode === "partial" — validated inside
   *  recordStageEvent, not here. */
  partialCloseReason?: string;
  partialCloseReasonNote?: string;
  /** Per-form accountability override: lets an operator with no open shift
   *  supply a code instead of throwing. Passed to both recordStageEvent
   *  (overrideEmployeeCode) and recordPackagingComplete (operatorCode). */
  overrideEmployeeCode?: string;
  /** Packaging-only: the operator explicitly keeping a bottle bag as a
   *  partial rather than confirming it empty. Absent/false is today's
   *  default — a bag closed through advanceBag finalizes as fully empty. */
  keepBagPartial?: boolean;
  /** Packaging-only: an operator-entered estimate of tablets remaining in
   *  a kept-partial bag. An estimate, never the confirmed allocation
   *  balance — see luma-data-honesty. */
  partialRemainingEstimate?: number;
  inputs: {
    counter?: number;
    /** Sealing counter presses. Distinct from `counter`: recordStageEvent
     *  multiplies presses by the machine's cards-per-press to derive the
     *  sealed count, and REFUSES a sealing segment without it
     *  (SEALING_COUNTER_PRESS_ERROR). */
    counterPresses?: number;
    /** Loose units damaged during this operation — cards ripped, bottles
     *  cracked, etc. (2026-08-13 decision). At packaging this maps to
     *  `rippedCards`, not `damagedPackaging`: packaging-MATERIAL damage
     *  (foil, cases, labels) is a separate exception-flow concern, not an
     *  operator count. */
    damaged?: number;
    cases?: number;
    displays?: number;
    loose?: number;
    physicalQty?: number;
  };
  /** Idempotency key — see lib/production/client-event-id-rule.test.ts. */
  clientEventId: string;
};

export type AdvanceResult =
  | { ok: true; view: StationView }
  | { ok: false; blocker: Blocker };
