import { describe, expect, it } from "vitest";
import {
  computeEndingBalanceFromConsumption,
  computeExpectedTabletConsumptionFromProduct,
} from "./expected-tablet-consumption";

describe("computeExpectedTabletConsumptionFromProduct", () => {
  it("computes tabletsPerUnit=1 × unitsYielded", () => {
    expect(computeExpectedTabletConsumptionFromProduct(1, 4002)).toEqual({
      ok: true,
      expectedConsumed: 4002,
      tabletsPerUnit: 1,
      unitsProduced: 4002,
    });
  });

  it("computes tabletsPerUnit=2 × unitsYielded", () => {
    expect(computeExpectedTabletConsumptionFromProduct(2, 4002)).toEqual({
      ok: true,
      expectedConsumed: 8004,
      tabletsPerUnit: 2,
      unitsProduced: 4002,
    });
  });

  it("blocks when tabletsPerUnit is missing", () => {
    expect(computeExpectedTabletConsumptionFromProduct(null, 100)).toMatchObject({
      ok: false,
      blocker: "MISSING_TABLETS_PER_UNIT",
    });
  });

  it("blocks when output quantity is missing", () => {
    expect(computeExpectedTabletConsumptionFromProduct(1, 0)).toMatchObject({
      ok: false,
      blocker: "MISSING_OUTPUT_QUANTITY",
    });
  });
});

describe("computeEndingBalanceFromConsumption", () => {
  it("subtracts consumed from starting balance", () => {
    expect(computeEndingBalanceFromConsumption(5000, 4002)).toBe(998);
  });

  it("returns null when starting balance is unknown", () => {
    expect(computeEndingBalanceFromConsumption(null, 4002)).toBeNull();
  });
});
