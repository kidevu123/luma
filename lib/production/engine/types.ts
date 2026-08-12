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
  inputs: {
    counter?: number;
    /** Sealing counter presses. Distinct from `counter`: recordStageEvent
     *  multiplies presses by the machine's cards-per-press to derive the
     *  sealed count, and REFUSES a sealing segment without it
     *  (SEALING_COUNTER_PRESS_ERROR). */
    counterPresses?: number;
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
