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
  /** `counterPresses` is the sealing machine's press count, NOT a card
   *  count: recordStageEvent multiplies it by the machine's
   *  cards-per-press and REFUSES a sealing segment without it
   *  (SEALING_COUNTER_PRESS_ERROR). It replaces `counter` at HEAT_SEAL
   *  on the station kinds that use the machine counter — see
   *  resolve-completion.ts.
   *
   *  `damagedPackaging` is packaging-material damage (foil, cases, labels)
   *  reported by the operator at packaging stations — distinct from
   *  `damaged` which is loose-unit damage (ripped cards). See the
   *  2026-08-17 user decision and resolve-completion.ts. */
  key: "counter" | "counterPresses" | "damaged" | "damagedPackaging" | "cases" | "displays" | "loose";
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

/** One finished product the operator may map this bag to. Shape is the
 *  engine's own, not a products-table row: id is `productId` so a caller
 *  cannot confuse it with a bag or card id. */
export type ProductOption = {
  productId: string;
  name: string;
  sku: string;
};

export type NextAction =
  | { kind: "OPEN_SHIFT" }
  | { kind: "SCAN_TO_CLAIM"; expected: UpNextBag | null }
  /** Claimed, but the work cannot begin yet: the bag was picked up
   *  early (overlap scan) and has not reached the stage this operation
   *  requires. There is deliberately NO gesture — no workflow event in
   *  the enum marks "operator started", so offering a button would
   *  record nothing. Luma flips this to COMPLETE on its own the moment
   *  the upstream station's completion lands. `label` is the operation's
   *  operator-facing verb, not an event name. */
  | { kind: "START"; label: string }
  | { kind: "COMPLETE"; label: string; inputs: CompletionInput[] }
  /** Sealing's bag-level close. `moreWork` carries the SAME completion
   *  affordance the COMPLETE case would have offered, because "No, more
   *  to seal" is not a dead end: the operator records another lane
   *  segment on the same bag. Without it the screen would ask a question
   *  whose second answer has no follow-through. */
  | {
      kind: "CONFIRM_BAG_EMPTY";
      moreWork: { label: string; inputs: CompletionInput[] };
    }
  /** The physical bag still carries an OPEN allocation session from a
   *  PREVIOUS run and cannot open a new one until it is closed.
   *  `estimate` is system-derived from production output — never a
   *  physical count; `needsEntry` means Luma cannot derive it and the
   *  operator must count. See resolve-partial-allocation.ts. */
  | { kind: "RESOLVE_PARTIAL"; estimate: number | null; needsEntry: boolean }
  /** Shown only when the bag's tablet type maps to 2+ ACTIVE products of a
   *  kind this station may make. Exactly one compatible product
   *  auto-resolves (no pick — see resolveProductChoice), and zero leaves
   *  the bag BLOCKED with PRODUCT_UNRESOLVED: an operator cannot invent a
   *  product that master data does not have. */
  | { kind: "PICK_PRODUCT"; options: ProductOption[] }
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
  /** The product the operator picked from a PICK_PRODUCT next action (or
   *  the one resolveProductChoice auto-resolved). Read on the sealing
   *  path only, where it plays two roles: on an UNMAPPED bag a COMPLETE
   *  assigns it first (assignBagProduct — workflow_bags.product_id +
   *  PRODUCT_MAPPED + the raw-bag allocation session), and it is then
   *  recordStageEvent's `pickedSealingProductId` — the guard that refuses
   *  a segment whose product disagrees with the one saved on the bag. On
   *  an already-mapped bag it is a guard only; a different product is a
   *  rejection, never a silent re-map. */
  productId?: string;
  /** Packaging-only: an operator-entered estimate of tablets remaining in
   *  a kept-partial bag. An estimate, never the confirmed allocation
   *  balance — see luma-data-honesty.
   *
   *  RESOLVE_PARTIAL reads it too: it is the estimate the HIGH/MEDIUM
   *  partial screen SHOWED and the operator accepted, recorded as
   *  provenance on the derived close (resolve-partial-allocation.ts). */
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
     *  `rippedCards`. */
    damaged?: number;
    /** Packaging-material units damaged — foil, cases, labels — reported
     *  by the operator at packaging stations (2026-08-17 user decision).
     *  Distinct from `damaged` (loose-unit/card damage). Maps to
     *  `damagedPackaging` in RecordPackagingCompleteInput, replacing the
     *  hardcoded 0. Absent is equivalent to 0 (counterPresses precedent). */
    damagedPackaging?: number;
    cases?: number;
    displays?: number;
    loose?: number;
    /** RESOLVE_PARTIAL's operator count — tablets physically remaining
     *  in a bag whose balance Luma cannot derive. Read by
     *  resolvePartialAllocation, which closes the prior run's session
     *  against it with MANUAL_ENTRY provenance. */
    physicalQty?: number;
  };
  /** Idempotency key — see lib/production/client-event-id-rule.test.ts. */
  clientEventId: string;
};

export type AdvanceResult =
  | { ok: true; view: StationView }
  | { ok: false; blocker: Blocker };
