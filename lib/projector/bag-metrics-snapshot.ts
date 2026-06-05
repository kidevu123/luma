// Compute read_bag_metrics counts from workflow events + corrections.
// Shared by BAG_FINALIZED projection and SUBMISSION_CORRECTED reprojection.

import {
  buildLatestSubmissionCorrectionByTarget,
  resolveEffectiveEventPayload,
  type WorkflowEventCorrectionSlice,
} from "@/lib/production/submission-correction-effective";

export type BagMetricsCountSnapshot = {
  masterCases: number;
  displaysMade: number;
  looseCards: number;
  damagedPackaging: number;
  rippedCards: number;
  unitsYielded: number;
  yieldPctText: string | null;
};

type ProductSpec = {
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
};

export function computePackagingCountsFromEvents(
  events: readonly WorkflowEventCorrectionSlice[],
): Pick<
  BagMetricsCountSnapshot,
  "masterCases" | "displaysMade" | "looseCards" | "damagedPackaging" | "rippedCards"
> {
  const corrections = buildLatestSubmissionCorrectionByTarget(events);

  let masterCases = 0;
  let displaysMade = 0;
  let looseCards = 0;
  let damagedPackaging = 0;
  let rippedCards = 0;

  const packagingCompleteEv = [...events]
    .reverse()
    .find((e) => e.eventType === "PACKAGING_COMPLETE");
  if (packagingCompleteEv) {
    const p = resolveEffectiveEventPayload(packagingCompleteEv, corrections);
    masterCases = Number(p["master_cases"] ?? 0) || 0;
    displaysMade = Number(p["displays_made"] ?? 0) || 0;
    looseCards = Number(p["loose_cards"] ?? 0) || 0;
    damagedPackaging = Number(p["damaged_packaging"] ?? 0) || 0;
    rippedCards = Number(p["ripped_cards"] ?? 0) || 0;
  } else {
    const snapshot = [...events]
      .reverse()
      .find((e) => e.eventType === "PACKAGING_SNAPSHOT");
    if (snapshot) {
      const p = resolveEffectiveEventPayload(snapshot, corrections);
      looseCards = Number(p["count_total"] ?? 0) || 0;
    }
  }

  return {
    masterCases,
    displaysMade,
    looseCards,
    damagedPackaging,
    rippedCards,
  };
}

export function computeUnitsYieldedFromPackagingCounts(
  counts: Pick<
    BagMetricsCountSnapshot,
    "masterCases" | "displaysMade" | "looseCards"
  >,
  product: ProductSpec | null,
): number {
  if (product?.unitsPerDisplay && product.displaysPerCase) {
    const cardsPerCase = product.unitsPerDisplay * product.displaysPerCase;
    return (
      counts.masterCases * cardsPerCase +
      counts.displaysMade * product.unitsPerDisplay +
      counts.looseCards
    );
  }
  return counts.looseCards;
}

export function computeYieldPctText(
  unitsYielded: number,
  inputPillCount: number | null,
): string | null {
  if (inputPillCount != null && inputPillCount > 0) {
    return ((unitsYielded / inputPillCount) * 100).toFixed(3);
  }
  return null;
}

export function computeBagMetricsCountSnapshot(args: {
  events: readonly WorkflowEventCorrectionSlice[];
  product: ProductSpec | null;
  inputPillCount: number | null;
}): BagMetricsCountSnapshot {
  const packaging = computePackagingCountsFromEvents(args.events);
  const unitsYielded = computeUnitsYieldedFromPackagingCounts(
    packaging,
    args.product,
  );
  return {
    ...packaging,
    unitsYielded,
    yieldPctText: computeYieldPctText(unitsYielded, args.inputPillCount),
  };
}
