import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { execute: () => Promise.resolve([]), select: () => ({}) },
}));

vi.mock("@/lib/production/reconciliation-v2-loader", () => ({
  listReconciliationV2Rows: () => Promise.resolve([]),
}));

import {
  asConfidence,
  estimateActualLabel,
  loadPackagingInventoryPanel,
  loadProductPackagingRequirementsPanel,
  receiptTruthLabel,
  varianceSeverity,
} from "./material-panels";

describe("H.x7 material panel honesty helpers", () => {
  it("preserves PackTrack counted receipts as physically counted HIGH", () => {
    expect(
      receiptTruthLabel({
        confidence: "HIGH",
        countedQuantity: 98,
        declaredQuantity: 100,
        acceptedQuantity: 98,
      }),
    ).toBe("Physically counted");
  });

  it("preserves declared-only receipts as supplier-declared MEDIUM", () => {
    expect(
      receiptTruthLabel({
        confidence: "MEDIUM",
        countedQuantity: null,
        declaredQuantity: 100,
        acceptedQuantity: 100,
      }),
    ).toBe("Supplier-declared only");
  });

  it("marks imported or legacy receipts as LOW, not confirmed", () => {
    expect(
      receiptTruthLabel({
        confidence: "LOW",
        countedQuantity: null,
        declaredQuantity: 100,
        acceptedQuantity: 100,
      }),
    ).toBe("Legacy code only");
  });

  it("does not fake actual roll usage without a weigh-back", () => {
    expect(
      estimateActualLabel({
        actualUsedGrams: null,
        expectedUsedGrams: 120,
        blistersProduced: 2400,
      }),
    ).toBe("Estimated (configured standard)");
    expect(
      estimateActualLabel({
        actualUsedGrams: null,
        expectedUsedGrams: null,
        blistersProduced: 2400,
      }),
    ).toBe("Roll standard missing");
  });

  it("uses actual label only for actual usage/weigh-back rows", () => {
    expect(
      estimateActualLabel({
        actualUsedGrams: 118,
        expectedUsedGrams: 120,
        blistersProduced: 2400,
      }),
    ).toBe("Actual (weigh-back)");
  });

  it("uses bounded variance severity labels", () => {
    expect(varianceSeverity(null)).toBe("MISSING");
    expect(varianceSeverity(0)).toBe("NONE");
    expect(varianceSeverity(1)).toBe("LOW");
    expect(varianceSeverity(3)).toBe("MEDIUM");
    expect(varianceSeverity(8)).toBe("HIGH");
  });

  it("coerces unknown confidence to MISSING", () => {
    expect(asConfidence("HIGH")).toBe("HIGH");
    expect(asConfidence("NOPE")).toBe("MISSING");
  });
});

describe("H.x7 material panel loaders", () => {
  it("loads packaging inventory rows from real lot fields and preserves confidence labels", async () => {
    const calls: unknown[][] = [
      [
        {
          lot_id: "lot-1",
          material_name: "Foil Roll",
          material_kind: "FOIL_ROLL",
          material_sku: "FOIL-001",
          roll_number: "FR-1",
          box_number: null,
          supplier_lot_number: "SL-1",
          status: "AVAILABLE",
          qty_on_hand: 98,
          accepted_quantity: 98,
          declared_quantity: 100,
          counted_quantity: 98,
          uom: "each",
          net_weight_grams: null,
          current_weight_grams_estimate: null,
          supplier: "PackCo",
          location: "A1",
          source_system: "PACKTRACK",
          external_po_id: "PO-1",
          receipt_number: "R-1",
          received_at: "2026-05-09T00:00:00Z",
          confidence: "HIGH",
        },
      ],
      [{ status: "AVAILABLE", n: 1 }],
      [{ kind: "FOIL_ROLL", lots: 1, total_grams: null, total_units: 98 }],
    ];
    const tx = {
      execute: async () => calls.shift() ?? [],
    };

    const panel = await loadPackagingInventoryPanel(tx);
    expect(panel.lots).toHaveLength(1);
    expect(panel.lots[0]!.sourceSystem).toBe("PACKTRACK");
    expect(panel.lots[0]!.confidence).toBe("HIGH");
    expect(panel.lots[0]!.receiptTruthLabel).toBe("Physically counted");
  });

  it("returns Product packaging requirements missing for products without BOM rows", async () => {
    const tx = {
      execute: async () => [
        {
          product_id: "prod-1",
          product_name: "Sample Product",
          product_sku: "SKU-1",
          material_id: null,
          material_name: null,
          material_sku: null,
          material_kind: null,
          uom: null,
          per_scope: null,
          qty_needed: null,
          waste_allowance_pct: null,
        },
      ],
    };

    const panel = await loadProductPackagingRequirementsPanel(tx);
    expect(panel.products).toHaveLength(1);
    expect(panel.products[0]!.confidence).toBe("MISSING");
    expect(panel.products[0]!.missingInputs).toEqual(["product_packaging_specs"]);
    expect(panel.products[0]!.lines).toHaveLength(0);
  });

  it("does not contain banned variance-conflation language", () => {
    const renderedCopy = [
      "Receipt variance",
      "Cycle-count variance",
      "Consumption variance",
      "Supplier-declared only",
      "Physically counted",
      "Not weighed back",
    ].join(" ");
    expect(renderedCopy).not.toMatch(/production loss/i);
    expect(renderedCopy).not.toMatch(/supplier shortage|vendor shortage/i);
  });
});
