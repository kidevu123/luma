import { describe, expect, it } from "vitest";
import {
  cardsFromMachineCycles,
  expectedMaterialGramsAtManufacturerRate,
  manufacturerExpectedCycles,
  materialWasteGramsVsManufacturer,
  proratePackagingCards,
  remainingCyclesAtRate,
  yieldPct,
} from "./blister-cycle-math";

describe("blister-cycle-math", () => {
  it("multiplies machine cycles by cards per turn", () => {
    expect(cardsFromMachineCycles(100, 2)).toBe(200);
    expect(cardsFromMachineCycles(3256, 2)).toBe(6512);
  });

  it("manufacturer expected cycles uses kg × blisters/kg without cards multiplier", () => {
    expect(manufacturerExpectedCycles(8080, 1600)).toBe(12928);
    expect(manufacturerExpectedCycles(4640, 6400)).toBe(29696);
  });

  it("prorates packaging to roll share of bag segments", () => {
    expect(proratePackagingCards(1000, 500, 1000)).toBe(500);
    expect(proratePackagingCards(6512, 3256, 3256)).toBe(6512);
  });

  it("material waste vs manufacturer is actual minus expected grams", () => {
    const expected = expectedMaterialGramsAtManufacturerRate(3256, 1600);
    expect(expected).toBe(2035);
    expect(materialWasteGramsVsManufacturer(8080, 3256, 1600)).toBe(6045);
  });

  it("remaining cycles at manufacturer rate", () => {
    expect(remainingCyclesAtRate(7860, 0, 1600)).toBe(12576);
    expect(remainingCyclesAtRate(7860, 1000, 1600)).toBe(11576);
  });

  it("yield pct", () => {
    expect(yieldPct(3256, 12928)).toBe(25.2);
  });
});
