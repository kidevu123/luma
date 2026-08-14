// P4b Task 4 — Report Problem's "Quality" category.
//
// Before this, QA_HOLD_STARTED existed only as a schema.ts enum value
// (added in migration 0008, "Phase A additions", "per-bag holds
// complement BATCH_HELD which is batch-wide") — grepping the repo for
// the literal turns up nothing that ever emitted it. This is that
// path.
//
// Deliberately does NOT also call pauseBagAction — unlike MACHINE,
// which pauses the bag AND records downtime, a quality report is only
// ever this one event (Task 4's mapping table). Whether the bag should
// stop moving because of it is a supervisor decision (QA disposition,
// P5), not something Report Problem decides on the operator's behalf.
//
// Same total-function contract, same bag resolution and wrong-bag
// guard as raiseProductionException — see emit-stationed-event.ts's
// header for why both are shared.

import { blockerFor } from "./resolve-exceptions";
import { emitStationedExceptionEvent } from "./emit-stationed-event";
import type { Blocker } from "./types";

export type RaiseQaHoldInput = {
  stationId: string;
  /** Omit to attach to whatever bag is currently pinned at this
   *  station. See RaiseProductionExceptionInput's workflowBagId doc —
   *  same NOT NULL / wrong-bag-guard contract applies here. */
  workflowBagId?: string | undefined;
  detail: string;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type RaiseQaHoldResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

export async function raiseQaHoldStarted(
  input: RaiseQaHoldInput,
): Promise<RaiseQaHoldResult> {
  const detail = input.detail.trim();
  if (!detail) {
    return { ok: false, blocker: blockerFor("PRODUCTION_EXCEPTION_DETAIL_REQUIRED") };
  }

  return emitStationedExceptionEvent({
    stationId: input.stationId,
    eventType: "QA_HOLD_STARTED",
    payload: { detail },
    ...(input.workflowBagId != null ? { workflowBagId: input.workflowBagId } : {}),
    ...(input.clientEventId != null ? { clientEventId: input.clientEventId } : {}),
    ...(input.overrideEmployeeCode != null
      ? { overrideEmployeeCode: input.overrideEmployeeCode }
      : {}),
  });
}
