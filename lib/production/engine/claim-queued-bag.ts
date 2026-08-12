// P2-QUEUE-1 — claiming a queued bag. The CLAIM intent's write half.
//
// A claim is NOT a stage event: BAG_PICKED_UP appears in no station
// kind's ALLOWED_EVENTS_BY_KIND, so routing it through recordStageEvent
// is rejected outright (that was blocker 2 in the Phase 1 preconditions
// on advanceBag). It goes through projectEvent directly, exactly as the
// floor's own pickup path does.
//
// The split mirrors station-view.ts: checkClaimGuards is pure and holds
// every decision; claimQueuedBag only loads its inputs and applies the
// result. This repo runs no database in its test suite by design, so the
// pure half carries the coverage and the DB half is verified on staging
// by the deploy smoke checklist.
//
// It does NOT write read_bag_queue. The projector owns that table
// (lib/projector/bag-queue.ts); BAG_PICKED_UP is a WORKING transition
// there, so the row is claimed as a consequence of the event rather than
// by a second writer that could disagree with it.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { readBagQueue, readBagState, stations } from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import { STATION_PICKUP_FROM_STAGE } from "@/lib/production/stage-progression";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import { blockerFor } from "./resolve-exceptions";
import type { Blocker } from "./types";

export type ClaimGuardInput = {
  stationKind: string;
  queueRow: {
    eligibleStationKinds: readonly string[];
    claimedByStationId: string | null;
    /** READY | UPSTREAM_RUNNING. Deliberately NOT a guard: the pickup
     *  table below is the authority on whether a station may take a bag
     *  early. SEALING accepts STARTED and PACKAGING accepts BLISTERED
     *  precisely so an operator can claim while upstream still runs
     *  (overlap scan); refusing on readyState would undo that. */
    readyState: string;
  } | null;
  bagStage: string | null;
  isPaused: boolean;
  isFinalized: boolean;
};

/** Pure: may this station claim this bag? Null means yes.
 *
 *  Order matters — the operator sees the FIRST blocker only, so the most
 *  actionable fact wins: what the bag is (unknown/finished/paused)
 *  before whose it is (wrong station, already claimed) before how far
 *  along it is (stage). */
export function checkClaimGuards(input: ClaimGuardInput): Blocker | null {
  // No queue row, or a queue row the bag-state projector has not caught
  // up with. Either way Luma cannot say what this bag is, and a claim
  // would fire BAG_PICKED_UP from an unknown stage.
  if (!input.queueRow || input.bagStage == null) {
    return blockerFor("BAG_UNRECOGNIZED");
  }
  if (input.isFinalized) return blockerFor("BAG_FINALIZED");
  if (input.isPaused) return blockerFor("BAG_PAUSED");

  if (!input.queueRow.eligibleStationKinds.includes(input.stationKind)) {
    return blockerFor("OPERATION_UNRESOLVED");
  }
  if (input.queueRow.claimedByStationId != null) {
    return blockerFor("BAG_ALREADY_CLAIMED");
  }

  // Same table the floor's scan path uses, so a queued bag can never be
  // claimable here and refused there.
  const pickupStages = STATION_PICKUP_FROM_STAGE[input.stationKind] ?? [];
  if (!pickupStages.includes(input.bagStage)) {
    return blockerFor("UPSTREAM_INCOMPLETE");
  }

  return null;
}

/** Claim a queued bag for a station. Total function: every rejection is
 *  a Blocker, and unexpected failures are wrapped by advanceBag's catch
 *  (this is only reached from advanceBagInner, which runs inside it).
 *
 *  PRECONDITION — the caller MUST have authenticated the station, the
 *  same guarantee recordStageEvent requires. On the floor path that comes
 *  from authStation(token, stationId). */
export async function claimQueuedBag(input: {
  stationId: string;
  workflowBagId: string;
  clientEventId: string;
}): Promise<{ ok: true } | { ok: false; blocker: Blocker }> {
  const [stationRow] = await db
    .select({ kind: stations.kind })
    .from(stations)
    .where(eq(stations.id, input.stationId));
  if (!stationRow) return { ok: false, blocker: blockerFor("STATION_UNRESOLVED") };

  const [queueRow] = await db
    .select({
      eligibleStationKinds: readBagQueue.eligibleStationKinds,
      claimedByStationId: readBagQueue.claimedByStationId,
      readyState: readBagQueue.readyState,
    })
    .from(readBagQueue)
    .where(eq(readBagQueue.workflowBagId, input.workflowBagId));

  const [state] = await db
    .select({
      stage: readBagState.stage,
      isPaused: readBagState.isPaused,
      isFinalized: readBagState.isFinalized,
    })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, input.workflowBagId));

  const blocker = checkClaimGuards({
    stationKind: stationRow.kind,
    queueRow: queueRow ?? null,
    bagStage: state?.stage ?? null,
    isPaused: state?.isPaused ?? false,
    isFinalized: state?.isFinalized ?? false,
  });
  if (blocker) return { ok: false, blocker };

  await db.transaction(async (tx) => {
    const accountability = await resolveStationAccountability(tx, {
      stationId: input.stationId,
      overrideEmployeeCode: null,
    });
    await projectEvent(tx, {
      workflowBagId: input.workflowBagId,
      stationId: input.stationId,
      eventType: "BAG_PICKED_UP",
      payload: {
        station_kind: stationRow.kind,
        // state is non-null here: checkClaimGuards refuses a null stage.
        from_stage: state?.stage ?? null,
        claimed_from_queue: true,
      },
      clientEventId: input.clientEventId,
      enteredByUserId: accountability.enteredByUserId,
      accountableEmployeeId: accountability.accountableEmployeeId,
      accountabilitySource: accountability.accountabilitySource,
      accountableEmployeeNameSnapshot:
        accountability.accountableEmployeeNameSnapshot,
    });
  });

  return { ok: true };
}
