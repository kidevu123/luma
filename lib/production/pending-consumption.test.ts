import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { pendingConsumptionLabel } from "./pending-consumption";

describe("pendingConsumptionLabel", () => {
  it("returns Needs receipt when pending qty > 0 and net is non-negative", () => {
    expect(pendingConsumptionLabel({ pendingQty: 10, netBalance: 0 })).toBe(
      "Needs receipt",
    );
  });

  it("returns Negative balance when net < 0 and no pending", () => {
    expect(pendingConsumptionLabel({ pendingQty: 0, netBalance: -5 })).toBe(
      "Negative balance",
    );
  });

  it("returns Negative balance when both pending and net negative", () => {
    expect(pendingConsumptionLabel({ pendingQty: 10, netBalance: -3 })).toBe(
      "Negative balance",
    );
  });

  it("returns null when balanced with no pending", () => {
    expect(pendingConsumptionLabel({ pendingQty: 0, netBalance: 50 })).toBeNull();
  });
});

describe("pending-consumption queries source", () => {
  const src = readFileSync(join(import.meta.dirname, "pending-consumption.ts"), "utf8");

  it("queries null-lot MATERIAL_CONSUMED_ESTIMATED events", () => {
    expect(src).toMatch(/packaging_lot_id IS NULL/);
    expect(src).toMatch(/MATERIAL_CONSUMED_ESTIMATED/);
  });

  it("surfaces insufficient_on_hand and no_lot_reason from payload", () => {
    expect(src).toMatch(/insufficient_on_hand/);
    expect(src).toMatch(/no_lot_reason/);
  });

  it("material balance includes on hand, pending, and net balance", () => {
    expect(src).toMatch(/on_hand_qty/);
    expect(src).toMatch(/pending_qty/);
    expect(src).toMatch(/net_balance/);
  });
});
