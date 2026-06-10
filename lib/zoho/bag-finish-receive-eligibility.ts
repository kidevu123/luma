// ZOHO-BAG-FINISH-RECEIVE — when a physical bag may preview/commit Zoho receive.

export type BagFinishReceiveEligibility =
  | { eligible: true; stage: "finished_or_depleted" }
  | { eligible: false; reason: string };

export type BagFinishAllocationSnapshot = {
  hasOpenSession: boolean;
  hasClosedOrDepletedSession: boolean;
  lastSessionStatus: string | null;
  totalConsumedQty: number;
  lastEndingBalanceQty: number | null;
};

/**
 * Bag-finish receive is allowed after production close/deplete, not at intake.
 * Fresh unused bags stay pending until floor lifecycle completes.
 */
export function assessBagFinishReceiveEligibility(input: {
  bagStatus: string;
  isLiveReceiveCommitted: boolean;
  allocation: BagFinishAllocationSnapshot;
}): BagFinishReceiveEligibility {
  if (input.isLiveReceiveCommitted) {
    return {
      eligible: false,
      reason: "Zoho purchase receive already committed for this physical bag.",
    };
  }

  if (input.allocation.hasOpenSession) {
    return {
      eligible: false,
      reason:
        "Bag still has an open allocation session. Close or deplete the bag on the floor first.",
    };
  }

  const finishedByStatus =
    input.bagStatus === "EMPTIED" ||
    (input.bagStatus === "AVAILABLE" &&
      input.allocation.hasClosedOrDepletedSession);

  if (input.bagStatus === "EMPTIED") {
    return { eligible: true, stage: "finished_or_depleted" };
  }

  if (finishedByStatus && input.allocation.hasClosedOrDepletedSession) {
    return { eligible: true, stage: "finished_or_depleted" };
  }

  if (
    input.bagStatus === "AVAILABLE" &&
    !input.allocation.hasClosedOrDepletedSession
  ) {
    return {
      eligible: false,
      reason:
        "Bag has not been finished or depleted yet. Zoho receive happens at bag closeout, not intake.",
    };
  }

  if (input.bagStatus === "IN_USE") {
    return {
      eligible: false,
      reason: "Bag is in use on the floor. Finish or deplete before Zoho receive.",
    };
  }

  return {
    eligible: false,
    reason: `Bag status ${input.bagStatus} is not eligible for Zoho bag-finish receive.`,
  };
}
