import { describe, expect, it } from "vitest";
import {
  confidenceForResolutionMethod,
  PARTIAL_BAG_RESOLUTION_METHODS,
} from "./partial-bag-resolution-constants";
import {
  canAdminResolvePartialBagInventory,
  validatePartialBagResolutionInput,
} from "./partial-bag-review-closeout";

describe("confidenceForResolutionMethod", () => {
  it("marks supervisor estimate as LOW", () => {
    expect(confidenceForResolutionMethod("SUPERVISOR_ESTIMATE")).toBe("LOW");
  });

  it("marks physical count and weigh-back as MEDIUM", () => {
    expect(confidenceForResolutionMethod("PHYSICAL_COUNT")).toBe("MEDIUM");
    expect(confidenceForResolutionMethod("WEIGH_BACK")).toBe("MEDIUM");
  });
});

describe("validatePartialBagResolutionInput", () => {
  it("rejects negative remaining count", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: -1,
      resolutionMethod: "PHYSICAL_COUNT",
      note: "verified on floor",
      declaredStartingCount: 1000,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects empty note", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: 500,
      resolutionMethod: "PHYSICAL_COUNT",
      note: "   ",
      declaredStartingCount: 1000,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects short note for SUPERVISOR_ESTIMATE", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: 500,
      resolutionMethod: "SUPERVISOR_ESTIMATE",
      note: "too short",
      declaredStartingCount: 7197,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10 characters/);
  });

  it("accepts SUPERVISOR_ESTIMATE with adequate note", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: 5000,
      resolutionMethod: "SUPERVISOR_ESTIMATE",
      note: "Historical partial from weeks ago; physical count no longer possible.",
      declaredStartingCount: 7197,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects remaining above declared starting count", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: 1001,
      resolutionMethod: "PHYSICAL_COUNT",
      note: "verified",
      declaredStartingCount: 1000,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts valid input", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: 500,
      resolutionMethod: "WEIGH_BACK",
      note: "Weigh-back by supervisor",
      declaredStartingCount: 1000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects consumed+remaining mismatch when both provided", () => {
    const r = validatePartialBagResolutionInput({
      remainingTabletCount: 500,
      resolutionMethod: "PHYSICAL_COUNT",
      note: "verified",
      declaredStartingCount: 1000,
      consumedQty: 400,
    });
    expect(r.ok).toBe(false);
  });
});

describe("canAdminResolvePartialBagInventory", () => {
  it("blocks ready bags", () => {
    expect(
      canAdminResolvePartialBagInventory({
        eligibility: "ready",
        inventoryStatus: "AVAILABLE",
        hasOpenSession: false,
        hasPartialPackagingWorkflow: true,
      }).ok,
    ).toBe(false);
  });

  it("blocks the resolve-page flow on an open session but gives an actionable, non-floor reason", () => {
    const result = canAdminResolvePartialBagInventory({
      eligibility: "missing_linkage",
      inventoryStatus: "AVAILABLE",
      hasOpenSession: true,
      hasPartialPackagingWorkflow: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // SPLIT-BAG-2 — no dead-end "close it at the floor"; points to the
      // workbench closeout options instead.
      expect(result.reason).not.toMatch(/at the floor/i);
      expect(result.reason).toMatch(/Use calculated remaining/);
      expect(result.reason).toMatch(/Correct remaining/);
      expect(result.reason).toMatch(/Mark depleted/);
    }
  });

  it("allows missing_linkage with partial workflow evidence", () => {
    expect(
      canAdminResolvePartialBagInventory({
        eligibility: "missing_linkage",
        inventoryStatus: "AVAILABLE",
        hasOpenSession: false,
        hasPartialPackagingWorkflow: true,
      }).ok,
    ).toBe(true);
  });

  it("blocks void inventory", () => {
    expect(
      canAdminResolvePartialBagInventory({
        eligibility: "missing_linkage",
        inventoryStatus: "VOID",
        hasOpenSession: false,
        hasPartialPackagingWorkflow: true,
      }).ok,
    ).toBe(false);
  });
});

describe("PARTIAL_BAG_RESOLUTION_METHODS", () => {
  it("includes all required methods", () => {
    expect(PARTIAL_BAG_RESOLUTION_METHODS).toEqual([
      "PHYSICAL_COUNT",
      "WEIGH_BACK",
      "SUPERVISOR_ESTIMATE",
    ]);
  });
});
