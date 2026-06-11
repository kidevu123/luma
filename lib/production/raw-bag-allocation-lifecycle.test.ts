import { describe, expect, it } from "vitest";
import {
  checkOverAllocation,
  resolveReopenStartingBalance,
} from "@/lib/production/bag-allocation";
import { computeEndingBalanceFromConsumption } from "@/lib/production/expected-tablet-consumption";

describe("raw-bag allocation lifecycle math", () => {
  it("ending balance 5000 starting with 4002 consumed => 998", () => {
    expect(computeEndingBalanceFromConsumption(5000, 4002)).toBe(998);
  });

  it("ending balance 4002 starting with 4002 consumed => 0", () => {
    expect(computeEndingBalanceFromConsumption(4002, 4002)).toBe(0);
  });

  it("blocks consumed greater than starting balance", () => {
    expect(checkOverAllocation(5001, 5000)).toMatch(/exceeds session starting/i);
  });

  it("reopen starting balance prefers last closed ending balance", () => {
    expect(
      resolveReopenStartingBalance(
        {
          endingBalanceQty: 998,
          startingBalanceQty: 5000,
          consumedQty: 4002,
        },
        9999,
      ),
    ).toBe(998);
  });
});
