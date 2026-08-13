// P4b Task 2 — the single exception workflow's catch-all write path.
//
// Report Problem (Task 4) reuses existing events where one already
// fits (DOWNTIME_STARTED for machine, QA_HOLD_STARTED for quality,
// BAG_PAUSED for bag) and falls through to this function for the three
// categories with no current equivalent: material, product, other.
// PRODUCTION_EXCEPTION_RAISED (migration 0072) is deliberately
// non-progressing in the stage/throughput/queue sense — see
// lib/projector/index.ts's STAGE_FOR_EVENT / THROUGHPUT_COLUMN and
// bag-queue.ts's FLOW_EVENTS, none of which reference it.
//
// It is NOT read-station-live-inert, though: projectEvent's
// read_station_live upsert (lib/projector/index.ts:402-424) re-pins
// current_workflow_bag_id for ANY stationed event that is not
// BAG_FINALIZED/BAG_RELEASED, and this is no exception — by design, an
// exception IS about this station's current work. What this module
// guards is the OTHER direction: it must never let a caller-supplied
// workflowBagId that disagrees with the station's actual current bag
// silently re-pin it out from under the operator screen. See the
// PRODUCTION_EXCEPTION_WRONG_BAG branch in emit-stationed-event.ts.
//
// P4b Task 4 — the bag-resolution + wrong-bag-guard + accountable-write
// body below moved to emit-stationed-event.ts's emitStationedExceptionEvent,
// shared verbatim with raise-downtime.ts and raise-qa-hold.ts (the
// MACHINE/QUALITY paths this file's own header describes). This
// function's observable behavior — blocker codes, ordering, the
// detail-required check before anything else runs — is unchanged.

import { blockerFor } from "./resolve-exceptions";
import { emitStationedExceptionEvent } from "./emit-stationed-event";
import type { Blocker } from "./types";

/** The six categories the Report Problem screen offers. All six are
 *  represented here even though only MATERIAL/PRODUCT/OTHER actually
 *  reach this function today — MACHINE/QUALITY/BAG route to
 *  DOWNTIME_STARTED/QA_HOLD_STARTED/BAG_PAUSED instead (Task 4's
 *  mapping table). The union stays exhaustive so a future category
 *  that loses its dedicated event has somewhere to land without a
 *  type change here. */
export const PRODUCTION_EXCEPTION_CATEGORIES = [
  "MATERIAL",
  "MACHINE",
  "PRODUCT",
  "BAG",
  "QUALITY",
  "OTHER",
] as const;

export type ProductionExceptionCategory =
  (typeof PRODUCTION_EXCEPTION_CATEGORIES)[number];

export type RaiseProductionExceptionInput = {
  stationId: string;
  /** Omit to attach to whatever bag is currently pinned at this station
   *  (read_station_live.current_workflow_bag_id). workflow_events.
   *  workflow_bag_id is NOT NULL, so when neither is available the call
   *  returns the PRODUCTION_EXCEPTION_NO_BAG blocker rather than
   *  throwing — see the total-function contract below. When SUPPLIED and
   *  the station already has a DIFFERENT current bag pinned, the call
   *  returns PRODUCTION_EXCEPTION_WRONG_BAG instead of emitting —
   *  projectEvent's read_station_live upsert would otherwise silently
   *  re-pin the station onto this bag, hijacking the operator screen's
   *  current work out from under whoever is actually working it. */
  workflowBagId?: string | undefined;
  category: ProductionExceptionCategory;
  detail: string;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type RaiseProductionExceptionResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

/** Total function: every failure path returns a Blocker, shaped
 *  identically to advanceBag's, instead of throwing — callers (the
 *  Report Problem flow, BLOCKED's exception entry point) render it the
 *  same way they render any other engine blocker. Never rejects. */
export async function raiseProductionException(
  input: RaiseProductionExceptionInput,
): Promise<RaiseProductionExceptionResult> {
  const detail = input.detail.trim();
  if (!detail) {
    return { ok: false, blocker: blockerFor("PRODUCTION_EXCEPTION_DETAIL_REQUIRED") };
  }

  return emitStationedExceptionEvent({
    stationId: input.stationId,
    eventType: "PRODUCTION_EXCEPTION_RAISED",
    payload: { category: input.category, detail },
    ...(input.workflowBagId != null ? { workflowBagId: input.workflowBagId } : {}),
    ...(input.clientEventId != null ? { clientEventId: input.clientEventId } : {}),
    ...(input.overrideEmployeeCode != null
      ? { overrideEmployeeCode: input.overrideEmployeeCode }
      : {}),
  });
}
