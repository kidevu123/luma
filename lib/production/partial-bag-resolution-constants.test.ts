import { describe, it, expect } from "vitest";
import {
  formatRemainingEstimate,
  formatOperatorRemainingEstimate,
} from "./partial-bag-resolution-constants";

describe("formatRemainingEstimate — operator-estimate honesty", () => {
  it("labels an OPERATOR_ESTIMATE source explicitly (never a bare number)", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: 4200,
        confidence: "MEDIUM",
        source: "OPERATOR_ESTIMATE",
      }),
    ).toBe("~4,200 (operator estimate)");
  });

  it("still renders a HIGH-confidence counted value as a plain number", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: 4200,
        confidence: "HIGH",
        source: "PHYSICAL_COUNT",
      }),
    ).toBe("4,200");
  });

  it("unknown remaining requires closeout", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: null,
        confidence: null,
        source: null,
      }),
    ).toBe("Unknown — closeout required");
  });

  it("SPLIT-BAG-1: OUTPUT_DERIVED is labelled system-derived even at HIGH confidence (never a bare count)", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: 8000,
        confidence: "HIGH",
        source: "OUTPUT_DERIVED",
      }),
    ).toBe("~8,000 (system-derived from production)");
  });
});

describe("formatOperatorRemainingEstimate", () => {
  it("renders the operator estimate as an explicit, non-authoritative value", () => {
    expect(formatOperatorRemainingEstimate(4200)).toBe(
      "~4,200 (operator estimate)",
    );
  });
  it("returns null when there is no estimate", () => {
    expect(formatOperatorRemainingEstimate(null)).toBeNull();
    expect(formatOperatorRemainingEstimate(undefined)).toBeNull();
  });
});
