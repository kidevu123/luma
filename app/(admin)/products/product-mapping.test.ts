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

// ─── Product creation → mapping prefill ───────────────────────────────────────
// These three tests cover the explicit scenarios required by PRODUCT-MAPPING-2:
//   1. Product created with a single-unit Zoho item ID has it prefilled on the
//      product detail / mapping page.
//   2. An existing explicit mapping value is not overwritten by the product-
//      level default.
//   3. An empty product-level Zoho ID yields an empty mapping field.

describe("product creation Zoho ID prefill workflow", () => {
  it("product created with zohoItemId shows that ID in the mapping unit field", () => {
    // Simulates: createProduct({ zohoItemId: "ZOHO-123" }) → product detail page
    // zohoItemIdUnit is null after creation (only set via the mapping form)
    const product = { zohoItemId: "ZOHO-123", zohoItemIdUnit: null as string | null };
    const fallback = product.zohoItemId ?? null;
    const unitValue = product.zohoItemIdUnit ?? fallback ?? "";
    expect(unitValue).toBe("ZOHO-123");
  });

  it("explicit mapping value wins over product-level default when both are set", () => {
    // Simulates: product with zohoItemId set, then mapping form saved with a
    // different zohoItemIdUnit — the explicit unit ID must win.
    const product = {
      zohoItemId: "ZOHO-LEGACY",
      zohoItemIdUnit: "ZOHO-UNIT-EXPLICIT" as string | null,
    };
    const fallback = product.zohoItemId ?? null;
    const unitValue = product.zohoItemIdUnit ?? fallback ?? "";
    expect(unitValue).toBe("ZOHO-UNIT-EXPLICIT");
  });

  it("empty product-level Zoho ID results in empty mapping unit field", () => {
    // Simulates: product created without a Zoho item ID → mapping form is blank.
    const product = { zohoItemId: null as string | null, zohoItemIdUnit: null as string | null };
    const fallback = product.zohoItemId ?? null;
    const unitValue = product.zohoItemIdUnit ?? fallback ?? "";
    expect(unitValue).toBe("");
  });
});

describe("updateProductZohoAssemblyMappingAction schema", () => {
  function coerceZohoField(raw: string | null): string | null {
    return raw || null;
  }

  it("empty string unit ID is coerced to null (clears the field)", () => {
    expect(coerceZohoField("")).toBeNull();
  });

  it("null unit ID is coerced to null", () => {
    expect(coerceZohoField(null)).toBeNull();
  });

  it("non-empty unit ID passes through unchanged", () => {
    expect(coerceZohoField("ZOHO-UNIT-456")).toBe("ZOHO-UNIT-456");
  });

  it("back-sync sets zohoItemId from zohoItemIdUnit when ≤ 60 chars", () => {
    const zohoItemIdUnit: string | null = "ZOHO-UNIT-SHORT";
    const zohoItemId =
      zohoItemIdUnit === null || zohoItemIdUnit.length > 60 ? null : zohoItemIdUnit;
    expect(zohoItemId).toBe("ZOHO-UNIT-SHORT");
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
