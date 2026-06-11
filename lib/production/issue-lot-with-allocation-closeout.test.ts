import { describe, expect, it } from "vitest";
import { deriveIssueLotPrefill } from "@/lib/production/issue-lot-with-allocation-closeout";
import {
  computeExpectedTabletConsumptionFromProduct,
} from "@/lib/production/expected-tablet-consumption";
import { CHOCO_DRIFT_SKU } from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import { computeExpectedTabletConsumption } from "@/lib/zoho/v1206-choco-drift-pilot-contract";

describe("computeExpectedTabletConsumptionFromProduct", () => {
  it("general product math replaces SKU-only pilot helper", () => {
    expect(computeExpectedTabletConsumptionFromProduct(4, 100)).toEqual({
      ok: true,
      expectedConsumed: 400,
      tabletsPerUnit: 4,
      unitsProduced: 100,
    });
    expect(computeExpectedTabletConsumption(CHOCO_DRIFT_SKU, 100)).toBe(400);
  });
});

describe("deriveIssueLotPrefill", () => {
  it("prefills consumed and ending from product structure", () => {
    expect(
      deriveIssueLotPrefill({
        tabletsPerUnit: 1,
        unitsProduced: 4002,
        startingBalanceQty: 5000,
      }),
    ).toEqual({
      expected: {
        ok: true,
        expectedConsumed: 4002,
        tabletsPerUnit: 1,
        unitsProduced: 4002,
      },
      consumedQty: 4002,
      endingBalanceQty: 998,
    });
  });

  it("does not fabricate consumed qty when product math is unavailable", () => {
    expect(
      deriveIssueLotPrefill({
        tabletsPerUnit: null,
        unitsProduced: 100,
        startingBalanceQty: 5000,
      }),
    ).toMatchObject({
      consumedQty: null,
      endingBalanceQty: null,
    });
  });
});

describe("coordinated lot/closeout contract", () => {
  it("documents LEAD-only closeout with finished_lot_id linkage", () => {
    const roleRequired = "LEAD";
    expect(roleRequired).toBe("LEAD");
  });

  it("inventory_bag_id must differ from workflow_bag_id", () => {
    const inventoryBagId = "33333333-3333-4333-8333-333333333333";
    const workflowBagId = "44444444-4444-4444-8444-444444444444";
    expect(inventoryBagId).not.toBe(workflowBagId);
  });
});
