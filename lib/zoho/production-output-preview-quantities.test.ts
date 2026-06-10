import { describe, expect, it } from "vitest";
import { mapProductionOutputPreviewQuantities } from "./production-output-preview-quantities";

describe("mapProductionOutputPreviewQuantities", () => {
  it("maps all-loose singles to quantity_loose=0", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 10,
      displaysProduced: 0,
      casesProduced: 0,
      looseCards: 10,
    });
    expect(mapped.quantity_good).toBe(10);
    expect(mapped.quantity_loose).toBe(0);
    expect(mapped.unit_assembly_quantity).toBe(10);
  });

  it("preserves partial loose when mixed with displays", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 100,
      displaysProduced: 8,
      casesProduced: 0,
      looseCards: 4,
    });
    expect(mapped.quantity_good).toBe(100);
    expect(mapped.quantity_loose).toBe(4);
    expect(mapped.display_assembly_quantity).toBe(8);
  });

  it("never uses loose_cards as extra output beyond units_produced", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 50,
      displaysProduced: 2,
      casesProduced: 1,
      looseCards: 6,
    });
    expect(mapped.quantity_good).toBe(50);
    expect(mapped.quantity_loose).toBe(6);
    expect(mapped.case_assembly_quantity).toBe(1);
  });
});
