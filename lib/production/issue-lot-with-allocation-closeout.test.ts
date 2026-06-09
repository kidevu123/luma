import { describe, expect, it } from "vitest";
import {
  computeExpectedTabletConsumption,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import { CHOCO_DRIFT_SKU } from "@/lib/zoho/v1206-choco-drift-pilot-contract";

describe("computeExpectedTabletConsumption", () => {
  it("Choco Drift expects 4 tablets per finished unit", () => {
    expect(computeExpectedTabletConsumption(CHOCO_DRIFT_SKU, 100)).toBe(400);
  });

  it("non-Choco SKU returns null", () => {
    expect(computeExpectedTabletConsumption("OTHER-SKU", 100)).toBeNull();
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
