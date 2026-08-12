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

export function intentToEventType(
  intent: AdvanceIntent,
  operationCode: string,
): string | null {
  if (intent === "CLAIM") return "BAG_PICKED_UP";
  if (intent === "CONFIRM_BAG_EMPTY") {
    return BAG_CLOSE_EVENT_FOR_OPERATION[operationCode] ?? null;
  }
  if (intent === "COMPLETE") {
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
    packsRemaining: 0,
    cardsReopened: 0,
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    pickedSealingProductId: null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// PHASE 2 PRECONDITIONS — advanceBag is NOT yet usable from the floor.
//
// advanceBag has no production caller. It is unreachable from
// app/(floor)/ today, and that is deliberate: wiring a caller now would
// break three station kinds outright and silently drop six fields.
// Everything below must be resolved BEFORE a caller is added, not after.
//
// HARD BLOCKERS — these station kinds cannot succeed at all today:
//
//   1. SEALING and COMBINED — no counterPresses.
//      buildRecordStageEventInput() never sets `counterPresses`. Any
//      SEALING_SEGMENT_COMPLETE (or SEALING_COMPLETE on a COMBINED
//      station) therefore reaches the guard at
//      record-stage-event.ts:282-284 with counterPresses === undefined
//      and returns SEALING_COUNTER_PRESS_ERROR. The operator sees
//      "This step could not be recorded." on every seal.
//      Fix: carry the press count through AdvanceInput.inputs and map it.
//
//   2. Every kind, for intent "CLAIM" — unrecognised event type.
//      intentToEventType("CLAIM", …) returns "BAG_PICKED_UP", which does
//      not appear in ALLOWED_EVENTS_BY_KIND (record-stage-event.ts:89-104)
//      under ANY station kind, so recordStageEvent rejects it.
//      Fix: claim is not a stage event — route it to the pickup path
//      instead of recordStageEvent, or add the kind entries.
//
//   3. HANDPACK_BLISTER — wrong event via the alias.
//      STATION_KIND_ALIAS maps HANDPACK_BLISTER -> BLISTER
//      (see STATION_KIND_ALIAS in resolve-operation.ts), so the resolved
//      operation is BLISTER and
//      intentToEventType yields "BLISTER_COMPLETE". But
//      ALLOWED_EVENTS_BY_KIND.HANDPACK_BLISTER permits only
//      "HANDPACK_BLISTER_COMPLETE", so it is rejected.
//      Fix: resolve the event from the STATION kind, not the aliased
//      operation, or give HANDPACK_BLISTER its own route operation.
//
// SILENTLY DROPPED FIELDS — buildRecordStageEventInput() does not carry
// these, and each one changes recorded behaviour when it is missing:
//
//   overrideEmployeeCode     — per-form accountability override; without
//                              it a first-op count with no open shift
//                              throws (record-stage-event.ts:344-351)
//                              even when the operator supplied a code.
//   sealingCloseMode         — full vs partial sealing close-out.
//   partialCloseReason       — required to justify a partial close.
//   partialCloseReasonNote   — the free-text detail for the above.
//   packsRemaining           — hard-coded to 0 here.
//   cardsReopened            — hard-coded to 0 here.
//
// Until every item above is addressed, the floor's own
// fireStageEventAction remains the only correct write path.
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

  const eventType = intentToEventType(input.intent, resolved.operation.operationCode);
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
