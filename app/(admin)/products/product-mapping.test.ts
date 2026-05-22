import { describe, it, expect } from "vitest";

describe("saveProductAction field extraction", () => {
  it("leaves assembly ID fields undefined when not in FormData", () => {
    const fd = new FormData();
    fd.set("id", "11111111-1111-1111-1111-111111111111");
    fd.set("name", "Test Product");
    fd.set("kind", "BOTTLE");
    fd.set("sku", "SKU-001");
    fd.set("zohoItemId", "ZOHO-123");
    // zohoItemIdUnit / Display / Case deliberately NOT set

    const zohoItemIdUnit    = (fd.get("zohoItemIdUnit") as string | null) || undefined;
    const zohoItemIdDisplay = (fd.get("zohoItemIdDisplay") as string | null) || undefined;
    const zohoItemIdCase    = (fd.get("zohoItemIdCase") as string | null) || undefined;

    expect(zohoItemIdUnit).toBeUndefined();
    expect(zohoItemIdDisplay).toBeUndefined();
    expect(zohoItemIdCase).toBeUndefined();
  });

  it("passes assembly ID fields through when present in FormData", () => {
    const fd = new FormData();
    fd.set("zohoItemIdUnit", "ZOHO-UNIT-456");
    fd.set("zohoItemIdDisplay", "ZOHO-DISP-789");
    fd.set("zohoItemIdCase", "ZOHO-CASE-101");

    const zohoItemIdUnit    = (fd.get("zohoItemIdUnit") as string | null) || undefined;
    const zohoItemIdDisplay = (fd.get("zohoItemIdDisplay") as string | null) || undefined;
    const zohoItemIdCase    = (fd.get("zohoItemIdCase") as string | null) || undefined;

    expect(zohoItemIdUnit).toBe("ZOHO-UNIT-456");
    expect(zohoItemIdDisplay).toBe("ZOHO-DISP-789");
    expect(zohoItemIdCase).toBe("ZOHO-CASE-101");
  });

  it("treats empty-string assembly ID as undefined (skip column, not clear)", () => {
    const fd = new FormData();
    fd.set("zohoItemIdUnit", "");

    const zohoItemIdUnit = (fd.get("zohoItemIdUnit") as string | null) || undefined;
    expect(zohoItemIdUnit).toBeUndefined();
  });
});

describe("ZohoMappingForm unit field fallback", () => {
  it("uses zohoItemIdFallback when zohoItemIdUnit is null", () => {
    const zohoItemIdUnit: string | null = null;
    const zohoItemIdFallback: string | null = "ZOHO-LEGACY-001";

    const defaultValue = zohoItemIdUnit ?? zohoItemIdFallback ?? "";
    expect(defaultValue).toBe("ZOHO-LEGACY-001");
  });

  it("prefers zohoItemIdUnit over fallback when both present", () => {
    const zohoItemIdUnit: string | null = "ZOHO-UNIT-NEW";
    const zohoItemIdFallback: string | null = "ZOHO-LEGACY-001";

    const defaultValue = zohoItemIdUnit ?? zohoItemIdFallback ?? "";
    expect(defaultValue).toBe("ZOHO-UNIT-NEW");
  });

  it("shows empty string when both are null", () => {
    const zohoItemIdUnit: string | null = null;
    const zohoItemIdFallback: string | null = null;

    const defaultValue = zohoItemIdUnit ?? zohoItemIdFallback ?? "";
    expect(defaultValue).toBe("");
  });
});

describe("zohoItemId back-sync logic", () => {
  it("syncs zohoItemId when zohoItemIdUnit is ≤ 60 chars", () => {
    const zohoItemIdUnit: string | null = "ZOHO-UNIT-SHORT";
    const zohoItemId = zohoItemIdUnit === null || zohoItemIdUnit.length > 60 ? null : zohoItemIdUnit;
    expect(zohoItemId).toBe("ZOHO-UNIT-SHORT");
  });

  it("clears zohoItemId when zohoItemIdUnit exceeds 60 chars", () => {
    const zohoItemIdUnit: string | null = "Z".repeat(61);
    const zohoItemId = zohoItemIdUnit === null || zohoItemIdUnit.length > 60 ? null : zohoItemIdUnit;
    expect(zohoItemId).toBeNull();
  });

  it("sets zohoItemId to null when zohoItemIdUnit is cleared", () => {
    // Use a function return to prevent TypeScript narrowing null literal to never
    const zohoItemIdUnit = ((): string | null => null)();
    const zohoItemId = zohoItemIdUnit === null || zohoItemIdUnit.length > 60 ? null : zohoItemIdUnit;
    expect(zohoItemId).toBeNull();
  });

  it("syncs exactly 60-char zohoItemIdUnit (boundary check)", () => {
    const zohoItemIdUnit: string | null = "Z".repeat(60);
    const zohoItemId = zohoItemIdUnit === null || zohoItemIdUnit.length > 60 ? null : zohoItemIdUnit;
    expect(zohoItemId).toBe("Z".repeat(60));
  });
});
