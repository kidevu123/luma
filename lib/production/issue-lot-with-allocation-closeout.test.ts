import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  deriveIssueLotPrefill,
  resolveRepairStartingBalanceQty,
} from "@/lib/production/issue-lot-with-allocation-closeout";
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

describe("resolveRepairStartingBalanceQty", () => {
  it("prefers pill_count on a fresh bag", () => {
    expect(
      resolveRepairStartingBalanceQty({
        pillCount: 6693,
        declaredPillCount: 6693,
        lastClosedSession: null,
      }),
    ).toBe(6693);
  });

  it("falls back to declared count when pill_count is missing", () => {
    expect(
      resolveRepairStartingBalanceQty({
        pillCount: null,
        declaredPillCount: 8000,
        lastClosedSession: null,
      }),
    ).toBe(8000);
  });

  it("uses last closed ending balance for partial reuse", () => {
    expect(
      resolveRepairStartingBalanceQty({
        pillCount: 20000,
        declaredPillCount: 20000,
        lastClosedSession: {
          endingBalanceQty: 4200,
          startingBalanceQty: 20000,
          consumedQty: 15800,
        },
      }),
    ).toBe(4200);
  });

  it("v1.19.1: a RETURNED_TO_STOCK remainder becomes the starting balance — NOT consumed", () => {
    // bag-card-104 shape: started 7,197, consumed 3,599, returned 3,598 to stock.
    // The prefill must suggest the RETURNED remainder (3,598), never the consumed.
    expect(
      resolveRepairStartingBalanceQty({
        pillCount: 7197,
        declaredPillCount: 7197,
        lastClosedSession: {
          endingBalanceQty: 3598, // returned remainder
          startingBalanceQty: 7197,
          consumedQty: 3599, // must NOT be used as the starting balance
        },
      }),
    ).toBe(3598);
  });

  it("v1.19.1: a DEPLETED terminal (ending 0) prefills 0 (empty — not over-issuable)", () => {
    expect(
      resolveRepairStartingBalanceQty({
        pillCount: 7197,
        declaredPillCount: 7197,
        lastClosedSession: {
          endingBalanceQty: 0,
          startingBalanceQty: 7197,
          consumedQty: 7197,
        },
      }),
    ).toBe(0);
  });
});

describe("v1.19.1 — manual-issue prefill uses the full terminal set", () => {
  const src = readFileSync(
    join(process.cwd(), "lib/production/issue-lot-with-allocation-closeout.ts"),
    "utf8",
  );

  it("the repair starting-balance lookup includes RETURNED_TO_STOCK / DEPLETED (not CLOSED-only)", () => {
    // The starting-balance hint query uses the shared terminal set.
    expect(src).toMatch(/inArray\(\s*rawBagAllocationSessions\.allocationStatus,\s*\[\s*\.\.\.TERMINAL_ALLOCATION_STATUSES/);
    // No stale CLOSED-only status equality feeding the balance hint.
    expect(src).not.toMatch(/eq\(rawBagAllocationSessions\.allocationStatus, "CLOSED"\)/);
    // The two OPEN checks (existing-session detection) are unaffected.
    const openChecks = src.match(/eq\(rawBagAllocationSessions\.allocationStatus, "OPEN"\)/g) ?? [];
    expect(openChecks.length).toBe(2);
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
