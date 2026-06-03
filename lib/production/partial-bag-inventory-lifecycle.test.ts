import { describe, expect, it } from "vitest";
import { deriveSafeSessionReturnEstimate } from "./partial-bag-inventory-lifecycle";

describe("deriveSafeSessionReturnEstimate", () => {
  it("refuses when only RAW_BAG_OPENED exists (no consumption evidence)", () => {
    const r = deriveSafeSessionReturnEstimate([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/manual tablet consumption/i);
    }
  });

  it("never uses sealed-card-derived fabricated events", () => {
    const r = deriveSafeSessionReturnEstimate([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      {
        eventType: "RAW_BAG_PARTIAL_CONSUMED",
        quantity: 500,
        payload: { partial_packaging_derived: true },
      },
    ]);
    expect(r.ok).toBe(false);
  });

  it("returns remaining when manual consumption recorded", () => {
    const r = deriveSafeSessionReturnEstimate([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 3_000 },
    ]);
    expect(r).toEqual({
      ok: true,
      remainingQty: 17_000,
      source: "LEDGER_CONSUMED",
    });
  });

  it("prefers weigh-back when present", () => {
    const r = deriveSafeSessionReturnEstimate([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 3_000 },
      { eventType: "RAW_BAG_REWEIGHED", quantity: 16_500 },
    ]);
    expect(r).toEqual({
      ok: true,
      remainingQty: 16_500,
      source: "LEDGER_REWEIGH",
    });
  });

  it("returns false when ledger shows zero remaining", () => {
    const r = deriveSafeSessionReturnEstimate([
      { eventType: "RAW_BAG_OPENED", quantity: 1_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 1_000 },
    ]);
    expect(r.ok).toBe(false);
  });
});
