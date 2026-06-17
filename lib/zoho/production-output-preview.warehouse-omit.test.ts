// WAREHOUSE-CAPABILITY-v1.4.0 — payload shape tests focused on the
// warehouse_id key absence/presence contract.

import { describe, expect, it } from "vitest";
import {
  buildProductionOutputPreviewPayload,
  type ProductionOutputPreviewBuildInput,
} from "./production-output-preview";

const BASE_INPUT: ProductionOutputPreviewBuildInput = {
  finishedLotId: "lot-1",
  workflowBagId: "bag-1",
  producedOn: "2026-05-28",
  unitsProduced: 100,
  displaysProduced: 0,
  casesProduced: 0,
  product: {
    zohoItemIdUnit: "unit-composite-1",
    zohoItemIdDisplay: null,
    zohoItemIdCase: null,
  },
  metrics: {
    damagedPackaging: 0,
    rippedCards: 0,
    looseCards: 0,
  },
  mapping: {
    purchaseorderId: "po-1",
    purchaseorderLineItemId: "line-1",
    warehouseId: "",
    notes: null,
  },
};

describe("buildProductionOutputPreviewPayload — warehouse_id key contract", () => {
  it("present (non-empty string) when warehouseId is supplied", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "WH-1" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.hasOwn(r.payload, "warehouse_id")).toBe(true);
    expect(r.payload.warehouse_id).toBe("WH-1");
  });

  it("ABSENT (no key in JSON) when warehouseId is empty AND allowWarehouseOmission=true", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "" },
      allowWarehouseOmission: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The whole point: key must not be present at all.
    expect(Object.hasOwn(r.payload, "warehouse_id")).toBe(false);
    expect((r.payload as Record<string, unknown>).warehouse_id).toBe(
      undefined,
    );
    // JSON serialization should not contain the key either.
    expect(JSON.stringify(r.payload)).not.toMatch(/"warehouse_id"/);
  });

  it("ABSENT after JSON round-trip when omitted (no null/undefined key snuck in)", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "" },
      allowWarehouseOmission: true,
    });
    if (!r.ok) throw new Error("expected ok");
    const round = JSON.parse(JSON.stringify(r.payload)) as Record<
      string,
      unknown
    >;
    expect("warehouse_id" in round).toBe(false);
  });

  it("blocks when warehouseId is empty AND allowWarehouseOmission is NOT set (v1.3 behavior preserved)", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "" },
      // allowWarehouseOmission not set
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers).toContainEqual({
      field: "warehouse_id",
      message:
        "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered.",
    });
  });

  it("blocks when warehouseId is empty AND allowWarehouseOmission=false (explicit)", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "" },
      allowWarehouseOmission: false,
    });
    expect(r.ok).toBe(false);
  });

  it("present when warehouseId is supplied even if allowWarehouseOmission=true (use-not-omit)", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "WH-RESOLVED" },
      allowWarehouseOmission: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.warehouse_id).toBe("WH-RESOLVED");
    expect(Object.hasOwn(r.payload, "warehouse_id")).toBe(true);
  });

  it("never sends null or empty string for warehouse_id", () => {
    const r = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "" },
      allowWarehouseOmission: true,
    });
    if (!r.ok) throw new Error("expected ok");
    const s = JSON.stringify(r.payload);
    expect(s).not.toMatch(/"warehouse_id"\s*:\s*null/);
    expect(s).not.toMatch(/"warehouse_id"\s*:\s*""/);
  });
});
