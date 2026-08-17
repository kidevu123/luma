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
 *  LEGACY_EVENT_TYPE_TO_OPERATION in lib/production/routes.ts, inverted.
 *
 *  HANDPACK_BLISTER was previously absent here (it was aliased onto the
 *  BLISTER operation in resolve-operation.ts, yielding BLISTER_COMPLETE,
 *  which then required the COMPLETE_EVENT_FOR_STATION_KIND override table
 *  below to produce HANDPACK_BLISTER_COMPLETE instead). Migration 0074
 *  gives HANDPACK_BLISTER its own real route_operations row, so the alias
 *  is gone and the operation code now resolves directly from the DB row.
 *  HANDPACK_BLISTER maps here without any station-kind tiebreaker needed. */
const COMPLETE_EVENT_FOR_OPERATION: Readonly<Record<string, string>> = {
  BLISTER: "BLISTER_COMPLETE",
  HANDPACK_BLISTER: "HANDPACK_BLISTER_COMPLETE",
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

/** Station kinds whose completion event differs from what their operation
 *  code alone implies. Migration 0074 closed the only case that used to
 *  live here (HANDPACK_BLISTER -> BLISTER alias -> BLISTER_COMPLETE
 *  override -> HANDPACK_BLISTER_COMPLETE): HANDPACK_BLISTER now has its
 *  own operation code and maps directly in COMPLETE_EVENT_FOR_OPERATION.
 *  COMBINED aliases onto BLISTER and fires BLISTER_COMPLETE — no
 *  override needed there either.
 *
 *  The table is intentionally kept (empty rather than deleted) because
 *  intentToEventType's stationKind parameter still has value: it lets a
 *  future station kind override the event its operation would otherwise
 *  imply without requiring a new operation type. Removing the parameter
 *  now would be a more invasive refactor than the gain warrants. */
const COMPLETE_EVENT_FOR_STATION_KIND: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {};

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
