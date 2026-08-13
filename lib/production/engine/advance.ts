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
import { claimQueuedBag } from "./claim-queued-bag";
import { blockerFor } from "./resolve-exceptions";
import { resolveOperation } from "./resolve-operation";
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

/** Operation code -> the completion event it fires. Mirrors
 *  LEGACY_EVENT_TYPE_TO_OPERATION in lib/production/routes.ts, inverted. */
const COMPLETE_EVENT_FOR_OPERATION: Readonly<Record<string, string>> = {
  BLISTER: "BLISTER_COMPLETE",
  HEAT_SEAL: SEALING_SEGMENT_EVENT,
  PACKAGING: "PACKAGING_COMPLETE",
  BOTTLE_FILL: "BOTTLE_HANDPACK_COMPLETE",
  STICKERING: "BOTTLE_STICKER_COMPLETE",
  INDUCTION_SEAL: "BOTTLE_CAP_SEAL_COMPLETE",
};

/** Operations where a separate bag-level close exists. Sealing is the
 *  only one today: each station closes its lane with a segment, and the
 *  bag closes once when the operator confirms it is empty. */
const BAG_CLOSE_EVENT_FOR_OPERATION: Readonly<Record<string, string>> = {
  HEAT_SEAL: "SEALING_COMPLETE",
};

/** Station kinds whose completion event is NOT the one their aliased
 *  operation implies. resolve-operation aliases HANDPACK_BLISTER onto the
 *  BLISTER operation, so the operation code alone yields
 *  BLISTER_COMPLETE — which ALLOWED_EVENTS_BY_KIND.HANDPACK_BLISTER
 *  rejects. The station kind is the tiebreaker, which is why this
 *  function takes one. COMBINED aliases onto BLISTER too and is NOT
 *  listed: BLISTER_COMPLETE is exactly what it fires. */
const COMPLETE_EVENT_FOR_STATION_KIND: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  HANDPACK_BLISTER: { BLISTER: "HANDPACK_BLISTER_COMPLETE" },
};

export function intentToEventType(
  intent: AdvanceIntent,
  operationCode: string,
  stationKind: string,
): string | null {
  if (intent === "CLAIM") return "BAG_PICKED_UP";
  if (intent === "CONFIRM_BAG_EMPTY") {
    return BAG_CLOSE_EVENT_FOR_OPERATION[operationCode] ?? null;
  }
  if (intent === "COMPLETE") {
    const byKind = COMPLETE_EVENT_FOR_STATION_KIND[stationKind]?.[operationCode];
    if (byKind) return byKind;
    return COMPLETE_EVENT_FOR_OPERATION[operationCode] ?? null;
  }
  // RESOLVE_PARTIAL does not fire a workflow event; it records an
  // allocation resolution handled by the partial-bag modules.
  return null;
}

/** Pure: the AdvanceInput -> RecordStageEventInput mapping.
 *  Separated from advanceBag so the count routing is testable without
 *  a database. */
export function buildRecordStageEventInput(args: {
  station: StationRow;
  workflowBagId: string;
  eventType: string;
  inputs: AdvanceInput["inputs"];
  clientEventId: string;
}): RecordStageEventInput {
  return {
    station: args.station,
    workflowBagId: args.workflowBagId,
    eventType: args.eventType,
    countTotal: args.inputs.counter ?? args.inputs.cases ?? 0,
    // Presence, not truthiness: recordStageEvent treats `undefined` as
    // "no counter supplied" and refuses the seal, so a real reading of 0
    // must survive. Under exactOptionalPropertyTypes the key must be
    // absent rather than present-and-undefined when there is none.
    ...(args.inputs.counterPresses != null
      ? { counterPresses: args.inputs.counterPresses }
      : {}),
    packsRemaining: 0,
    cardsReopened: 0,
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    pickedSealingProductId: null,
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
}): RecordPackagingCompleteInput {
  return {
    station: args.station,
    workflowBagId: args.workflowBagId,
    masterCases: args.inputs.cases ?? 0,
    displaysMade: args.inputs.displays ?? 0,
    looseCards: args.inputs.loose ?? 0,
    // Operator-counted damage (AdvanceInput.inputs.damaged) is loose
    // units — ripped cards — per the 2026-08-13 decision, so it maps to
    // rippedCards. damagedPackaging is packaging-MATERIAL damage (foil,
    // cases, labels), which stays an exception-flow concern raised by a
    // supervisor, not something this operator gesture reports; always 0
    // through this path.
    damagedPackaging: 0,
    rippedCards: args.inputs.damaged ?? 0,
    // Partial-close fields (keepBagPartial / partialRemainingEstimate):
    // Task 3. No AdvanceInput field carries them yet, so a bottle bag
    // closed through advanceBag today always finalizes as fully empty.
    keepBagPartial: false,
    partialRemainingEstimate: null,
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// REMAINING LIMITATIONS — what advanceBag still cannot express.
//
//   Partial-close fields. Sealing's partial close-out
//   (sealingCloseMode / partialCloseReason / partialCloseReasonNote /
//   packsRemaining / cardsReopened) and packaging's partial-bag keep
//   (keepBagPartial / partialRemainingEstimate) have no AdvanceInput
//   field yet. overrideEmployeeCode is in the same bucket: no per-form
//   accountability override, so a first-op count with no open shift
//   throws even when the operator supplied a code. Task 3 closes this.
//
//   Sealing / first-op product selection. pickedSealingProductId is
//   hard-coded null and PRODUCT_MAPPED is unreachable through this path.
//   Task 4 closes this.
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
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, input.workflowBagId));

  const resolved = await resolveOperation({
    productId: bag?.productId ?? null,
    stationKind: stationRow.kind,
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

  const result = await recordStageEvent(
    buildRecordStageEventInput({
      station: stationRow,
      workflowBagId: input.workflowBagId,
      eventType,
      inputs: input.inputs,
      clientEventId: input.clientEventId,
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
