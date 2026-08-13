// P4b Task 4 — Report Problem's "Machine" category.
//
// Before this, DOWNTIME_STARTED existed only as a schema.ts enum value
// (added in migration 0008, "Phase A additions") — grepping the repo
// for the literal turns up nothing that ever emitted it: no floor
// action, no engine function, no ops script. This is that path.
//
// MACHINE reports get two writes: the existing pauseBagAction (called
// by the client, best-effort — see report-problem.tsx) stops the
// bag's clock the same way any other pause does, and this function
// records the machine-level fact the Act Now rail surfaces. They are
// independent: a bag that is already paused (shift break, another
// report) must not block the downtime record, so the client does not
// treat pauseBagAction's failure as fatal to this call.
//
// Same total-function contract, same bag resolution and
// wrong-bag guard as raiseProductionException — see
// emit-stationed-event.ts's header for why both are shared.

import { blockerFor } from "./resolve-exceptions";
import { emitStationedExceptionEvent } from "./emit-stationed-event";
import type { Blocker } from "./types";

export type RaiseDowntimeInput = {
  stationId: string;
  /** Omit to attach to whatever bag is currently pinned at this
   *  station. See RaiseProductionExceptionInput's workflowBagId doc —
   *  same NOT NULL / wrong-bag-guard contract applies here. */
  workflowBagId?: string | undefined;
  detail: string;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type RaiseDowntimeResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

export async function raiseDowntimeStarted(
  input: RaiseDowntimeInput,
): Promise<RaiseDowntimeResult> {
  const detail = input.detail.trim();
  if (!detail) {
    return { ok: false, blocker: blockerFor("PRODUCTION_EXCEPTION_DETAIL_REQUIRED") };
  }

  return emitStationedExceptionEvent({
    stationId: input.stationId,
    eventType: "DOWNTIME_STARTED",
    payload: { detail },
    ...(input.workflowBagId != null ? { workflowBagId: input.workflowBagId } : {}),
    ...(input.clientEventId != null ? { clientEventId: input.clientEventId } : {}),
    ...(input.overrideEmployeeCode != null
      ? { overrideEmployeeCode: input.overrideEmployeeCode }
      : {}),
  });
}
