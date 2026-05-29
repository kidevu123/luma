// ROLL-WEIGHT-KG-INPUT-1 — tests for kg ↔ grams conversion helpers.

import { describe, it, expect } from "vitest";
import { kgToGrams, formatGramsAsKg } from "./roll-weight";

describe("kgToGrams", () => {
  it("converts whole kg to grams", () => {
    expect(kgToGrams(12)).toBe(12000);
    expect(kgToGrams(1)).toBe(1000);
  });

  it("converts common decimal kg values correctly", () => {
    expect(kgToGrams(12.4)).toBe(12400);
    expect(kgToGrams(8.75)).toBe(8750);
    expect(kgToGrams(0.35)).toBe(350);
  });

  it("rounds to nearest gram for sub-gram precision", () => {
    expect(kgToGrams(0.0015)).toBe(2);  // 1.5 g → rounds up
    expect(kgToGrams(0.0014)).toBe(1);  // 1.4 g → rounds down
  });

  it("returns null for null input", () => {
    expect(kgToGrams(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(kgToGrams(undefined)).toBe(null);
  });

  it("handles zero without returning null", () => {
    expect(kgToGrams(0)).toBe(0);
  });
});

describe("formatGramsAsKg", () => {
  it("formats whole kg without decimal", () => {
    expect(formatGramsAsKg(12000)).toBe("12 kg");
    expect(formatGramsAsKg(1000)).toBe("1 kg");
  });

  it("strips trailing zeros from decimal kg", () => {
    expect(formatGramsAsKg(12400)).toBe("12.4 kg");
    expect(formatGramsAsKg(8750)).toBe("8.75 kg");
    expect(formatGramsAsKg(350)).toBe("0.35 kg");
  });

  it("preserves up to 3 decimal places", () => {
    // 1001 g = 1.001 kg
    expect(formatGramsAsKg(1001)).toBe("1.001 kg");
  });

  it("returns dash for null", () => {
    expect(formatGramsAsKg(null)).toBe("—");
  });

  it("returns dash for undefined", () => {
    expect(formatGramsAsKg(undefined)).toBe("—");
  });

  it("roundtrips kgToGrams values correctly", () => {
    // Values entered by users should display the same as entered
    expect(formatGramsAsKg(kgToGrams(12.4))).toBe("12.4 kg");
    expect(formatGramsAsKg(kgToGrams(8.75))).toBe("8.75 kg");
    expect(formatGramsAsKg(kgToGrams(0.35))).toBe("0.35 kg");
  });
});
