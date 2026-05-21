import { describe, it, expect } from "vitest";
import { resolveFinishedLotTabletQty } from "./finished-lots";

describe("resolveFinishedLotTabletQty", () => {
  it("returns consumedQty from a closed allocation session", () => {
    expect(
      resolveFinishedLotTabletQty(null, { consumedQty: 3000 }, 10000),
    ).toBe(3000);
  });

  it("returns consumedQty even when it is zero (full depletion recorded)", () => {
    expect(
      resolveFinishedLotTabletQty(null, { consumedQty: 0 }, 10000),
    ).toBe(0);
  });

  it("falls back to pillCount when no allocation session exists (legacy path)", () => {
    expect(
      resolveFinishedLotTabletQty(null, null, 10000),
    ).toBe(10000);
  });

  it("falls back to pillCount when session exists but consumedQty is null", () => {
    expect(
      resolveFinishedLotTabletQty(null, { consumedQty: null }, 10000),
    ).toBe(10000);
  });

  it("falls back to 0 when no session and no pillCount", () => {
    expect(
      resolveFinishedLotTabletQty(null, null, null),
    ).toBe(0);
  });

  it("throws when an OPEN allocation session exists", () => {
    expect(() =>
      resolveFinishedLotTabletQty({ id: "sess-open-1" }, null, 10000),
    ).toThrow("open allocation session");
  });

  it("throws on OPEN session even when a closed session also exists", () => {
    expect(() =>
      resolveFinishedLotTabletQty({ id: "sess-open-1" }, { consumedQty: 3000 }, 10000),
    ).toThrow("open allocation session");
  });
});
