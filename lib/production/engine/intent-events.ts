// AdvanceIntent + operation -> the workflow event it fires.
//
// P4b Task 5: moved VERBATIM out of advance.ts (the three maps and
// intentToEventType, unchanged). advance.ts re-exports intentToEventType
// so the barrel and its existing tests keep their import path.
//
// The move exists to break a cycle: station-view.ts now needs the
// completion event type (to ask checkStageProgression whether the work
// can be done yet — the START case), and advance.ts already imports
// getStationView from station-view.ts. Both directions through one
// leaf module instead.

import { SEALING_SEGMENT_EVENT } from "@/lib/production/sealing-segments";
import type { AdvanceIntent } from "./types";

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
  // RESOLVE_PARTIAL does not fire a workflow event; it closes the prior
  // run's raw-bag allocation session (resolve-partial-allocation.ts).
  return null;
}

/** True when this operation has a separate bag-level close gesture —
 *  i.e. CONFIRM_BAG_EMPTY is a real intent here, not a dead end.
 *  buildNextAction consults this before offering the sealing lane-close
 *  screen, so a COMBINED station (whose operation resolves to BLISTER)
 *  is never shown a button advanceBag would refuse. */
export function operationHasBagCloseGesture(operationCode: string): boolean {
  return BAG_CLOSE_EVENT_FOR_OPERATION[operationCode] != null;
}
