// P6 Task 6(c) — Downtime resolution.
//
// Mirrors raise-downtime.ts (raiseDowntimeStarted) via the same shared
// primitive (emitStationedExceptionEvent). DOWNTIME_ENDED existed in the
// workflow_event_type enum since Phase A (migration 0008) with nothing that
// emitted it — downtime exceptions aged off the Act Now rail after 4 hours
// rather than being resolved. This function closes that gap.
//
// Admin path: the floor-board Act Now rail shows a [ Resolved ] button on
// DOWNTIME_STARTED items (floor-board/actions.ts resolveDowntimeAction).
// That action calls this function with the original event's stationId and
// workflowBagId so the resolution is recorded on the same bag.
//
// Same total-function contract as raiseDowntimeStarted: every failure
// returns a Blocker rather than throwing.

import { blockerFor } from "./resolve-exceptions";
import { emitStationedExceptionEvent } from "./emit-stationed-event";
import type { Blocker } from "./types";

export type RaiseDowntimeEndedInput = {
  stationId: string;
  workflowBagId: string;
  /** Optional note from the supervisor resolving the downtime. */
  note?: string | undefined;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type RaiseDowntimeEndedResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

export async function raiseDowntimeEnded(
  input: RaiseDowntimeEndedInput,
): Promise<RaiseDowntimeEndedResult> {
  if (!input.workflowBagId) {
    return { ok: false, blocker: blockerFor("PRODUCTION_EXCEPTION_NO_BAG") };
  }

  return emitStationedExceptionEvent({
    stationId: input.stationId,
    workflowBagId: input.workflowBagId,
    eventType: "DOWNTIME_ENDED",
    payload: {
      ...(input.note ? { note: input.note } : {}),
    },
    ...(input.clientEventId != null ? { clientEventId: input.clientEventId } : {}),
    ...(input.overrideEmployeeCode != null
      ? { overrideEmployeeCode: input.overrideEmployeeCode }
      : {}),
  });
}
