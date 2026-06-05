import { describe, expect, it } from "vitest";
import {
  buildAutoFinishedLotDraft,
  computePackagingUnitsProduced,
} from "./finished-lots";

describe("AUTO-FINISHED-LOT-RELEASE-1 · packaging draft builder", () => {
  it("uses the linked inventory receipt as finished lot and trace source", () => {
    const result = buildAutoFinishedLotDraft({
      productId: "product-1",
      unitsPerDisplay: 20,
      displaysPerCase: 20,
      defaultShelfLifeDays: 365,
      inventoryReceiptNumber: "352171",
      workflowReceiptNumber: "legacy-352171",
      packagedAt: new Date("2026-06-05T18:30:00.000Z"),
      counts: { masterCases: 2, displaysMade: 3, looseCards: 4 },
    });

    expect(result).toEqual({
      ok: true,
      finishedLotNumber: "352171",
      producedOn: "2026-06-05",
      expiryDate: "2027-06-05",
      expiresAt: new Date("2027-06-05T18:30:00.000Z"),
      unitsProduced: 864,
      displaysProduced: 3,
      casesProduced: 2,
    });
  });

  it("falls back to workflow_bags.receipt_number for legacy linked bags", () => {
    const result = buildAutoFinishedLotDraft({
      productId: "product-1",
      unitsPerDisplay: 10,
      displaysPerCase: 5,
      defaultShelfLifeDays: 90,
      inventoryReceiptNumber: null,
      workflowReceiptNumber: "legacy-receipt",
      packagedAt: new Date("2026-06-05T00:00:00.000Z"),
      counts: { masterCases: 1, displaysMade: 1, looseCards: 1 },
    });

    expect(result.ok && result.finishedLotNumber).toBe("legacy-receipt");
  });

  it("blocks instead of fabricating a lot number when no receipt is linked", () => {
    const result = buildAutoFinishedLotDraft({
      productId: "product-1",
      unitsPerDisplay: 20,
      displaysPerCase: 20,
      defaultShelfLifeDays: 365,
      inventoryReceiptNumber: null,
      workflowReceiptNumber: null,
      packagedAt: new Date("2026-06-05T18:30:00.000Z"),
      counts: { masterCases: 1, displaysMade: 0, looseCards: 0 },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "MISSING_RECEIPT_NUMBER",
    });
  });

  it("blocks when product shelf life is not configured", () => {
    const result = buildAutoFinishedLotDraft({
      productId: "product-1",
      unitsPerDisplay: 20,
      displaysPerCase: 20,
      defaultShelfLifeDays: null,
      inventoryReceiptNumber: "352171",
      workflowReceiptNumber: null,
      packagedAt: new Date("2026-06-05T18:30:00.000Z"),
      counts: { masterCases: 1, displaysMade: 0, looseCards: 0 },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "MISSING_SHELF_LIFE",
    });
  });

  it("computes finished units from cases, displays, and loose cards", () => {
    expect(
      computePackagingUnitsProduced(
        { masterCases: 5, displaysMade: 7, looseCards: 9 },
        { unitsPerDisplay: 12, displaysPerCase: 10 },
      ),
    ).toBe(693);
  });

  it("does not infer units when packaging structure is missing", () => {
    expect(
      computePackagingUnitsProduced(
        { masterCases: 5, displaysMade: 7, looseCards: 9 },
        { unitsPerDisplay: null, displaysPerCase: 10 },
      ),
    ).toBeNull();
  });
});
