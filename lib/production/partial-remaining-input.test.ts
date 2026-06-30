import { describe, it, expect } from "vitest";
import {
  coercePartialRemainingEstimate,
  PARTIAL_REMAINING_MAX,
} from "./partial-remaining-input";

describe("coercePartialRemainingEstimate — optional estimate never blocks close-out", () => {
  it("accepts a clean non-negative integer (string or number)", () => {
    expect(coercePartialRemainingEstimate("4200")).toBe(4200);
    expect(coercePartialRemainingEstimate(4200)).toBe(4200);
    expect(coercePartialRemainingEstimate("0")).toBe(0);
    expect(coercePartialRemainingEstimate(" 1200 ")).toBe(1200);
  });

  it("floors a fractional value instead of rejecting the whole submit", () => {
    // Previously '1.5' failed z.int() and rejected the entire packaging
    // close-out; now it floors to a usable estimate.
    expect(coercePartialRemainingEstimate("1.5")).toBe(1);
    expect(coercePartialRemainingEstimate("1e3")).toBe(1000);
  });

  it("DROPS (returns undefined) blank / invalid / negative / out-of-range input", () => {
    expect(coercePartialRemainingEstimate("")).toBeUndefined();
    expect(coercePartialRemainingEstimate("   ")).toBeUndefined();
    expect(coercePartialRemainingEstimate(null)).toBeUndefined();
    expect(coercePartialRemainingEstimate(undefined)).toBeUndefined();
    expect(coercePartialRemainingEstimate("abc")).toBeUndefined();
    expect(coercePartialRemainingEstimate("-5")).toBeUndefined();
    expect(coercePartialRemainingEstimate(-5)).toBeUndefined();
    expect(coercePartialRemainingEstimate(NaN)).toBeUndefined();
    expect(coercePartialRemainingEstimate(Infinity)).toBeUndefined();
    expect(
      coercePartialRemainingEstimate(PARTIAL_REMAINING_MAX + 1),
    ).toBeUndefined();
  });

  it("accepts the inclusive max boundary", () => {
    expect(coercePartialRemainingEstimate(PARTIAL_REMAINING_MAX)).toBe(
      PARTIAL_REMAINING_MAX,
    );
  });
});
