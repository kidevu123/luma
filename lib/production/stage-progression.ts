// Stage-progression helper — pure logic shared by the floor server
// action and the floor client UI. Decides whether a forward stage
// event is allowed given the bag's current stage, and which station
// kinds may release a bag at which stages, and which station kinds
// may pick up a bag at which stages.
//
// Single source of truth for:
//   • app/(floor)/floor/[token]/actions.ts (server-side guards)
//   • app/(floor)/floor/[token]/stage-action-buttons.tsx (UI gate)
//   • app/(floor)/floor/[token]/page.tsx (BagAdvancedBanner)

export const EVENT_STAGE_PREREQ: Readonly<Record<string, ReadonlyArray<string>>> = {
  BLISTER_COMPLETE: ["STARTED"],
  HANDPACK_BLISTER_COMPLETE: ["STARTED"],
  SEALING_SEGMENT_COMPLETE: ["BLISTERED"],
  SEALING_COMPLETE: ["BLISTERED"],
  PACKAGING_SNAPSHOT: ["SEALED"],
  PACKAGING_COMPLETE: ["SEALED"],
  BOTTLE_HANDPACK_COMPLETE: ["STARTED"],
  BOTTLE_CAP_SEAL_COMPLETE: ["BLISTERED"],
  BOTTLE_STICKER_COMPLETE: ["SEALED"],
};

// A station may release a bag forward only after that station's stage
// event has fired. Blister releases bags at BLISTERED, sealing at
// SEALED, packaging/sticker never releases (they finalize). The card
// is NOT touched by release; it stays ASSIGNED to travel with the bag.
export const STATION_RELEASE_FROM_STAGE: Readonly<Record<string, string>> = {
  BLISTER: "BLISTERED",
  HANDPACK_BLISTER: "BLISTERED",
  SEALING: "SEALED",
  BOTTLE_HANDPACK: "BLISTERED",
  BOTTLE_CAP_SEAL: "SEALED",
  // PACKAGING, COMBINED, BOTTLE_STICKER do NOT release forward — the
  // bag is closed by BAG_FINALIZED at the last station.
};

// A station may pick up a bag whose current stage matches one of the
// stages this station kind operates on. The card must be ASSIGNED
// (already attached to a workflow_bag) and no other station can
// currently hold the bag.
export const STATION_PICKUP_FROM_STAGE: Readonly<Record<string, ReadonlyArray<string>>> = {
  // SEALING accepts STARTED so operators can claim a bag while blister
  // is still running (overlap scan). SEALING_COMPLETE still requires
  // BLISTERED — the Complete button stays gated until upstream finishes.
  SEALING: ["STARTED", "BLISTERED"],
  // PACKAGING accepts BLISTERED so operators can claim a bag while sealing
  // is still running (overlap scan). PACKAGING_COMPLETE still requires
  // SEALED — the Complete button stays gated until upstream finishes.
  PACKAGING: ["BLISTERED", "SEALED"],
  BOTTLE_CAP_SEAL: ["BLISTERED"],
  BOTTLE_STICKER: ["SEALED"],
  // BLISTER + BOTTLE_HANDPACK + COMBINED accept the bag via first
  // CARD_ASSIGNED on an IDLE card, not via pickup of an ASSIGNED card.
};

/** First-op stations may re-open a bag still at STARTED on the same
 *  station (operator refresh / close-out resume). Not downstream pickup. */
export const STATION_STARTED_RESUME_FROM_STAGE: Readonly<
  Record<string, ReadonlyArray<string>>
> = {
  BLISTER: ["STARTED"],
  HANDPACK_BLISTER: ["STARTED"],
  BOTTLE_HANDPACK: ["STARTED"],
  COMBINED: ["STARTED"],
};

/** Operator-safe message when a card's bag cannot open at this station. */
export function formatFloorStationBagOpenError(args: {
  stationKind: string;
  bagStage: string | null | undefined;
  pickupStages: readonly string[];
}): string {
  const stage = args.bagStage ?? "unknown";
  if (
    args.pickupStages.length === 0 &&
    (STATION_STARTED_RESUME_FROM_STAGE[args.stationKind] ?? []).includes(
      stage,
    )
  ) {
    // Should not reach callers once resume path is wired — defensive copy.
    return "This bag is not ready for this station yet.";
  }
  if (args.pickupStages.length === 0) {
    return "This bag is not ready for this station yet.";
  }
  return `This bag is not ready for this station yet (currently ${stage}).`;
}

// Station kinds that finalize a bag (close the workflow + return QR
// to IDLE). Anything else MUST use release, not finalize.
// BOTTLE_STICKER is the last station in the bottle pipeline so it
// finalizes there rather than releasing forward.
export const STATIONS_THAT_FINALIZE: ReadonlySet<string> = new Set([
  "PACKAGING",
  "COMBINED",
  "BOTTLE_STICKER",
]);

export type StageProgressionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** True if the event is allowed to fire from the bag's current stage. */
export function checkStageProgression(args: {
  eventType: string;
  currentStage: string | null | undefined;
  isPaused?: boolean;
  isFinalized?: boolean;
  /** SEALING-PARTIAL-CLOSEOUT-1: after partial sealing close-out, packaging
   *  may complete while global stage remains BLISTERED. */
  packagingPartialSealedReady?: boolean;
}): StageProgressionResult {
  if (args.isFinalized) {
    return { allowed: false, reason: "Bag is already finalized." };
  }
  if (args.isPaused) {
    return {
      allowed: false,
      reason: "Bag is paused — resume it before firing stage events.",
    };
  }
  const prereq = EVENT_STAGE_PREREQ[args.eventType];
  if (!prereq) {
    // Non-progression event (e.g. CARD_ASSIGNED, BAG_PAUSED) — let
    // the caller decide; this helper only governs forward stages.
    return { allowed: true };
  }
  const stage = args.currentStage ?? null;
  if (stage == null) {
    // Read model lag — defer to the caller. The server-side guard
    // re-reads state inside the action anyway.
    return { allowed: true };
  }
  if (prereq.includes(stage)) return { allowed: true };
  if (
    args.eventType === "PACKAGING_COMPLETE" &&
    args.packagingPartialSealedReady === true &&
    stage === "BLISTERED"
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Bag is at stage ${stage} — ${args.eventType} expected ${prereq.join(" or ")}. Cannot fire again.`,
  };
}
