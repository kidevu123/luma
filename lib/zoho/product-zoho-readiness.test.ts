import { describe, it, expect } from "vitest";
import {
  classifyProductZohoReadiness,
  zohoReadinessLabel,
  zohoReadinessReasonLabel,
} from "./product-zoho-readiness";

const BASE = {
  isActive: true,
  zohoItemIdUnit: null as string | null,
  zohoItemIdDisplay: null as string | null,
  zohoItemIdCase: null as string | null,
  unitsPerDisplay: null as number | null,
  displaysPerCase: null as number | null,
};

describe("classifyProductZohoReadiness", () => {
  it("inactive product → INACTIVE regardless of configured IDs", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      isActive: false,
      zohoItemIdUnit: "460000000001",
    });
    expect(result.level).toBe("inactive");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit-only product with unit ID → READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
    });
    expect(result.level).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit-only product without unit ID → MISSING", () => {
    const result = classifyProductZohoReadiness({ ...BASE });
    expect(result.level).toBe("missing");
    expect(result.reasons).toContain("no_unit_id");
    expect(result.reasons).toHaveLength(1);
  });

  it("unit+display product with only unit ID → PARTIAL", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      unitsPerDisplay: 12,
    });
    expect(result.level).toBe("partial");
    expect(result.reasons).toContain("no_display_id");
    expect(result.reasons).not.toContain("no_unit_id");
  });

  it("unit+display product with both IDs → READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      zohoItemIdDisplay: "460000000002",
      unitsPerDisplay: 12,
    });
    expect(result.level).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit+display product with no IDs → MISSING (all required missing)", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      unitsPerDisplay: 12,
    });
    expect(result.level).toBe("missing");
    expect(result.reasons).toContain("no_unit_id");
    expect(result.reasons).toContain("no_display_id");
    expect(result.reasons).toHaveLength(2);
  });

  it("unit+display+case product with all three IDs → READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      zohoItemIdDisplay: "460000000002",
      zohoItemIdCase: "460000000003",
      unitsPerDisplay: 12,
      displaysPerCase: 4,
    });
    expect(result.level).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit+display+case product with only unit ID → PARTIAL (two IDs missing)", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      unitsPerDisplay: 12,
      displaysPerCase: 4,
    });
    expect(result.level).toBe("partial");
    expect(result.reasons).toContain("no_display_id");
    expect(result.reasons).toContain("no_case_id");
    expect(result.reasons).not.toContain("no_unit_id");
  });

  it("unit+display+case product with no IDs → MISSING (all three missing)", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      unitsPerDisplay: 12,
      displaysPerCase: 4,
    });
    expect(result.level).toBe("missing");
    expect(result.reasons).toHaveLength(3);
  });

  it("tablet mapping count is not an input — Zoho readiness ignores floor readiness", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
    });
    expect(result.level).toBe("ready");
  });

  it("legacy zoho_item_id is not checked — zohoItemIdUnit is required for READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: null,
    });
    expect(result.level).toBe("missing");
    expect(result.reasons).toContain("no_unit_id");
  });
});

describe("zohoReadinessLabel", () => {
  it("returns non-empty strings for all four levels", () => {
    expect(zohoReadinessLabel("ready")).toMatch(/ready/i);
    expect(zohoReadinessLabel("partial")).toMatch(/partial/i);
    expect(zohoReadinessLabel("missing")).toMatch(/missing/i);
    expect(zohoReadinessLabel("inactive")).toMatch(/inactive/i);
  });
});

describe("zohoReadinessReasonLabel", () => {
  it("returns descriptive strings for all three reasons", () => {
    expect(zohoReadinessReasonLabel("no_unit_id")).toMatch(/unit/i);
    expect(zohoReadinessReasonLabel("no_display_id")).toMatch(/display/i);
    expect(zohoReadinessReasonLabel("no_case_id")).toMatch(/case/i);
  });
});
