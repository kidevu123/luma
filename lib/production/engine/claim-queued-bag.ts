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

/** Either the pool or an open transaction — the guard inputs load the
 *  same way from both; only the row lock differs. */
type Reader = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export type ClaimGuardInput = {
  stationKind: string;
  queueRow: {
    eligibleStationKinds: readonly string[];
    /** The station currently HOLDING the bag. For a row still sitting in
     *  THIS station's queue that is almost always the UPSTREAM station
     *  working it — a destination-kind peer's claim advances the row out
     *  of this queue entirely. So a non-null holder is not by itself a
     *  reason to refuse; see claimedByStationKind. */
    claimedByStationId: string | null;
    /** The holder's station kind, or null when unheld. This is what
     *  separates "upstream is still working it" (claimable — that IS the
     *  overlap scan) from "a peer of my own kind already took it"
     *  (refuse). */
    claimedByStationKind: string | null;
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
  isOnHold: boolean;
};

/** Pure: may this station claim this bag? Null means yes.
 *
 *  Order matters — the operator sees the FIRST blocker only, so the most
 *  actionable fact wins: what the bag is (unknown/finished/held/paused)
 *  before whose it is (wrong station, peer-claimed) before how far along
 *  it is (stage). */
export function checkClaimGuards(input: ClaimGuardInput): Blocker | null {
  // No queue row, or a queue row the bag-state projector has not caught
  // up with. Either way Luma cannot say what this bag is, and a claim
  // would fire BAG_PICKED_UP from an unknown stage.
  if (!input.queueRow || input.bagStage == null) {
    return blockerFor("BAG_UNRECOGNIZED");
  }
  if (input.isFinalized) return blockerFor("BAG_FINALIZED");
  if (input.isOnHold) return blockerFor("BAG_ON_HOLD");
  if (input.isPaused) return blockerFor("BAG_PAUSED");

  if (!input.queueRow.eligibleStationKinds.includes(input.stationKind)) {
    return blockerFor("OPERATION_UNRESOLVED");
  }
  if (isHeldByDestinationPeer(input.queueRow)) {
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

/** True when the holder is a station that could itself do THIS queue's
 *  work — i.e. a real race (two sealers reaching for the same bag).
 *
 *  An upstream holder (a kind that is not in the row's
 *  eligibleStationKinds) is the overlap-scan case and must NOT block:
 *  the bag is on its way here and claiming it early is the point.
 *
 *  A non-null holder whose kind could not be resolved fails CLOSED. The
 *  FK is ON DELETE SET NULL so this should be unreachable; if it ever
 *  happens, refusing a claim is recoverable and double-claiming a bag is
 *  not. */
function isHeldByDestinationPeer(row: {
  eligibleStationKinds: readonly string[];
  claimedByStationId: string | null;
  claimedByStationKind: string | null;
}): boolean {
  if (row.claimedByStationId == null) return false;
  if (row.claimedByStationKind == null) return true;
  return row.eligibleStationKinds.includes(row.claimedByStationKind);
}

/** Load everything checkClaimGuards needs. `lockQueueRow` takes a row
 *  lock (SELECT ... FOR UPDATE) so concurrent claims serialize — see
 *  claimQueuedBag. */
async function loadClaimGuardInput(
  tx: Reader,
  args: { stationId: string; workflowBagId: string; stationKind: string },
  lockQueueRow: boolean,
): Promise<ClaimGuardInput> {
  const queueSelect = tx
    .select({
      eligibleStationKinds: readBagQueue.eligibleStationKinds,
      claimedByStationId: readBagQueue.claimedByStationId,
      readyState: readBagQueue.readyState,
    })
    .from(readBagQueue)
    .where(eq(readBagQueue.workflowBagId, args.workflowBagId));
  // FOR UPDATE cannot be applied across the nullable side of an outer
  // join, so the holder's kind is a second read rather than a join.
  const [queueRow] = await (lockQueueRow ? queueSelect.for("update") : queueSelect);

  let claimedByStationKind: string | null = null;
  if (queueRow?.claimedByStationId) {
    const [holder] = await tx
      .select({ kind: stations.kind })
      .from(stations)
      .where(eq(stations.id, queueRow.claimedByStationId));
    claimedByStationKind = holder?.kind ?? null;
  }

  const [state] = await tx
    .select({
      stage: readBagState.stage,
      isPaused: readBagState.isPaused,
      isFinalized: readBagState.isFinalized,
      isOnHold: readBagState.isOnHold,
    })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, args.workflowBagId));

  return {
    stationKind: args.stationKind,
    queueRow: queueRow ? { ...queueRow, claimedByStationKind } : null,
    bagStage: state?.stage ?? null,
    isPaused: state?.isPaused ?? false,
    isFinalized: state?.isFinalized ?? false,
    isOnHold: state?.isOnHold ?? false,
  };
}

/** Claim a queued bag for a station. Total function: every rejection is
 *  a Blocker, and unexpected failures are wrapped by advanceBag's catch
 *  (this is only reached from advanceBagInner, which runs inside it).
 *
 *  Concurrency: the authoritative check runs inside the transaction on a
 *  row-locked queue row, so two tablets reaching for the same bag
 *  serialize — the loser re-reads the post-claim row and is refused. The
 *  unlocked pre-check is a fast path for the ordinary rejections; it can
 *  never approve a claim on its own.
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

  const loadArgs = { ...input, stationKind: stationRow.kind };

  // Fast path: reject the ordinary cases (wrong station, paused, not
  // ready yet) without opening a transaction.
  const preBlocker = checkClaimGuards(
    await loadClaimGuardInput(db, loadArgs, false),
  );
  if (preBlocker) return { ok: false, blocker: preBlocker };

  return db.transaction(async (tx) => {
    const locked = await loadClaimGuardInput(tx, loadArgs, true);
    if (!locked.queueRow) {
      // The row existed a moment ago and is gone now: a peer claimed it
      // and the projector's WORKING transition advanced it out of this
      // queue. That is the race, not a missing bag.
      return { ok: false as const, blocker: blockerFor("BAG_ALREADY_CLAIMED") };
    }
    const blocker = checkClaimGuards(locked);
    if (blocker) return { ok: false as const, blocker };

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
        // Non-null: checkClaimGuards refuses a null stage.
        from_stage: locked.bagStage,
        claimed_from_queue: true,
      },
      clientEventId: input.clientEventId,
      enteredByUserId: accountability.enteredByUserId,
      accountableEmployeeId: accountability.accountableEmployeeId,
      accountabilitySource: accountability.accountabilitySource,
      accountableEmployeeNameSnapshot:
        accountability.accountableEmployeeNameSnapshot,
    });
    return { ok: true as const };
  });
}
