// Phase H — pure-math helpers for packaging-material consumption,
// PVC/foil roll usage, and inventory projection. Mirrors the SQL
// the projector uses, exported for vitest coverage.
//
// Honest-data discipline (locked):
//   • Returns confidence + missingInputs alongside every value.
//   • If a required spec is null, value is null with confidence
//     MISSING — never invented.
//   • Unit conversions go through the explicit `weight` shape; we
//     never assume kg vs g without the unit field.

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING";

export interface MaterialConsumptionResult {
  qty: number | null;
  unit: string;
  confidence: Confidence;
  missingInputs: string[];
  formula: string;
}

/** Net weight = gross - tare. If either is missing but `directNet`
 *  is supplied, accept it at MEDIUM confidence (operator-entered).
 *  When tare is unknown and no directNet, return MISSING. */
export function computeNetWeight(input: {
  grossWeightGrams: number | null;
  tareWeightGrams: number | null;
  directNetGrams?: number | null;
}): { netGrams: number | null; confidence: Confidence; missingInputs: string[] } {
  const { grossWeightGrams, tareWeightGrams, directNetGrams } = input;
  if (grossWeightGrams != null && tareWeightGrams != null) {
    const net = grossWeightGrams - tareWeightGrams;
    if (net <= 0) {
      // Bad data — refuse to compute a non-positive net weight.
      return {
        netGrams: null,
        confidence: "MISSING",
        missingInputs: ["valid_weight_pair"],
      };
    }
    return { netGrams: net, confidence: "HIGH", missingInputs: [] };
  }
  if (directNetGrams != null && directNetGrams > 0) {
    return {
      netGrams: directNetGrams,
      confidence: "MEDIUM",
      missingInputs: tareWeightGrams == null ? ["tare_weight"] : ["gross_weight"],
    };
  }
  return {
    netGrams: null,
    confidence: "MISSING",
    missingInputs: ["gross_weight", "tare_weight", "direct_net"],
  };
}

/** Compute expected packaging consumption for one packaging-line
 *  output. Used after PACKAGING_COMPLETE: given the bag's output
 *  counts and the BOM line for one material, produce the qty
 *  consumed (with optional waste allowance applied). Returns
 *  HIGH confidence when the BOM scope matches an output column
 *  directly, MEDIUM when a fallback scope is applied. */
export interface PackagingOutputCounts {
  masterCases: number;
  displaysMade: number;
  looseCards: number;
  bottlesCompleted?: number;
}

export interface BomLine {
  perScope: "UNIT" | "DISPLAY" | "CASE";
  qtyPerUnit: number;
  wasteAllowancePercent: number; // 0..100
}

export function computePackagingConsumption(
  counts: PackagingOutputCounts,
  bom: BomLine,
): MaterialConsumptionResult {
  const baseUnitCount = (() => {
    switch (bom.perScope) {
      case "UNIT":
        // The product's "unit" is the smallest sellable item: a card
        // (= loose_card) or a bottle. Cases × displays-per-case ×
        // units-per-display would also flow but only when those
        // factors are known — that's outside this helper. The user
        // calls this helper once per scope.
        return counts.looseCards + (counts.bottlesCompleted ?? 0);
      case "DISPLAY":
        return counts.displaysMade;
      case "CASE":
        return counts.masterCases;
    }
  })();

  if (bom.qtyPerUnit <= 0) {
    return {
      qty: null,
      unit: "units",
      confidence: "MISSING",
      missingInputs: ["bom_qty_per_unit_positive"],
      formula: "qty_per_unit must be > 0",
    };
  }

  const expected = baseUnitCount * bom.qtyPerUnit;
  const wasteFactor = 1 + Math.max(0, bom.wasteAllowancePercent) / 100;
  const total = Math.round(expected * wasteFactor);
  const conf: Confidence =
    baseUnitCount === 0
      ? // No output at this scope — formula fires zero, MEDIUM
        // because the BOM line existed but the counter was zero.
        "MEDIUM"
      : "HIGH";
  return {
    qty: total,
    unit: "units",
    confidence: conf,
    missingInputs: [],
    formula:
      `(${baseUnitCount} ${bom.perScope.toLowerCase()}s) × ${bom.qtyPerUnit} qty/unit` +
      (bom.wasteAllowancePercent > 0
        ? ` × (1 + ${bom.wasteAllowancePercent}% waste)`
        : ""),
  };
}

// ─── Roll usage ──────────────────────────────────────────────────

export interface RollStandard {
  expectedGramsPerBlister: number | null;
  expectedBlistersPerKg: number | null;
  setupWasteGrams: number;
  changeoverWasteGrams: number;
}

export interface RollUsageResult {
  expectedUsedGrams: number | null;
  confidence: Confidence;
  missingInputs: string[];
  formula: string;
}

/** Expected weight used for `blistersProduced` blisters. Prefers
 *  expected_grams_per_blister (HIGH) over expected_blisters_per_kg
 *  (MEDIUM). Returns MISSING when no standard exists at all. */
export function computeRollExpectedUsed(
  blistersProduced: number,
  standard: RollStandard | null,
): RollUsageResult {
  if (!standard) {
    return {
      expectedUsedGrams: null,
      confidence: "MISSING",
      missingInputs: ["blister_material_standard"],
      formula: "no standard configured",
    };
  }
  if (!Number.isFinite(blistersProduced) || blistersProduced < 0) {
    return {
      expectedUsedGrams: null,
      confidence: "MISSING",
      missingInputs: ["blisters_produced_positive"],
      formula: "blistersProduced must be ≥ 0",
    };
  }
  const setup = Math.max(0, standard.setupWasteGrams ?? 0);
  const changeover = Math.max(0, standard.changeoverWasteGrams ?? 0);

  if (standard.expectedGramsPerBlister != null && standard.expectedGramsPerBlister > 0) {
    const used = Math.round(
      blistersProduced * standard.expectedGramsPerBlister + setup + changeover,
    );
    return {
      expectedUsedGrams: used,
      confidence: "HIGH",
      missingInputs: [],
      formula: `${blistersProduced} blisters × ${standard.expectedGramsPerBlister} g/blister + ${setup}g setup + ${changeover}g changeover`,
    };
  }
  if (standard.expectedBlistersPerKg != null && standard.expectedBlistersPerKg > 0) {
    const used = Math.round(
      (blistersProduced / standard.expectedBlistersPerKg) * 1000 + setup + changeover,
    );
    return {
      expectedUsedGrams: used,
      confidence: "MEDIUM",
      missingInputs: [],
      formula: `${blistersProduced} blisters ÷ ${standard.expectedBlistersPerKg} blisters/kg × 1000g + setup + changeover`,
    };
  }
  return {
    expectedUsedGrams: null,
    confidence: "MISSING",
    missingInputs: ["expected_grams_per_blister", "expected_blisters_per_kg"],
    formula: "neither metric configured on the standard",
  };
}

/** Variance between actual and expected used. Actual is null until
 *  the roll is weighed back. Returns null variance when actual is
 *  null. */
export function computeRollVariance(
  actualUsedGrams: number | null,
  expectedUsedGrams: number | null,
): {
  varianceGrams: number | null;
  variancePct: number | null;
  confidence: Confidence;
} {
  if (actualUsedGrams == null || expectedUsedGrams == null) {
    return {
      varianceGrams: null,
      variancePct: null,
      confidence: actualUsedGrams == null ? "MEDIUM" : "MISSING",
    };
  }
  if (expectedUsedGrams === 0) {
    return {
      varianceGrams: actualUsedGrams,
      variancePct: null,
      confidence: "MEDIUM",
    };
  }
  const variance = actualUsedGrams - expectedUsedGrams;
  const pct = +((variance / expectedUsedGrams) * 100).toFixed(3);
  return {
    varianceGrams: variance,
    variancePct: pct,
    confidence: "HIGH",
  };
}

/** Project remaining roll weight + remaining blisters. Used for
 *  the Active Rolls panel. Returns null projections when no
 *  standard exists. */
export function projectRollRemaining(input: {
  startingWeightGrams: number | null;
  expectedUsedGrams: number | null;
  standard: RollStandard | null;
}): {
  remainingWeightGrams: number | null;
  remainingBlisters: number | null;
  confidence: Confidence;
  missingInputs: string[];
} {
  const { startingWeightGrams, expectedUsedGrams, standard } = input;
  const missing: string[] = [];
  if (startingWeightGrams == null) missing.push("starting_weight");
  if (!standard) missing.push("blister_material_standard");
  if (startingWeightGrams == null) {
    return {
      remainingWeightGrams: null,
      remainingBlisters: null,
      confidence: "MISSING",
      missingInputs: missing,
    };
  }
  const remainingW = Math.max(0, startingWeightGrams - (expectedUsedGrams ?? 0));
  if (!standard) {
    return {
      remainingWeightGrams: remainingW,
      remainingBlisters: null,
      confidence: "LOW",
      missingInputs: missing,
    };
  }
  let remainingBlisters: number | null = null;
  let conf: Confidence = "MEDIUM";
  if (standard.expectedGramsPerBlister != null && standard.expectedGramsPerBlister > 0) {
    remainingBlisters = Math.floor(remainingW / standard.expectedGramsPerBlister);
    conf = "HIGH";
  } else if (
    standard.expectedBlistersPerKg != null &&
    standard.expectedBlistersPerKg > 0
  ) {
    remainingBlisters = Math.floor(
      (remainingW / 1000) * standard.expectedBlistersPerKg,
    );
    conf = "MEDIUM";
  }
  return {
    remainingWeightGrams: remainingW,
    remainingBlisters,
    confidence: conf,
    missingInputs: [],
  };
}

/** Apply a waste-allowance multiplier safely. Pure helper used
 *  by the projector + the metric API. */
export function applyWasteAllowance(qty: number, percent: number | null): number {
  const p = Math.max(0, percent ?? 0);
  return Math.round(qty * (1 + p / 100));
}
