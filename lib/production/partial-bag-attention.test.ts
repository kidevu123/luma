import { describe, it, expect } from "vitest";
import { derivePartialBagAttention } from "./partial-bag-attention";

describe("derivePartialBagAttention — flag only confusing held partials", () => {
  it("never flags a card that is not a held partial", () => {
    expect(
      derivePartialBagAttention({
        isHeldPartial: false,
        systemRemainingQty: null,
        operatorRemainingEstimate: null,
      }),
    ).toEqual({ needsReview: false, reason: null });
  });

  it("does NOT flag a healthy held partial (known remaining, no big disagreement)", () => {
    expect(
      derivePartialBagAttention({
        isHeldPartial: true,
        systemRemainingQty: 4200,
        operatorRemainingEstimate: 4000,
      }).needsReview,
    ).toBe(false);
  });

  it("flags a held partial with UNKNOWN system remaining", () => {
    const a = derivePartialBagAttention({
      isHeldPartial: true,
      systemRemainingQty: null,
      operatorRemainingEstimate: 4200,
    });
    expect(a.needsReview).toBe(true);
    expect(a.reason).toMatch(/unconfirmed/i);
  });

  it("flags when operator estimate differs materially from system remaining", () => {
    // diff 4000 vs 1000 = 3000 (>=100 and >=25% of 4000)
    const a = derivePartialBagAttention({
      isHeldPartial: true,
      systemRemainingQty: 4000,
      operatorRemainingEstimate: 1000,
    });
    expect(a.needsReview).toBe(true);
    expect(a.reason).toMatch(/differs/i);
  });

  it("does NOT flag small/ rounding-level disagreements (avoids over-alarming)", () => {
    // 4000 vs 3950 → diff 50 (< 100 absolute) → fine
    expect(
      derivePartialBagAttention({
        isHeldPartial: true,
        systemRemainingQty: 4000,
        operatorRemainingEstimate: 3950,
      }).needsReview,
    ).toBe(false);
    // 10000 vs 9000 → diff 1000 (>=100) but only 10% (< 25%) → fine
    expect(
      derivePartialBagAttention({
        isHeldPartial: true,
        systemRemainingQty: 10000,
        operatorRemainingEstimate: 9000,
      }).needsReview,
    ).toBe(false);
  });

  it("does not flag a held partial with known remaining and no operator estimate", () => {
    expect(
      derivePartialBagAttention({
        isHeldPartial: true,
        systemRemainingQty: 4200,
        operatorRemainingEstimate: null,
      }).needsReview,
    ).toBe(false);
  });
});
