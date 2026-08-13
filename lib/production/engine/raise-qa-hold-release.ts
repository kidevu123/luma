// P4b Task 4 fix round 2 (N1) — releases the hold raiseQaHoldStarted
// puts on a bag. Beside raise-qa-hold.ts on purpose: same shared
// primitive, same total-function contract, same bag resolution and
// wrong-bag guard — see emit-stationed-event.ts's header.
//
// Unlike raiseQaHoldStarted, `detail` is OPTIONAL here and deliberately
// so: N1's whole point is that releasing a hold must be at LEAST as
// easy as ending it was hard. A pause has Resume — one tap, no form.
// [ Release hold ] (qc-panel.tsx) is the same shape: one tap, no
// required note. A supervisor who wants to know why can already read
// the QA_HOLD_STARTED event's own detail plus this release's
// timestamp/accountability off workflow_events.

import { emitStationedExceptionEvent } from "./emit-stationed-event";
import type { Blocker } from "./types";

export type RaiseQaHoldReleaseInput = {
  stationId: string;
  /** Omit to attach to whatever bag is currently pinned at this
   *  station. See RaiseProductionExceptionInput's workflowBagId doc —
   *  same NOT NULL / wrong-bag-guard contract applies here. */
  workflowBagId?: string | undefined;
  /** Optional — unlike raiseQaHoldStarted's required detail, an empty
   *  or omitted note here still records a release (falls back to a
   *  fixed string) rather than blocking on PRODUCTION_EXCEPTION_
   *  DETAIL_REQUIRED. See the file header for why. */
  detail?: string | undefined;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type RaiseQaHoldReleaseResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

export async function raiseQaHoldRelease(
  input: RaiseQaHoldReleaseInput,
): Promise<RaiseQaHoldReleaseResult> {
  const detail = (input.detail ?? "").trim() || "Hold released.";

  return emitStationedExceptionEvent({
    stationId: input.stationId,
    eventType: "QA_HOLD_RELEASED",
    payload: { detail },
    ...(input.workflowBagId != null ? { workflowBagId: input.workflowBagId } : {}),
    ...(input.clientEventId != null ? { clientEventId: input.clientEventId } : {}),
    ...(input.overrideEmployeeCode != null
      ? { overrideEmployeeCode: input.overrideEmployeeCode }
      : {}),
  });
}
