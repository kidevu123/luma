import { describe, it, expect } from "vitest";
import {
  filterSealingProductsByTabletType,
  validateSealingProductPick,
} from "./sealing-product";

const ACTIVE_CARD = {
  id: "p-card",
  sku: "QA_TEST_CARD_A",
  name: "Card A",
  kind: "CARD",
  isActive: true,
};

describe("validateSealingProductPick", () => {
  it("requires pickedProductId when mapping at sealing", () => {
    const r = validateSealingProductPick({
      stationKind: "SEALING",
      pickedProductId: null,
      product: null,
      tabletTypeId: "tt-1",
      allowedTabletTypeIds: ["tt-1"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Select the finished product/);
  });

  it("accepts compatible CARD product at SEALING", () => {
    const r = validateSealingProductPick({
      stationKind: "SEALING",
      pickedProductId: ACTIVE_CARD.id,
      product: ACTIVE_CARD,
      tabletTypeId: "tt-1",
      allowedTabletTypeIds: ["tt-1"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_CARD.id);
  });

  it("rejects product not configured for bag tablet type", () => {
    const r = validateSealingProductPick({
      stationKind: "SEALING",
      pickedProductId: ACTIVE_CARD.id,
      product: ACTIVE_CARD,
      tabletTypeId: "tt-other",
      allowedTabletTypeIds: ["tt-1"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tablet type/);
  });
});

describe("filterSealingProductsByTabletType", () => {
  const products = [
    { id: "a", allowedTabletTypeIds: ["tt-1"] },
    { id: "b", allowedTabletTypeIds: ["tt-2"] },
  ];

  it("returns all products when tablet type unknown", () => {
    expect(filterSealingProductsByTabletType(products, null)).toHaveLength(2);
  });

  it("filters to matching tablet type", () => {
    const filtered = filterSealingProductsByTabletType(products, "tt-1");
    expect(filtered.map((p) => p.id)).toEqual(["a"]);
  });
});
