import { describe, expect, it } from "vitest";
import { mapProductionOutputPreviewQuantities } from "./production-output-preview-quantities";

describe("mapProductionOutputPreviewQuantities", () => {
  it("maps all-loose singles to quantity_loose=0", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 10,
      displaysProduced: 0,
      casesProduced: 0,
      looseCards: 10,
      displaysPerCase: null,
    });
    expect(mapped.quantity_good).toBe(10);
    expect(mapped.quantity_loose).toBe(0);
    expect(mapped.unit_assembly_quantity).toBe(10);
  });

  it("preserves partial loose when mixed with displays but no cases", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 100,
      displaysProduced: 8,
      casesProduced: 0,
      looseCards: 4,
      displaysPerCase: 20,
    });
    expect(mapped.quantity_good).toBe(100);
    expect(mapped.quantity_loose).toBe(4);
    // No cases, so display_assembly_quantity = loose displays only
    expect(mapped.display_assembly_quantity).toBe(8);
  });

  it("never uses loose_cards as extra output beyond units_produced", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 50,
      displaysProduced: 2,
      casesProduced: 1,
      looseCards: 6,
      displaysPerCase: null,
    });
    expect(mapped.quantity_good).toBe(50);
    expect(mapped.quantity_loose).toBe(6);
    expect(mapped.case_assembly_quantity).toBe(1);
  });

  // Lot 1890-29: 9 cases × 25 displays/case + 20 loose displays = 245 total displays
  // unit_assembly_quantity = 245 × 20 units/display + 6 loose = 4906 (already correct via unitsProduced)
  it("includes case-embedded displays in display_assembly_quantity (lot 1890-29 regression)", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 4906,
      displaysProduced: 20,
      casesProduced: 9,
      looseCards: 6,
      displaysPerCase: 25,
    });
    // display_assembly_quantity = 20 loose + 9 × 25 = 245
    expect(mapped.display_assembly_quantity).toBe(245);
    // unit and case quantities unchanged
    expect(mapped.unit_assembly_quantity).toBe(4906);
    expect(mapped.case_assembly_quantity).toBe(9);
    expect(mapped.quantity_good).toBe(4906);
    expect(mapped.quantity_loose).toBe(6);
  });

  it("display_assembly_quantity equals loose displays only when casesProduced is zero", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 400,
      displaysProduced: 20,
      casesProduced: 0,
      looseCards: 0,
      displaysPerCase: 25,
    });
    expect(mapped.display_assembly_quantity).toBe(20);
  });

  it("display_assembly_quantity equals loose displays only when displaysPerCase is null", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 400,
      displaysProduced: 20,
      casesProduced: 2,
      looseCards: 0,
      displaysPerCase: null,
    });
    // Falls back to loose-displays-only (old behavior) when displaysPerCase unavailable
    expect(mapped.display_assembly_quantity).toBe(20);
  });
});
