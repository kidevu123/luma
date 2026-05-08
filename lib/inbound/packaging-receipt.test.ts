import { describe, it, expect } from "vitest";
import {
  computeAcceptance,
  describeAcceptance,
  classifyVarianceSeverity,
} from "./packaging-receipt";

describe("PT-2: computeAcceptance — confidence rule", () => {
  it("HIGH when counted_quantity is provided", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: 1000 });
    expect(r.confidence).toBe("HIGH");
    expect(r.acceptedQuantity).toBe(1000);
    expect(r.hasVariance).toBe(false);
    expect(r.variance).toBe(0);
  });

  it("HIGH when only counted_quantity is provided (declared null)", () => {
    const r = computeAcceptance({ declaredQuantity: null, countedQuantity: 980 });
    expect(r.confidence).toBe("HIGH");
    expect(r.acceptedQuantity).toBe(980);
    expect(r.hasVariance).toBe(false);
    expect(r.variance).toBeNull();
  });

  it("MEDIUM when only declared_quantity is provided", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: null });
    expect(r.confidence).toBe("MEDIUM");
    expect(r.acceptedQuantity).toBe(1000);
    expect(r.hasVariance).toBe(false);
  });

  it("MISSING when both are null", () => {
    const r = computeAcceptance({
      declaredQuantity: null,
      countedQuantity: null,
    });
    expect(r.confidence).toBe("MISSING");
    expect(r.acceptedQuantity).toBeNull();
  });

  it("LOW when source = IMPORT, regardless of which fields are populated", () => {
    const r1 = computeAcceptance({
      declaredQuantity: 1000,
      countedQuantity: 1000,
      source: "IMPORT",
    });
    expect(r1.confidence).toBe("LOW");
    expect(r1.acceptedQuantity).toBe(1000);

    const r2 = computeAcceptance({
      declaredQuantity: 500,
      countedQuantity: null,
      source: "IMPORT",
    });
    expect(r2.confidence).toBe("LOW");
  });
});

describe("PT-2: variance handling — receipt variance is NOT loss", () => {
  it("flags variance when counted differs from declared", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: 950 });
    expect(r.acceptedQuantity).toBe(950);
    expect(r.hasVariance).toBe(true);
    expect(r.variance).toBe(-50);
    expect(r.confidence).toBe("HIGH"); // counted = HIGH even with variance
  });

  it("does NOT flag variance when counted equals declared", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: 1000 });
    expect(r.hasVariance).toBe(false);
    expect(r.variance).toBe(0);
  });

  it("does NOT flag variance when only one of the two is present", () => {
    expect(
      computeAcceptance({ declaredQuantity: 1000, countedQuantity: null })
        .hasVariance,
    ).toBe(false);
    expect(
      computeAcceptance({ declaredQuantity: null, countedQuantity: 1000 })
        .hasVariance,
    ).toBe(false);
  });

  it("never overwrites declared with counted silently — both are preserved separately", () => {
    // The function returns acceptedQuantity but the caller is
    // expected to persist declared + counted separately on the lot.
    // This regression test pins that we don't fold them.
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: 950 });
    expect(r.acceptedQuantity).toBe(950);
    expect(r.variance).toBe(-50);
    expect(r.acceptedQuantity).not.toBe(1000);
  });
});

describe("PT-2: describeAcceptance — operator-readable label", () => {
  it("counted no variance", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: 1000 });
    expect(describeAcceptance(r)).toContain("Physically counted (1000)");
  });
  it("counted with variance flags the off-by", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: 950 });
    expect(describeAcceptance(r)).toMatch(/counted \(950\).*off by/);
  });
  it("declared only", () => {
    const r = computeAcceptance({ declaredQuantity: 1000, countedQuantity: null });
    expect(describeAcceptance(r)).toMatch(/Supplier-declared only/);
  });
  it("imported", () => {
    const r = computeAcceptance({
      declaredQuantity: 1000,
      countedQuantity: null,
      source: "IMPORT",
    });
    expect(describeAcceptance(r)).toMatch(/Imported low confidence/);
  });
  it("missing", () => {
    const r = computeAcceptance({
      declaredQuantity: null,
      countedQuantity: null,
    });
    expect(describeAcceptance(r)).toMatch(/No usable quantity/);
  });
});

describe("PT-2: classifyVarianceSeverity", () => {
  it("≤ 1% → LOW", () => {
    expect(classifyVarianceSeverity({ variance: 5, declared: 1000 })).toBe("LOW");
  });
  it("≤ 5% → MEDIUM", () => {
    expect(classifyVarianceSeverity({ variance: 30, declared: 1000 })).toBe("MEDIUM");
  });
  it("> 5% → HIGH", () => {
    expect(classifyVarianceSeverity({ variance: 100, declared: 1000 })).toBe("HIGH");
  });
  it("declared = 0 → HIGH (cannot compute pct)", () => {
    expect(classifyVarianceSeverity({ variance: 5, declared: 0 })).toBe("HIGH");
  });
  it("negative variance is treated as absolute", () => {
    expect(classifyVarianceSeverity({ variance: -100, declared: 1000 })).toBe("HIGH");
  });
});
