// DYNAMIC-BOM-DERIVATION-v1.4.4 — pure derivation tests.

import { describe, expect, it } from "vitest";
import { deriveNormalizedBomQuantitiesFromRows } from "./derive-normalized-bom-quantities";

// BlueRaz fixture mirrors the real product setup data (verified via
// psql on production at investigation time). Constants live here in
// the test so the implementation stays SKU- and ID-agnostic. The
// real hard-coding is in the DB, not in the source.
const BLUERAZ = {
  productId: "e7546d43-d126-43b0-996a-5b15082ff0a8",
  tabletsPerUnit: 4,
  primaryTabletTypeId: "79b1010f-5d38-4f19-8fe4-263aa458ffa5",
  primaryTabletName: "Hyroxi Mit A - BlueRaz",
  primaryRawItemId: "5254962000002266128",
  secondaryTabletTypeId: "a6c7bd53-9c8d-4f94-88b4-95828eafb700",
  secondaryTabletName: "FIX MIT - Blue Razz",
  secondaryRawItemId: "5254962000004758398",
} as const;

describe("deriveNormalizedBomQuantitiesFromRows — BlueRaz fixture", () => {
  it("derives { primary: tabletsPerUnit } from product data", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: {
        id: BLUERAZ.productId,
        tabletsPerUnit: BLUERAZ.tabletsPerUnit,
      },
      allowedTablets: [
        {
          tabletTypeId: BLUERAZ.primaryTabletTypeId,
          tabletTypeName: BLUERAZ.primaryTabletName,
          zohoItemId: BLUERAZ.primaryRawItemId,
          isPrimary: true,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalizedBomQuantities).toEqual({
      [BLUERAZ.primaryRawItemId]: BLUERAZ.tabletsPerUnit,
    });
    // batchTrackedItemIds mirrors keys so callers can pass it as a Set.
    expect(r.batchTrackedItemIds.has(BLUERAZ.primaryRawItemId)).toBe(true);
    expect(r.batchTrackedItemIds.size).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("includes secondary allowed tablets too when they have Zoho item IDs (both primary AND non-primary mapped)", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: {
        id: BLUERAZ.productId,
        tabletsPerUnit: BLUERAZ.tabletsPerUnit,
      },
      allowedTablets: [
        {
          tabletTypeId: BLUERAZ.primaryTabletTypeId,
          tabletTypeName: BLUERAZ.primaryTabletName,
          zohoItemId: BLUERAZ.primaryRawItemId,
          isPrimary: true,
        },
        {
          tabletTypeId: BLUERAZ.secondaryTabletTypeId,
          tabletTypeName: BLUERAZ.secondaryTabletName,
          zohoItemId: BLUERAZ.secondaryRawItemId,
          isPrimary: false,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalizedBomQuantities).toEqual({
      [BLUERAZ.primaryRawItemId]: BLUERAZ.tabletsPerUnit,
      [BLUERAZ.secondaryRawItemId]: BLUERAZ.tabletsPerUnit,
    });
    expect(r.batchTrackedItemIds.size).toBe(2);
  });
});

describe("deriveNormalizedBomQuantitiesFromRows — specific blockers (not generic BOM_QUANTITY_PENDING)", () => {
  it("MISSING_TABLETS_PER_UNIT when products.tablets_per_unit is null", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: { id: "p-1", tabletsPerUnit: null },
      allowedTablets: [
        {
          tabletTypeId: "t-1",
          tabletTypeName: "Some Tablet",
          zohoItemId: "zoho-1",
          isPrimary: true,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers).toContainEqual(
      expect.objectContaining({
        code: "MISSING_TABLETS_PER_UNIT",
        field: "products.tablets_per_unit",
      }),
    );
  });

  it("MISSING_TABLETS_PER_UNIT when products.tablets_per_unit <= 0", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: { id: "p-1", tabletsPerUnit: 0 },
      allowedTablets: [
        {
          tabletTypeId: "t-1",
          tabletTypeName: "x",
          zohoItemId: "zoho-1",
          isPrimary: true,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers[0]?.code).toBe("MISSING_TABLETS_PER_UNIT");
  });

  it("MISSING_ALLOWED_TABLETS when product_allowed_tablets has no rows", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: { id: "p-1", tabletsPerUnit: 4 },
      allowedTablets: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers).toContainEqual(
      expect.objectContaining({
        code: "MISSING_ALLOWED_TABLETS",
        field: "product_allowed_tablets",
      }),
    );
  });

  it("MISSING_TABLET_ZOHO_ITEM_ID when every allowed tablet has null zoho_item_id", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: { id: "p-1", tabletsPerUnit: 4 },
      allowedTablets: [
        {
          tabletTypeId: "t-1",
          tabletTypeName: "Untagged Tablet A",
          zohoItemId: null,
          isPrimary: true,
        },
        {
          tabletTypeId: "t-2",
          tabletTypeName: "Untagged Tablet B",
          zohoItemId: "",
          isPrimary: false,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers).toContainEqual(
      expect.objectContaining({
        code: "MISSING_TABLET_ZOHO_ITEM_ID",
        field: "tablet_types.zoho_item_id",
      }),
    );
    // Message names the offending tablet types.
    expect(r.blockers[0]?.message).toMatch(/Untagged Tablet A/);
    expect(r.blockers[0]?.message).toMatch(/Untagged Tablet B/);
  });

  it("multiple missing-setup conditions reported together", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: { id: "p-1", tabletsPerUnit: null },
      allowedTablets: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.blockers.map((b) => b.code);
    expect(codes).toContain("MISSING_TABLETS_PER_UNIT");
    expect(codes).toContain("MISSING_ALLOWED_TABLETS");
  });
});

describe("deriveNormalizedBomQuantitiesFromRows — partial Zoho coverage", () => {
  it("includes tablets with Zoho IDs and warns about the ones without", () => {
    const r = deriveNormalizedBomQuantitiesFromRows({
      product: { id: "p-1", tabletsPerUnit: 5 },
      allowedTablets: [
        {
          tabletTypeId: "t-1",
          tabletTypeName: "Has-ID Tablet",
          zohoItemId: "zoho-A",
          isPrimary: true,
        },
        {
          tabletTypeId: "t-2",
          tabletTypeName: "No-ID Tablet",
          zohoItemId: null,
          isPrimary: false,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalizedBomQuantities).toEqual({ "zoho-A": 5 });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]?.code).toBe("ALLOWED_TABLET_WITHOUT_ZOHO_ITEM_ID");
    expect(r.warnings[0]?.message).toMatch(/No-ID Tablet/);
  });
});
