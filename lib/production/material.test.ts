// Phase H — pure-helper tests for packaging-material consumption +
// PVC/foil roll usage. Pin every confidence-ladder branch.

import { describe, it, expect } from "vitest";
import {
  computeNetWeight,
  computePackagingConsumption,
  computeRollExpectedUsed,
  computeRollVariance,
  projectRollRemaining,
  applyWasteAllowance,
} from "./material";

describe("computeNetWeight", () => {
  it("HIGH when gross + tare both present", () => {
    const r = computeNetWeight({ grossWeightGrams: 5000, tareWeightGrams: 200 });
    expect(r.netGrams).toBe(4800);
    expect(r.confidence).toBe("HIGH");
    expect(r.missingInputs).toEqual([]);
  });

  it("MEDIUM when directNet supplied with no tare", () => {
    const r = computeNetWeight({
      grossWeightGrams: 5000,
      tareWeightGrams: null,
      directNetGrams: 4750,
    });
    expect(r.netGrams).toBe(4750);
    expect(r.confidence).toBe("MEDIUM");
    expect(r.missingInputs).toContain("tare_weight");
  });

  it("MISSING when neither direct nor pair", () => {
    const r = computeNetWeight({ grossWeightGrams: null, tareWeightGrams: null });
    expect(r.netGrams).toBe(null);
    expect(r.confidence).toBe("MISSING");
    expect(r.missingInputs).toContain("direct_net");
  });

  it("refuses non-positive net (data-quality check)", () => {
    const r = computeNetWeight({ grossWeightGrams: 100, tareWeightGrams: 200 });
    expect(r.netGrams).toBe(null);
    expect(r.confidence).toBe("MISSING");
  });
});

describe("computePackagingConsumption", () => {
  const counts = {
    masterCases: 5,
    displaysMade: 60,
    looseCards: 3,
    bottlesCompleted: 0,
  };

  it("CASE-scope BOM consumes 1 box per case + waste", () => {
    const r = computePackagingConsumption(counts, {
      perScope: "CASE",
      qtyPerUnit: 1,
      wasteAllowancePercent: 5,
    });
    // 5 cases × 1 = 5; × 1.05 = 5.25 → 5
    expect(r.qty).toBe(5);
    expect(r.confidence).toBe("HIGH");
  });

  it("DISPLAY-scope multiplies by displays count", () => {
    const r = computePackagingConsumption(counts, {
      perScope: "DISPLAY",
      qtyPerUnit: 1,
      wasteAllowancePercent: 0,
    });
    expect(r.qty).toBe(60);
    expect(r.confidence).toBe("HIGH");
  });

  it("UNIT-scope sums loose cards + bottles", () => {
    const r = computePackagingConsumption(
      { ...counts, bottlesCompleted: 100 },
      { perScope: "UNIT", qtyPerUnit: 2, wasteAllowancePercent: 0 },
    );
    // (3 + 100) * 2 = 206
    expect(r.qty).toBe(206);
    expect(r.confidence).toBe("HIGH");
  });

  it("MEDIUM confidence when scope output is zero", () => {
    const r = computePackagingConsumption(
      { masterCases: 0, displaysMade: 0, looseCards: 0 },
      { perScope: "DISPLAY", qtyPerUnit: 1, wasteAllowancePercent: 0 },
    );
    expect(r.qty).toBe(0);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("MISSING when bom qty <= 0", () => {
    const r = computePackagingConsumption(counts, {
      perScope: "CASE",
      qtyPerUnit: 0,
      wasteAllowancePercent: 0,
    });
    expect(r.qty).toBe(null);
    expect(r.confidence).toBe("MISSING");
  });

  it("waste allowance compounds correctly", () => {
    const r = computePackagingConsumption(counts, {
      perScope: "DISPLAY",
      qtyPerUnit: 1,
      wasteAllowancePercent: 10,
    });
    // 60 × 1.10 = 66
    expect(r.qty).toBe(66);
  });
});

describe("computeRollExpectedUsed", () => {
  it("HIGH when expected_grams_per_blister is set", () => {
    const r = computeRollExpectedUsed(1000, {
      expectedGramsPerBlister: 5.5,
      expectedBlistersPerKg: null,
      setupWasteGrams: 100,
      changeoverWasteGrams: 50,
    });
    expect(r.expectedUsedGrams).toBe(1000 * 5.5 + 100 + 50);
    expect(r.confidence).toBe("HIGH");
  });

  it("MEDIUM when only blisters_per_kg available", () => {
    const r = computeRollExpectedUsed(1000, {
      expectedGramsPerBlister: null,
      expectedBlistersPerKg: 200,
      setupWasteGrams: 0,
      changeoverWasteGrams: 0,
    });
    // 1000 / 200 = 5kg = 5000g
    expect(r.expectedUsedGrams).toBe(5000);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("MISSING when no standard configured", () => {
    const r = computeRollExpectedUsed(1000, null);
    expect(r.expectedUsedGrams).toBe(null);
    expect(r.confidence).toBe("MISSING");
    expect(r.missingInputs).toContain("blister_material_standard");
  });

  it("MISSING when standard exists but no metric set", () => {
    const r = computeRollExpectedUsed(1000, {
      expectedGramsPerBlister: null,
      expectedBlistersPerKg: null,
      setupWasteGrams: 0,
      changeoverWasteGrams: 0,
    });
    expect(r.expectedUsedGrams).toBe(null);
    expect(r.confidence).toBe("MISSING");
  });

  it("rejects negative blisters_produced", () => {
    const r = computeRollExpectedUsed(-1, {
      expectedGramsPerBlister: 5,
      expectedBlistersPerKg: null,
      setupWasteGrams: 0,
      changeoverWasteGrams: 0,
    });
    expect(r.expectedUsedGrams).toBe(null);
    expect(r.confidence).toBe("MISSING");
  });
});

describe("computeRollVariance", () => {
  it("HIGH when both actual + expected present", () => {
    const r = computeRollVariance(5500, 5000);
    expect(r.varianceGrams).toBe(500);
    expect(r.variancePct).toBe(10);
    expect(r.confidence).toBe("HIGH");
  });

  it("MEDIUM when actual missing (haven't weighed yet)", () => {
    const r = computeRollVariance(null, 5000);
    expect(r.varianceGrams).toBe(null);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("MISSING when expected null too", () => {
    const r = computeRollVariance(5000, null);
    expect(r.confidence).toBe("MISSING");
  });
});

describe("projectRollRemaining", () => {
  it("HIGH when starting weight + grams_per_blister standard", () => {
    const r = projectRollRemaining({
      startingWeightGrams: 10000,
      expectedUsedGrams: 2000,
      standard: {
        expectedGramsPerBlister: 5,
        expectedBlistersPerKg: null,
        setupWasteGrams: 0,
        changeoverWasteGrams: 0,
      },
    });
    expect(r.remainingWeightGrams).toBe(8000);
    expect(r.remainingBlisters).toBe(1600);
    expect(r.confidence).toBe("HIGH");
  });

  it("MEDIUM when only blisters_per_kg standard", () => {
    const r = projectRollRemaining({
      startingWeightGrams: 10000,
      expectedUsedGrams: 0,
      standard: {
        expectedGramsPerBlister: null,
        expectedBlistersPerKg: 200,
        setupWasteGrams: 0,
        changeoverWasteGrams: 0,
      },
    });
    // 10kg × 200 = 2000 blisters
    expect(r.remainingBlisters).toBe(2000);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("LOW when starting weight present but no standard", () => {
    const r = projectRollRemaining({
      startingWeightGrams: 10000,
      expectedUsedGrams: null,
      standard: null,
    });
    expect(r.remainingWeightGrams).toBe(10000);
    expect(r.remainingBlisters).toBe(null);
    expect(r.confidence).toBe("LOW");
    expect(r.missingInputs).toContain("blister_material_standard");
  });

  it("MISSING when no starting weight", () => {
    const r = projectRollRemaining({
      startingWeightGrams: null,
      expectedUsedGrams: null,
      standard: null,
    });
    expect(r.confidence).toBe("MISSING");
    expect(r.missingInputs).toContain("starting_weight");
  });

  it("clamps remaining weight at 0 — never negative", () => {
    const r = projectRollRemaining({
      startingWeightGrams: 1000,
      expectedUsedGrams: 5000,
      standard: {
        expectedGramsPerBlister: 5,
        expectedBlistersPerKg: null,
        setupWasteGrams: 0,
        changeoverWasteGrams: 0,
      },
    });
    expect(r.remainingWeightGrams).toBe(0);
    expect(r.remainingBlisters).toBe(0);
  });
});

describe("applyWasteAllowance", () => {
  it("scales by (1 + percent/100)", () => {
    expect(applyWasteAllowance(100, 10)).toBe(110);
    expect(applyWasteAllowance(100, 0)).toBe(100);
    expect(applyWasteAllowance(100, null)).toBe(100);
  });
  it("rejects negative percent (clamped to 0)", () => {
    expect(applyWasteAllowance(100, -5)).toBe(100);
  });
});

describe("no-fake-output contracts", () => {
  it("never invents net weight when gross/tare/direct all null", () => {
    const r = computeNetWeight({ grossWeightGrams: null, tareWeightGrams: null });
    expect(r.netGrams).toBe(null);
  });

  it("never invents roll usage when no standard", () => {
    const r = computeRollExpectedUsed(1000, null);
    expect(r.expectedUsedGrams).toBe(null);
  });

  it("never silently discounts waste in the wrong direction", () => {
    // waste of 10% = 10% MORE consumption (not less). Verify.
    const r = computePackagingConsumption(
      { masterCases: 10, displaysMade: 0, looseCards: 0 },
      { perScope: "CASE", qtyPerUnit: 1, wasteAllowancePercent: 10 },
    );
    expect(r.qty).toBe(11);
  });
});
