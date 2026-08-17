// The single conceptual write. One operator gesture -> one call.
//
// Phase 1 deliberately delegates to the existing helpers used by
// fireStageEventAction so behaviour is bit-identical and the parity
// harness (Task 8) can prove it. Later phases move logic in here.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations, workflowBags } from "@/lib/db/schema";
import { SEALING_SEGMENT_EVENT } from "@/lib/production/sealing-segments";
import type { AdvanceInput, AdvanceIntent, AdvanceResult } from "./types";
import { assignBagProduct } from "./assign-bag-product";
import { claimQueuedBag } from "./claim-queued-bag";
import { intentToEventType } from "./intent-events";
import { blockerFor } from "./resolve-exceptions";
import { resolveOperation } from "./resolve-operation";
import { resolvePartialAllocation } from "./resolve-partial-allocation";
import { getStationView } from "./station-view";
import {
  recordStageEvent,
  type RecordStageEventInput,
  type StationRow,
} from "./record-stage-event";
import {
  recordPackagingComplete,
  type RecordPackagingCompleteInput,
} from "./record-packaging-complete";

/** The events recordStageEvent refuses on an unmapped bag at a
 *  sealing-capable station (SEALING_SAVE_PRODUCT_FIRST_ERROR). Mirrors the
 *  isSealingSegment/isSealingFinal pair in record-stage-event.ts — kept in
 *  step with it deliberately, because this is the exact set for which
 *  advanceBag must assign the product BEFORE recording the work. */
const SEALING_EVENTS_REQUIRING_SAVED_PRODUCT: ReadonlySet<string> = new Set([
  SEALING_SEGMENT_EVENT,
  "SEALING_COMPLETE",
]);

/** Pure: does this gesture have to assign the product BEFORE the work is
 *  recorded? True only for an unmapped bag whose gesture carries an
 *  operator pick at one of the two events recordStageEvent refuses on an
 *  unmapped bag. Separated from advanceBag so reachability is testable
 *  without a database — the ordering of the calls in the source says
 *  nothing about whether the branch can be entered. */
export function shouldAssignProductFirst(args: {
  bagProductId: string | null | undefined;
  inputProductId: string | null | undefined;
  eventType: string;
}): boolean {
  // Already mapped: never re-map here. A disagreeing pick must travel on
  // to recordStageEvent's guard and be rejected, which is what makes
  // product identity a one-way lock.
  if (args.bagProductId) return false;
  if (args.inputProductId == null) return false;
  return SEALING_EVENTS_REQUIRING_SAVED_PRODUCT.has(args.eventType);
}

/** Pure: does this gesture look like a packaging COMPLETE? Presence, not
 *  truthiness — an explicit 0 for cases/displays/loose still names the
 *  gesture's shape, the same discipline buildRecordStageEventInput uses
 *  for counterPresses. Feeds resolveOperation's preferOperation so a
 *  COMBINED station resolves PACKAGING instead of its default blister
 *  alias (pickOperationForStationKind's COMBINED-AT-PACKAGING-1 branch).
 *  A non-COMBINED station ignores the preference entirely (see that
 *  function's guard), so this is safe to compute unconditionally.
 *
 *  cases/displays/loose read as unambiguously "packaging" only because
 *  resolve-completion.ts's PACKAGING_OPERATIONS scoping is the sole
 *  place those CompletionInput keys get emitted today — the COMBINED-
 *  only preference guard in pickOperationForStationKind and that
 *  emission scoping are BOTH load-bearing, not this presence check
 *  alone. A caller that populated `cases` outside that scoping would
 *  divert a COMBINED station into PACKAGING regardless of the actual
 *  gesture. */
export function isPackagingShapedComplete(
  intent: AdvanceIntent,
  inputs: AdvanceInput["inputs"],
): boolean {
  if (intent !== "COMPLETE") return false;
  return (
    inputs.cases !== undefined ||
    inputs.displays !== undefined ||
    inputs.loose !== undefined
  );
}

// P4b Task 5 — intentToEventType and its three maps moved verbatim to
// intent-events.ts (station-view.ts needs the completion event type and
// this module already imports station-view; the leaf module breaks the
// cycle). Re-exported so the barrel and advance.test.ts keep their path.
export { intentToEventType } from "./intent-events";

/** Pure: the AdvanceInput -> RecordStageEventInput mapping.
 *  Separated from advanceBag so the count routing is testable without
 *  a database. */
export function buildRecordStageEventInput(args: {
  station: StationRow;
  workflowBagId: string;
  eventType: string;
  inputs: AdvanceInput["inputs"];
  clientEventId: string;
  sealingCloseMode?: AdvanceInput["sealingCloseMode"];
  partialCloseReason?: AdvanceInput["partialCloseReason"];
  partialCloseReasonNote?: AdvanceInput["partialCloseReasonNote"];
  overrideEmployeeCode?: AdvanceInput["overrideEmployeeCode"];
  productId?: AdvanceInput["productId"];
}): RecordStageEventInput {
  return {
    station: args.station,
    workflowBagId: args.workflowBagId,
    eventType: args.eventType,
    countTotal: args.inputs.counter ?? args.inputs.cases ?? 0,
    // Presence, not truthiness: recordStageEvent treats `undefined` as
    // "no counter supplied" and refuses the seal, so a real reading of 0
    // must survive. Under exactOptionalPropertyTypes the key must be
    // absent rather than present-and-undefined when there is none. The
    // same discipline applies to every field below: absent stays absent.
    ...(args.inputs.counterPresses != null
      ? { counterPresses: args.inputs.counterPresses }
      : {}),
    packsRemaining: 0,
    cardsReopened: 0,
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    // The product the operator picked (PICK_PRODUCT) or that
    // resolveProductChoice auto-resolved. recordStageEvent uses it as a
    // GUARD — it refuses a sealing segment whose picked product
    // disagrees with the one already saved on the bag — and never as an
    // assignment. Null when the gesture carried no product, which is
    // every non-sealing operation.
    pickedSealingProductId: args.productId ?? null,
    ...(args.sealingCloseMode != null
      ? { sealingCloseMode: args.sealingCloseMode }
      : {}),
    ...(args.partialCloseReason != null
      ? { partialCloseReason: args.partialCloseReason }
      : {}),
    ...(args.partialCloseReasonNote != null
      ? { partialCloseReasonNote: args.partialCloseReasonNote }
      : {}),
    ...(args.overrideEmployeeCode != null
      ? { overrideEmployeeCode: args.overrideEmployeeCode }
      : {}),
  };
}

/** Pure: the AdvanceInput -> RecordPackagingCompleteInput mapping.
 *  Separated from advanceBag so the count routing is testable without a
 *  database, mirroring buildRecordStageEventInput. */
export function buildRecordPackagingCompleteInput(args: {
  station: StationRow;
  workflowBagId: string;
  inputs: AdvanceInput["inputs"];
  clientEventId: string;
  keepBagPartial?: AdvanceInput["keepBagPartial"];
  partialRemainingEstimate?: AdvanceInput["partialRemainingEstimate"];
  overrideEmployeeCode?: AdvanceInput["overrideEmployeeCode"];
}): RecordPackagingCompleteInput {
  return {
    station: args.station,
    workflowBagId: args.workflowBagId,
    masterCases: args.inputs.cases ?? 0,
    displaysMade: args.inputs.displays ?? 0,
    looseCards: args.inputs.loose ?? 0,
    // Operator-counted loose-unit damage (cards ripped, bottles cracked)
    // maps to rippedCards per the 2026-08-13 decision.
    rippedCards: args.inputs.damaged ?? 0,
    // 2026-08-17 user decision: packaging-material damage (foil, cases,
    // labels) is now reported by the operator via the damagedPackaging
    // CompletionInput field. Absent → 0, following the counterPresses
    // precedent (a real reading of 0 must survive as 0, not as
    // "field absent"). The P4b follow-up tracking this as a missing-as-zero
    // mistake is now closed — the input exists and is mapped here.
    damagedPackaging: args.inputs.damagedPackaging ?? 0,
    // Partial-close fields: absent AdvanceInput.keepBagPartial /
    // partialRemainingEstimate keeps today's default — a bottle bag
    // closed through advanceBag finalizes as fully empty.
    keepBagPartial: args.keepBagPartial ?? false,
    partialRemainingEstimate: args.partialRemainingEstimate ?? null,
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    ...(args.overrideEmployeeCode != null
      ? { operatorCode: args.overrideEmployeeCode }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Full fidelity as of P4a; the legacy actions remain only for the old
// UI (P4b retires them).
//
// One product boundary is deliberate rather than missing. advanceBag
// both CARRIES a product (AdvanceInput.productId ->
// pickedSealingProductId) and, at sealing only, ASSIGNS one:
//   - Sealing. P4b Task 1 extracted saveSealingProductAction's
//     transaction (update workflow_bags + PRODUCT_MAPPED +
//     ensureOpenRawBagAllocationSessionForWorkflowBag + audit) into
//     assignBagProduct(). A COMPLETE that carries a product for an
//     unmapped bag now runs assign-then-record inside this call, the same
//     order and the same two events the old two-gesture UI produced.
//   - First operation. The product lands in the workflow_bags INSERT
//     inside scanCardAction (actions.ts:397-403) — the same statement
//     that creates the bag — so there is nothing for recordStageEvent to
//     carry. advanceBag never creates bags: CLAIM takes an already-queued
//     one through claimQueuedBag. Fresh-card scanning is P4b's scan-first
//     UX.
//
// COMBINED-AT-PACKAGING-1 (P4b Task 2) — what a COMBINED station CAN and
// CANNOT reach through advanceBag now:
//   - CAN reach PACKAGING. A COMPLETE gesture carrying cases/displays/
//     loose (isPackagingShapedComplete) sets preferOperation: "PACKAGING",
//     which pickOperationForStationKind honors for stationKind ===
//     "COMBINED" — resolveOperation then returns the PACKAGING operation
//     instead of its default blister alias, and the
//     `operationCode === "PACKAGING"` branch above routes it to
//     recordPackagingComplete, which already accepted station.kind ===
//     "COMBINED" (record-packaging-complete.ts) before this task closed
//     the routing gap that kept that branch unreachable from a COMBINED
//     station.
//   - CANNOT reach HEAT_SEAL. There is no isSealingShapedComplete: a
//     sealing gesture's only positive signal is `counterPresses`
//     (buildRecordStageEventInput), and `counter` doubles as the blister
//     count, so the two shapes are not reliably distinguishable from
//     AdvanceInput alone. cases/displays/loose are unambiguous for
//     packaging only because resolve-completion.ts's PACKAGING_OPERATIONS
//     scoping is the ONLY place those CompletionInput keys are emitted
//     today — the COMBINED-only preference guard and that emission
//     scoping are BOTH load-bearing together, not a property of the
//     fields themselves.
//     A COMBINED station's sealing-shaped gesture therefore still
//     resolves to the blister operation and fires BLISTER_COMPLETE
//     (which ALLOWED_EVENTS_BY_KIND.COMBINED does accept, so nothing
//     errors — it just records the wrong stage). This is also why
//     shouldAssignProductFirst misses it on an unmapped bag: that
//     function keys off the RESOLVED eventType, and BLISTER_COMPLETE is
//     not in SEALING_EVENTS_REQUIRING_SAVED_PRODUCT, so the
//     assign-then-record sequence never triggers for a COMBINED station's
//     sealing gesture — the same ledger note Task 1 left open. Closing
//     this needs a sealing-shaped detector (or a route-driven signal)
//     before COMBINED-at-sealing can compose the same way
//     COMBINED-at-packaging now does; out of scope for this task.
// ─────────────────────────────────────────────────────────────────────
export async function advanceBag(input: AdvanceInput): Promise<AdvanceResult> {
  try {
    return await advanceBagInner(input);
  } catch (err) {
    // A throw here is a database or projector failure, not an operator
    // mistake. Surface it as a blocker so the tablet shows a sentence
    // instead of a stack trace.
    return {
      ok: false,
      blocker: {
        code: "ADVANCE_FAILED",
        operatorSentence: "Something went wrong recording this. Ask a supervisor.",
        supervisorDetail: err instanceof Error ? err.message : String(err),
        suggestedAction: "NOTIFY_SUPERVISOR",
      },
    };
  }
}

async function advanceBagInner(input: AdvanceInput): Promise<AdvanceResult> {
  // A claim is not a stage event and needs no route operation — the
  // queue row already says which kinds may take the bag. Short-circuit
  // before resolveOperation so a bag whose product has no route can
  // still be picked up (the operation only governs the WORK).
  if (input.intent === "CLAIM") {
    const claim = await claimQueuedBag({
      stationId: input.stationId,
      workflowBagId: input.workflowBagId,
      clientEventId: input.clientEventId,
    });
    if (!claim.ok) return { ok: false, blocker: claim.blocker };
    return { ok: true, view: await getStationView(input.stationId) };
  }

  const [stationRow] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, input.stationId));
  if (!stationRow) {
    // Not OPERATION_UNRESOLVED: nothing is wrong with the bag's routing,
    // the stations row itself was not found. See NON_CHECKLIST_BLOCKERS.
    return { ok: false, blocker: blockerFor("STATION_UNRESOLVED") };
  }

  const [bag] = await db
    .select({
      productId: workflowBags.productId,
      inventoryBagId: workflowBags.inventoryBagId,
    })
    .from(workflowBags)
    .where(eq(workflowBags.id, input.workflowBagId));

  // RESOLVE-PARTIAL-1 — the partial-bag screen's write. Not a stage
  // event and not route-dependent: it closes the PRIOR run's still-OPEN
  // raw-bag allocation session on this physical bag, which is the exact
  // ledger the sealing product-assign path refuses on
  // (OPEN_ALLOCATION_ON_BAG). Short-circuited before resolveOperation
  // for the same reason CLAIM is — the operation governs the WORK, and
  // there is none here. Before this task the intent fell through to
  // intentToEventType, which answers null for it, so the operator's
  // count was dropped and the screen showed OPERATION_UNRESOLVED.
  if (input.intent === "RESOLVE_PARTIAL") {
    if (!bag) return { ok: false, blocker: blockerFor("BAG_UNRECOGNIZED") };
    // P5-SUPERVISOR Task 5 — overrideEmployeeCode is deliberately NOT
    // forwarded to resolvePartialAllocation. The typed-lead badge path
    // that this input backed was removed; the LOW-confidence branch now
    // requires an OPEN supervisor session (checked server-side inside
    // resolvePartialAllocation), and the HIGH/MEDIUM branch resolves
    // accountability from the station's own operator session.
    const resolvedPartial = await resolvePartialAllocation({
      stationId: input.stationId,
      workflowBagId: input.workflowBagId,
      inventoryBagId: bag.inventoryBagId,
      ...(input.inputs.physicalQty != null
        ? { physicalQty: input.inputs.physicalQty }
        : {}),
      ...(input.partialRemainingEstimate != null
        ? { estimate: input.partialRemainingEstimate }
        : {}),
    });
    if (!resolvedPartial.ok) {
      return { ok: false, blocker: resolvedPartial.blocker };
    }
    return { ok: true, view: await getStationView(input.stationId) };
  }

  // ASSIGN-PRODUCT-EXTRACT-1 — resolve the operation for the product that
  // is ABOUT TO BE USED, not only the one already on the bag. An unmapped
  // bag has no route (resolveOperation returns null on a null productId),
  // so resolving on `bag.productId` alone would return OPERATION_UNRESOLVED
  // for precisely the case the assign step exists to serve — an unmapped
  // bag plus an operator product pick — and the assignment below would be
  // unreachable. The bag's own product still WINS when it has one: a pick
  // that disagrees must reach recordStageEvent's guard and be rejected
  // (SEALING_PRODUCT_ALREADY_SAVED_ERROR), never silently re-route the bag.
  const resolved = await resolveOperation({
    productId: bag?.productId ?? input.productId ?? null,
    stationKind: stationRow.kind,
    // COMBINED-AT-PACKAGING-1 — a packaging-shaped COMPLETE crosses
    // pickOperationForStationKind's COMBINED-only preference gate; every
    // other station kind ignores this even when it happens to name an
    // operation the station cannot perform.
    ...(isPackagingShapedComplete(input.intent, input.inputs)
      ? { preferOperation: "PACKAGING" }
      : {}),
  });
  if (!resolved) return { ok: false, blocker: blockerFor("OPERATION_UNRESOLVED") };

  const eventType = intentToEventType(
    input.intent,
    resolved.operation.operationCode,
    stationRow.kind,
  );
  if (!eventType) return { ok: false, blocker: blockerFor("OPERATION_UNRESOLVED") };

  // PACKAGING's COMPLETE carries three counts plus damage and drives
  // finished-lot auto-creation — recordStageEvent's single countTotal
  // cannot express that, so this intent/operation pair routes to its own
  // recording function instead. Every other intent and operation still
  // goes through recordStageEvent below.
  if (input.intent === "COMPLETE" && resolved.operation.operationCode === "PACKAGING") {
    const packagingResult = await recordPackagingComplete(
      buildRecordPackagingCompleteInput({
        station: stationRow,
        workflowBagId: input.workflowBagId,
        inputs: input.inputs,
        clientEventId: input.clientEventId,
        keepBagPartial: input.keepBagPartial,
        partialRemainingEstimate: input.partialRemainingEstimate,
        overrideEmployeeCode: input.overrideEmployeeCode,
      }),
    );
    if ("error" in packagingResult) {
      return {
        ok: false,
        blocker: {
          code: "ADVANCE_REJECTED",
          operatorSentence: "This step could not be recorded. Ask a supervisor.",
          supervisorDetail: packagingResult.error,
          suggestedAction: "NOTIFY_SUPERVISOR",
        },
      };
    }
    return { ok: true, view: await getStationView(input.stationId) };
  }

  // ASSIGN-PRODUCT-EXTRACT-1 — the old UI made TWO calls at sealing: save
  // the product (saveSealingProductAction), then record the work. The
  // operator screen makes one gesture, so advanceBag runs the same
  // sequence in the same order: validate the operation, assign, record.
  // Two sequential transactions, exactly as the two-gesture UI produced —
  // the assign COMMITS before the record starts. If the record then fails,
  // the resulting state (product mapped, work not recorded) is the same
  // state the legacy save-then-failed-complete left behind, and the same
  // retry fixes it. There is deliberately no outer transaction: adding one
  // would change the legacy semantics this task is relocating, not
  // preserving.
  //
  // The condition mirrors recordStageEvent's guard (a sealing segment or
  // close refuses an unmapped bag): assign writes workflow_bags.product_id
  // from the SAME id the gesture carried, and the guard then MATCHES it
  // instead of rejecting.
  if (
    shouldAssignProductFirst({
      bagProductId: bag?.productId,
      inputProductId: input.productId,
      eventType,
    })
  ) {
    const assigned = await assignBagProduct({
      station: stationRow,
      workflowBagId: input.workflowBagId,
      // shouldAssignProductFirst returned true, so this is non-null.
      productId: input.productId as string,
      // One gesture, two events. The idempotency index is
      // (workflow_bag_id, event_type, client_event_id), so the two events
      // would not collide even on a shared key — the suffix is defensive
      // clarity in the audit trail, not a correctness requirement.
      ...(input.clientEventId
        ? { clientEventId: `${input.clientEventId}-product` }
        : {}),
      ...(input.overrideEmployeeCode != null
        ? { overrideEmployeeCode: input.overrideEmployeeCode }
        : {}),
    });
    if ("openAllocationBlock" in assigned) {
      // The raw bag still has an OPEN allocation from a prior run. Not an
      // operator mistake and not fixable at the tablet: closing that
      // ledger is lead-gated. Surface it as a blocker rather than a
      // silent no-op — the structured panel is P4b Task 5's to render.
      return {
        ok: false,
        blocker: {
          code: "OPEN_ALLOCATION_ON_BAG",
          operatorSentence:
            "This bag is still open from a previous run. Ask a supervisor.",
          supervisorDetail: assigned.openAllocationBlock.message,
          suggestedAction: "NOTIFY_SUPERVISOR",
        },
      };
    }
    if ("error" in assigned) {
      return {
        ok: false,
        blocker: {
          code: "PRODUCT_ASSIGN_REJECTED",
          operatorSentence:
            "This product could not be saved on the bag. Ask a supervisor.",
          supervisorDetail: assigned.error,
          suggestedAction: "NOTIFY_SUPERVISOR",
        },
      };
    }
  }

  const result = await recordStageEvent(
    buildRecordStageEventInput({
      station: stationRow,
      workflowBagId: input.workflowBagId,
      eventType,
      inputs: input.inputs,
      clientEventId: input.clientEventId,
      sealingCloseMode: input.sealingCloseMode,
      partialCloseReason: input.partialCloseReason,
      partialCloseReasonNote: input.partialCloseReasonNote,
      overrideEmployeeCode: input.overrideEmployeeCode,
      productId: input.productId,
    }),
  );

  if ("error" in result) {
    return {
      ok: false,
      blocker: {
        code: "ADVANCE_REJECTED",
        operatorSentence: "This step could not be recorded. Ask a supervisor.",
        supervisorDetail: result.error,
        suggestedAction: "NOTIFY_SUPERVISOR",
      },
    };
  }

  return { ok: true, view: await getStationView(input.stationId) };
}
