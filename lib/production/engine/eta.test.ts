import { describe, it, expect } from "vitest";
import { medianCycleMinutes, etaMinutes } from "./eta";

describe("medianCycleMinutes", () => {
  it("returns the median of enough samples", () => {
    expect(medianCycleMinutes([10, 4, 6, 8, 12])).toBe(8);
  });
  it("averages the middle pair for even counts", () => {
    expect(medianCycleMinutes([4, 6, 8, 10, 12, 14])).toBe(9);
  });
  it("refuses to guess from fewer than five samples", () => {
    expect(medianCycleMinutes([5, 5, 5, 5])).toBeNull();
    expect(medianCycleMinutes([])).toBeNull();
  });
  it("does not mutate the caller's array", () => {
    const samples = [10, 4, 6, 8, 12];
    medianCycleMinutes(samples);
    expect(samples).toEqual([10, 4, 6, 8, 12]);
  });
});

describe("etaMinutes", () => {
  const now = new Date("2026-08-12T12:10:00Z");
  it("subtracts elapsed upstream time from the median", () => {
    expect(
      etaMinutes({ medianMinutes: 14, upstreamStartedAt: new Date("2026-08-12T12:00:00Z"), now }),
    ).toBe(4);
  });
  it("clamps at zero when the median is already exceeded", () => {
    expect(
      etaMinutes({ medianMinutes: 5, upstreamStartedAt: new Date("2026-08-12T12:00:00Z"), now }),
    ).toBe(0);
  });
  it("returns null when either input is missing", () => {
    expect(etaMinutes({ medianMinutes: null, upstreamStartedAt: new Date(), now })).toBeNull();
    expect(etaMinutes({ medianMinutes: 10, upstreamStartedAt: null, now })).toBeNull();
  });
  it("takes now as a parameter — never reads the clock itself", () => {
    // Same inputs, two different clocks, two different answers. A
    // Date.now() inside would make this pair equal.
    const early = etaMinutes({
      medianMinutes: 30,
      upstreamStartedAt: new Date("2026-08-12T12:00:00Z"),
      now: new Date("2026-08-12T12:05:00Z"),
    });
    const late = etaMinutes({
      medianMinutes: 30,
      upstreamStartedAt: new Date("2026-08-12T12:00:00Z"),
      now: new Date("2026-08-12T12:25:00Z"),
    });
    expect(early).toBe(25);
    expect(late).toBe(5);
  });
});
