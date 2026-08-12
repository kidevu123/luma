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

// ─────────────────────────────────────────────────────────────────────
// REMAINING LIMITATIONS — what advanceBag still cannot express.
//
// Task 7 closed the three hard blockers Phase 1 recorded here: sealing
// carries counterPresses, CLAIM routes to claimQueuedBag instead of
// recordStageEvent, and HANDPACK_BLISTER resolves its event from the
// station kind. What is left is not a broken station kind — it is work
// this contract does not model yet, all of it Phase 4:
//
//   PACKAGING multi-counts. AdvanceInput.inputs carries damaged,
//   displays and loose, and buildRecordStageEventInput reads NEITHER —
//   countTotal takes `counter ?? cases ?? 0` and the rest are dropped.
//   A packaging station that counts cases + displays + loose separately,
//   or reports damage, records only its case count through this path.
//   PACKAGING_SNAPSHOT is not reachable at all (no intent maps to it).
//
//   Partial sealing close-out. Four fields recordStageEvent accepts and
//   this mapping does not supply:
//     sealingCloseMode       — full vs partial close; defaults to "whole",
//                              so a partial close cannot be requested.
//     partialCloseReason     — required to justify a partial close.
//     partialCloseReasonNote — the free-text detail for the above.
//     packsRemaining / cardsReopened — hard-coded to 0 here.
//
//   overrideEmployeeCode. No AdvanceInput field carries a per-form
//   accountability override, so a first-op count with no open shift
//   throws even when the operator supplied a code. AdvanceInput
//   .operatorSessionId is still unread for the same reason.
//
// Consequence: the floor's fireStageEventAction remains the write path
// for packaging counts and partial sealing close-outs. A caller wired to
// advanceBag today must not offer those gestures.
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
