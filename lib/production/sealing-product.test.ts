import { describe, it, expect } from "vitest";
import {
  filterSealingProductsByTabletType,
  getUnmappedProductBanner,
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

describe("getUnmappedProductBanner", () => {
  it("SEALING shows save-product-first copy, not legacy warning", () => {
    const banner = getUnmappedProductBanner("SEALING");
    expect(banner.title).toMatch(/Step 1: Save product/);
    expect(banner.detail).toMatch(/locks product identity for the bag/);
    expect(banner.detail).not.toMatch(/started before the first-op product picker/);
  });

  it("COMBINED at sealing uses save-product-first copy", () => {
    const banner = getUnmappedProductBanner("COMBINED");
    expect(banner.title).toMatch(/Step 1: Save product/);
    expect(banner.detail).toMatch(/locks product identity for the bag/);
  });

  it("HANDPACK_BLISTER defers to sealing without legacy warning", () => {
    const banner = getUnmappedProductBanner("HANDPACK_BLISTER");
    expect(banner.detail).toMatch(/chosen at sealing/);
    expect(banner.detail).not.toMatch(/started before the first-op product picker/);
  });

  it("PACKAGING points back to sealing", () => {
    const banner = getUnmappedProductBanner("PACKAGING");
    expect(banner.detail).toMatch(/Select finished product at sealing/);
  });

  it("unknown station keeps legacy copy", () => {
    const banner = getUnmappedProductBanner("BOTTLE_HANDPACK");
    expect(banner.detail).toMatch(/started before the first-op product picker/);
  });
});
