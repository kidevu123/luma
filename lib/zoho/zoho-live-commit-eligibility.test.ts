import { describe, expect, it } from "vitest";
import {
  evaluateLiveCommitEligibility,
  liveCommitEligibilityShortLabel,
  type LiveCommitEligibilityInput,
} from "./zoho-live-commit-eligibility";

const READY_PRODUCT: LiveCommitEligibilityInput["product"] = {
  isActive: true,
  zohoLiveCommitEnabled: true,
  zohoItemIdUnit: "ZU-1",
  zohoItemIdDisplay: "ZD-1",
  zohoItemIdCase: "ZC-1",
  unitsPerDisplay: 12,
  displaysPerCase: 4,
};

describe("evaluateLiveCommitEligibility — all four facets must pass", () => {
  it("returns eligible when product is active + flag on + readiness ready + no mapping blockers", () => {
    const r = evaluateLiveCommitEligibility({ product: READY_PRODUCT });
    expect(r.eligible).toBe(true);
  });

  it("blocks when zohoLiveCommitEnabled = false even if readiness is ready", () => {
    // The whole point of the operator flag: readiness says "can
    // technically commit"; the flag says "I trust this product live."
    // Both required.
    const r = evaluateLiveCommitEligibility({
      product: { ...READY_PRODUCT, zohoLiveCommitEnabled: false },
    });
    expect(r.eligible).toBe(false);
    if (r.eligible) return;
    expect(r.blockers.map((b) => b.code)).toContain("OPERATOR_FLAG_OFF");
  });

  it("blocks when readiness is not ready even if zohoLiveCommitEnabled = true", () => {
    const r = evaluateLiveCommitEligibility({
      product: { ...READY_PRODUCT, zohoItemIdCase: null },
    });
    expect(r.eligible).toBe(false);
    if (r.eligible) return;
    expect(r.blockers.map((b) => b.code)).toContain("ZOHO_READINESS_NOT_READY");
  });

  it("blocks when product is inactive", () => {
    const r = evaluateLiveCommitEligibility({
      product: { ...READY_PRODUCT, isActive: false },
    });
    expect(r.eligible).toBe(false);
    if (r.eligible) return;
    expect(r.blockers.map((b) => b.code)).toContain("PRODUCT_INACTIVE");
  });

  it("blocks when mapping blockers are present on the staged op", () => {
    const r = evaluateLiveCommitEligibility({
      product: READY_PRODUCT,
      mappingBlockers: [
        { code: "PO_NOT_FOUND", message: "Purchase order not found." },
      ],
    });
    expect(r.eligible).toBe(false);
    if (r.eligible) return;
    expect(r.blockers.map((b) => b.code)).toContain("MAPPING_BLOCKERS_PRESENT");
  });

  it("ignores empty / undefined mappingBlockers", () => {
    expect(
      evaluateLiveCommitEligibility({ product: READY_PRODUCT, mappingBlockers: [] })
        .eligible,
    ).toBe(true);
    expect(
      evaluateLiveCommitEligibility({ product: READY_PRODUCT }).eligible,
    ).toBe(true);
  });

  it("batches all failures rather than stair-stepping (better UX)", () => {
    // Operator should see EVERY blocker at once, not be told to fix
    // one and come back. That's what the fold-everything-then-return
    // pattern in evaluate enforces.
    const r = evaluateLiveCommitEligibility({
      product: {
        ...READY_PRODUCT,
        isActive: false,
        zohoLiveCommitEnabled: false,
      },
    });
    expect(r.eligible).toBe(false);
    if (r.eligible) return;
    const codes = r.blockers.map((b) => b.code);
    expect(codes).toContain("PRODUCT_INACTIVE");
    expect(codes).toContain("OPERATOR_FLAG_OFF");
  });

  it("readiness blocker surfaces the underlying reason codes for UI display", () => {
    const r = evaluateLiveCommitEligibility({
      product: { ...READY_PRODUCT, zohoItemIdUnit: null, zohoItemIdDisplay: null },
    });
    if (r.eligible) throw new Error("expected ineligible");
    const readiness = r.blockers.find((b) => b.code === "ZOHO_READINESS_NOT_READY");
    expect(readiness?.readinessReasons).toContain("no_unit_id");
    expect(readiness?.readinessReasons).toContain("no_display_id");
  });
});

describe("liveCommitEligibilityShortLabel — chip-friendly label", () => {
  it("returns the ready label when eligible", () => {
    const r = evaluateLiveCommitEligibility({ product: READY_PRODUCT });
    expect(liveCommitEligibilityShortLabel(r)).toBe("Live commit ready");
  });

  it("prefers the operator-flag-off label when that blocker is present", () => {
    // It's the most common case + most one-click-actionable.
    const r = evaluateLiveCommitEligibility({
      product: { ...READY_PRODUCT, zohoLiveCommitEnabled: false },
    });
    expect(liveCommitEligibilityShortLabel(r)).toBe(
      "Live commit disabled by operator",
    );
  });

  it("falls through to inactive label", () => {
    const r = evaluateLiveCommitEligibility({
      product: {
        ...READY_PRODUCT,
        isActive: false,
        // Don't set zohoLiveCommitEnabled=false here; we want the
        // inactive-only case so the label-routing prefers PRODUCT_INACTIVE.
      },
    });
    expect(liveCommitEligibilityShortLabel(r)).toBe("Product inactive");
  });

  it("falls through to generic label when only readiness blocks", () => {
    const r = evaluateLiveCommitEligibility({
      product: { ...READY_PRODUCT, zohoItemIdCase: null },
    });
    expect(liveCommitEligibilityShortLabel(r)).toBe("Not live-commit ready");
  });
});
