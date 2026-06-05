/**
 * Blister machine counter math — pure helpers, no DB.
 *
 * Floor operators enter machine CYCLE counts. Each cycle produces
 * `cardsPerTurn` finished cards (Blister Machine = 2).
 *
 * Manufacturer yield specs are expressed per full blister CYCLE per kg
 * (not multiplied by cardsPerTurn).
 */

export type MaterialRole = "PVC" | "FOIL";

/** Haute / supplier sheet defaults when no configured standard exists. */
export const MANUFACTURER_YIELD_DEFAULTS: Record<
  MaterialRole,
  { blistersPerKg: number; label: string }
> = {
  PVC: { blistersPerKg: 1600, label: "Manufacturer (25 kg → 40,000 cycles)" },
  FOIL: { blistersPerKg: 6400, label: "Manufacturer (5 kg → 32,000 cycles)" },
};

export function gramsPerCycleFromBlistersPerKg(blistersPerKg: number): number | null {
  if (!Number.isFinite(blistersPerKg) || blistersPerKg <= 0) return null;
  return 1000 / blistersPerKg;
}

export function cardsFromMachineCycles(
  machineCycles: number | null | undefined,
  cardsPerTurn: number,
): number | null {
  if (machineCycles == null || !Number.isFinite(machineCycles) || machineCycles < 0) {
    return null;
  }
  if (!Number.isInteger(cardsPerTurn) || cardsPerTurn < 1) return null;
  return machineCycles * cardsPerTurn;
}

export function manufacturerExpectedCycles(
  netWeightGrams: number | null | undefined,
  blistersPerKg: number,
): number | null {
  if (netWeightGrams == null || !Number.isFinite(netWeightGrams) || netWeightGrams <= 0) {
    return null;
  }
  if (!Number.isFinite(blistersPerKg) || blistersPerKg <= 0) return null;
  return Math.round((netWeightGrams / 1000) * blistersPerKg);
}

export function manufacturerExpectedCards(
  netWeightGrams: number | null | undefined,
  blistersPerKg: number,
  cardsPerTurn: number,
): number | null {
  const cycles = manufacturerExpectedCycles(netWeightGrams, blistersPerKg);
  return cardsFromMachineCycles(cycles, cardsPerTurn);
}

/** Material that should have been consumed at manufacturer efficiency for these cycles. */
export function expectedMaterialGramsAtManufacturerRate(
  machineCycles: number | null | undefined,
  blistersPerKg: number,
): number | null {
  if (machineCycles == null || machineCycles <= 0) return null;
  const gpc = gramsPerCycleFromBlistersPerKg(blistersPerKg);
  if (gpc == null) return null;
  return Math.round(machineCycles * gpc);
}

/** Positive = used more material than mfr spec implies for cycles produced. */
export function materialWasteGramsVsManufacturer(
  actualUsedGrams: number | null | undefined,
  machineCycles: number | null | undefined,
  blistersPerKg: number,
): number | null {
  if (actualUsedGrams == null || actualUsedGrams <= 0) return null;
  const expected = expectedMaterialGramsAtManufacturerRate(machineCycles, blistersPerKg);
  if (expected == null) return null;
  return actualUsedGrams - expected;
}

/** Prorate finalized packaging cards to this roll's share of bag segments. */
export function proratePackagingCards(
  unitsYielded: number | null | undefined,
  rollSegmentsOnBag: number,
  totalBagSegments: number,
): number | null {
  if (unitsYielded == null || unitsYielded < 0) return null;
  if (rollSegmentsOnBag <= 0 || totalBagSegments <= 0) return null;
  return Math.round((unitsYielded * rollSegmentsOnBag) / totalBagSegments);
}

export function remainingCyclesAtRate(
  netWeightGrams: number | null | undefined,
  machineCyclesUsed: number,
  blistersPerKg: number,
): number | null {
  const capacity = manufacturerExpectedCycles(netWeightGrams, blistersPerKg);
  if (capacity == null) return null;
  return Math.max(0, capacity - machineCyclesUsed);
}

export function remainingKgFromCycles(
  remainingCycles: number | null | undefined,
  blistersPerKg: number,
): number | null {
  if (remainingCycles == null || remainingCycles < 0) return null;
  const gpc = gramsPerCycleFromBlistersPerKg(blistersPerKg);
  if (gpc == null) return null;
  return Math.round(((remainingCycles * gpc) / 1000) * 100) / 100;
}

export function yieldPct(actual: number | null, expected: number | null): number | null {
  if (actual == null || expected == null || expected <= 0) return null;
  return Math.round((actual / expected) * 1000) / 10;
}
