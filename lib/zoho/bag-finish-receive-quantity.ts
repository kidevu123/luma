// ZOHO-BAG-FINISH-RECEIVE — physical bag quantity for Zoho purchase receive.

export type BagFinishReceiveQuantitySource =
  | "declared_pill_count"
  | "final_closed_pill_count"
  | "pill_count_fallback";

export type BagFinishReceiveQuantityResult =
  | {
      ok: true;
      quantity: number;
      source: BagFinishReceiveQuantitySource;
    }
  | { ok: false; reason: string };

/**
 * Resolve the quantity Luma sends to Zoho for a physical bag receive.
 *
 * Full-bag policy: use declared intake quantity (physical bag label), never
 * production-output or allocation consumed quantities.
 */
export function resolveBagFinishReceiveQuantity(input: {
  declaredPillCount: number | null;
  pillCount: number | null;
  /** When set, indicates the bag was closed/depleted with an authoritative count. */
  finalClosedPillCount?: number | null;
}): BagFinishReceiveQuantityResult {
  if (
    input.finalClosedPillCount != null &&
    Number.isFinite(input.finalClosedPillCount) &&
    input.finalClosedPillCount > 0
  ) {
    return {
      ok: true,
      quantity: input.finalClosedPillCount,
      source: "final_closed_pill_count",
    };
  }

  if (
    input.declaredPillCount != null &&
    Number.isFinite(input.declaredPillCount) &&
    input.declaredPillCount > 0
  ) {
    return {
      ok: true,
      quantity: input.declaredPillCount,
      source: "declared_pill_count",
    };
  }

  if (
    input.pillCount != null &&
    Number.isFinite(input.pillCount) &&
    input.pillCount > 0
  ) {
    return {
      ok: true,
      quantity: input.pillCount,
      source: "pill_count_fallback",
    };
  }

  return {
    ok: false,
    reason: "Bag has no physical quantity for Zoho receive.",
  };
}

/** Guard: production-output quantities must never drive bag receive. */
export function assertNotProductionOutputReceiveQuantity(
  candidate: number,
  forbidden: {
    quantityGood?: number | null;
    unitAssemblyQuantity?: number | null;
    looseCards?: number | null;
    consumedAllocationQty?: number | null;
  },
): { ok: true } | { ok: false; reason: string } {
  const checks: Array<[string, number | null | undefined]> = [
    ["quantity_good", forbidden.quantityGood],
    ["unit_assembly_quantity", forbidden.unitAssemblyQuantity],
    ["loose_cards", forbidden.looseCards],
    ["consumed_allocation_qty", forbidden.consumedAllocationQty],
  ];
  for (const [label, value] of checks) {
    if (value != null && value > 0 && candidate === value) {
      return {
        ok: false,
        reason: `Receive quantity must not equal production ${label} (${value}). Use physical bag quantity.`,
      };
    }
  }
  return { ok: true };
}
