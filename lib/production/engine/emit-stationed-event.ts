// P4b Task 4 — the shared primitive behind every "stationed exception"
// write: raiseProductionException (PRODUCTION_EXCEPTION_RAISED),
// raiseDowntimeStarted (DOWNTIME_STARTED), and raiseQaHoldStarted
// (QA_HOLD_STARTED).
//
// All three resolve to a workflow bag THE SAME WAY
// (workflow_events.workflow_bag_id is NOT NULL, so a caller-omitted
// bag falls back to the station's currently pinned one) and refuse
// THE SAME WAY when a caller-supplied bag disagrees with the pinned
// one (WRONG-BAG-GUARD-1 — see projectEvent's read_station_live
// upsert, lib/projector/index.ts:402-424, which re-pins
// current_workflow_bag_id for ANY stationed event that isn't
// BAG_FINALIZED/BAG_RELEASED). Extracted here verbatim from
// raise-production-exception.ts (P4b Task 2) rather than duplicated
// three times.
//
// Deliberately NOT exported through the engine barrel: this is an
// internal building block, not a call a floor action should reach for
// directly. Callers get the three named, category-specific functions.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { readStationLive, stations } from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import { blockerFor } from "./resolve-exceptions";
import type { Blocker } from "./types";

export type StationedExceptionEventType =
  | "PRODUCTION_EXCEPTION_RAISED"
  | "DOWNTIME_STARTED"
  | "QA_HOLD_STARTED"
  // Fix round 2 (N1) — the release half of QA_HOLD_STARTED. Without
  // it, a QUALITY report was a one-way latch: nothing anywhere emitted
  // QA_HOLD_RELEASED, so claim-queued-bag's BAG_ON_HOLD blocker,
  // station-view's bagOnHold fact, and finished-lot-release-
  // eligibility's isOnHold check all stayed permanently tripped once
  // round 1 wired QA_HOLD_STARTED to read_bag_state.is_on_hold — worse
  // than a pause, which has Resume. See raise-qa-hold-release.ts.
  | "QA_HOLD_RELEASED"
  // P6 Task 6(c) — the resolution half of DOWNTIME_STARTED. DOWNTIME_ENDED
  // existed in the schema enum since Phase A; nothing emitted it until now.
  | "DOWNTIME_ENDED";

export type EmitStationedEventInput = {
  stationId: string;
  workflowBagId?: string | undefined;
  eventType: StationedExceptionEventType;
  payload: Record<string, unknown>;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type EmitStationedEventResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

/** Total function: every failure path returns a Blocker instead of
 *  throwing. Never rejects. */
export async function emitStationedExceptionEvent(
  input: EmitStationedEventInput,
): Promise<EmitStationedEventResult> {
  try {
    const [stationRow] = await db
      .select({ id: stations.id })
      .from(stations)
      .where(eq(stations.id, input.stationId));
    if (!stationRow) {
      return { ok: false, blocker: blockerFor("STATION_UNRESOLVED") };
    }

    const [live] = await db
      .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
      .from(readStationLive)
      .where(eq(readStationLive.stationId, input.stationId));
    const currentWorkflowBagId = live?.currentWorkflowBagId ?? null;

    let workflowBagId: string | null;
    if (input.workflowBagId) {
      // See WRONG-BAG-GUARD-1 above — refuse rather than silently
      // re-pinning the station onto a different bag than the one
      // actually pinned there. No current bag pinned is fine: there
      // is nothing to hijack.
      if (currentWorkflowBagId && currentWorkflowBagId !== input.workflowBagId) {
        return {
          ok: false,
          blocker: {
            code: "PRODUCTION_EXCEPTION_WRONG_BAG",
            operatorSentence:
              "Report the bag currently at this station, or clear it first.",
            supervisorDetail: `Supplied workflowBagId ${input.workflowBagId} does not match this station's read_station_live.current_workflow_bag_id ${currentWorkflowBagId}.`,
            suggestedAction: "NOTIFY_SUPERVISOR",
          },
        };
      }
      workflowBagId = input.workflowBagId;
    } else {
      workflowBagId = currentWorkflowBagId;
    }
    if (!workflowBagId) {
      return { ok: false, blocker: blockerFor("PRODUCTION_EXCEPTION_NO_BAG") };
    }
    const resolvedWorkflowBagId: string = workflowBagId;

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: input.stationId,
        overrideEmployeeCode: input.overrideEmployeeCode ?? null,
      });

      await projectEvent(tx, {
        workflowBagId: resolvedWorkflowBagId,
        stationId: input.stationId,
        eventType: input.eventType,
        payload: input.payload,
        ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      blocker: {
        code: "PRODUCTION_EXCEPTION_FAILED",
        operatorSentence:
          "Something went wrong recording this. Ask a supervisor.",
        supervisorDetail: err instanceof Error ? err.message : String(err),
        suggestedAction: "NOTIFY_SUPERVISOR",
      },
    };
  }
}
