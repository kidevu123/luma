// Stage-progression helper — pure logic shared by the floor server
// action and the floor client UI. Decides whether a forward stage
// event is allowed given the bag's current stage.
//
// Single source of truth for both:
//   • app/(floor)/floor/[token]/actions.ts (server-side guard)
//   • app/(floor)/floor/[token]/stage-action-buttons.tsx (UI gate)
//   • app/(floor)/floor/[token]/page.tsx (BagAdvancedBanner)

export const EVENT_STAGE_PREREQ: Readonly<Record<string, ReadonlyArray<string>>> = {
  BLISTER_COMPLETE: ["STARTED"],
  SEALING_COMPLETE: ["BLISTERED"],
  PACKAGING_SNAPSHOT: ["SEALED"],
  PACKAGING_COMPLETE: ["SEALED"],
  BOTTLE_HANDPACK_COMPLETE: ["STARTED"],
  BOTTLE_CAP_SEAL_COMPLETE: ["BLISTERED"],
  BOTTLE_STICKER_COMPLETE: ["SEALED"],
};

export type StageProgressionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** True if the event is allowed to fire from the bag's current stage. */
export function checkStageProgression(args: {
  eventType: string;
  currentStage: string | null | undefined;
  isPaused?: boolean;
  isFinalized?: boolean;
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
  return {
    allowed: false,
    reason: `Bag is at stage ${stage} — ${args.eventType} expected ${prereq.join(" or ")}. Cannot fire again.`,
  };
}
