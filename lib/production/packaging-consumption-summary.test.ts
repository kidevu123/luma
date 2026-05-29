import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildPackagingConsumptionPayloadSummary } from "./packaging-consumption-summary";

describe("buildPackagingConsumptionPayloadSummary", () => {
  it("maps consumption result into additive payload keys", () => {
    const summary = buildPackagingConsumptionPayloadSummary({
      productId: "prod-1",
      bomStatus: "PARTIAL",
      totalUnits: 100,
      totalDisplays: 5,
      totalCases: 1,
      materials: [
        {
          packagingMaterialId: "mat-1",
          materialName: "Case",
          materialKind: "CASE",
          perScope: "CASE",
          qtyConsumed: 10,
          qtyActual: 3,
          qtyEstimated: 7,
          status: "PARTIAL",
          lotId: "lot-1",
        },
      ],
    });

    expect(summary).toEqual({
      packaging_consumption_bom_status: "PARTIAL",
      packaging_consumption_summary: {
        total_units: 100,
        total_displays: 5,
        total_cases: 1,
        materials: [
          {
            packaging_material_id: "mat-1",
            material_name: "Case",
            material_kind: "CASE",
            per_scope: "CASE",
            qty_consumed: 10,
            qty_actual: 3,
            qty_estimated: 7,
            status: "PARTIAL",
            lot_id: "lot-1",
          },
        ],
      },
    });
  });
});

describe("material-lot-state honesty", () => {
  const lotStateSrc = readFileSync(
    join(import.meta.dirname, "../projector/material-lot-state.ts"),
    "utf8",
  );

  it("does not clamp count-based current_qty to zero", () => {
    expect(lotStateSrc).toMatch(/PACKAGING-PENDING-CONSUMPTION-HONESTY-1/);
    const countBlock = lotStateSrc.slice(
      lotStateSrc.indexOf("Count lots: qty_on_hand"),
      lotStateSrc.indexOf("END AS current_qty"),
    );
    expect(countBlock).not.toMatch(/GREATEST\(0,/);
  });

  it("still clamps roll weight to zero", () => {
    expect(lotStateSrc).toMatch(
      /WHEN pm\.kind::text IN \('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL'\) AND pl\.net_weight_grams IS NOT NULL[\s\S]*GREATEST\(0,/,
    );
  });
});
