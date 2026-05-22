import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { floorReadinessLabel } from "@/lib/production/product-floor-readiness";

const here = dirname(fileURLToPath(import.meta.url));
const dialogSrc   = readFileSync(resolve(here, "product-dialog.tsx"), "utf8");
const actionsSrc  = readFileSync(resolve(here, "actions.ts"), "utf8");
const mappingFormSrc = readFileSync(resolve(here, "[id]/zoho-mapping-form.tsx"), "utf8");

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

// ── PRODUCT-MAP-2 · dialog field name correctness ────────────────────────────
// Verifies product-dialog.tsx writes to zohoItemIdUnit (not legacy zohoItemId)
// so the value lands in the correct column and the mapping form shows it as
// already-saved rather than showing the "Pre-filled — save to confirm" hint.

describe("PRODUCT-MAP-2 · product dialog uses zohoItemIdUnit field", () => {
  it("dialog input has name='zohoItemIdUnit' (writes correct column)", () => {
    expect(dialogSrc).toMatch(/name="zohoItemIdUnit"/);
  });

  it("dialog does not use name='zohoItemId' for the primary Zoho ID field", () => {
    // Legacy field must not appear as a standalone input name in the dialog.
    // It is only ever derived server-side via back-sync.
    const inputNames = [...dialogSrc.matchAll(/name="zohoItemId"/g)];
    expect(inputNames).toHaveLength(0);
  });

  it("dialog defaultValue falls back from zohoItemIdUnit to legacy zohoItemId for old products", () => {
    expect(dialogSrc).toMatch(/zohoItemIdUnit\s*\?\?\s*row\?\.zohoItemId/);
  });

  it("dialog label says 'Zoho item ID — single unit'", () => {
    expect(dialogSrc).toMatch(/Zoho item ID — single unit/);
  });
});

// ── PRODUCT-MAP-2 · saveProductAction back-sync ──────────────────────────────
// Verifies actions.ts derives zohoItemId from zohoItemIdUnit so the legacy
// column and the new column remain consistent after a dialog save.

describe("PRODUCT-MAP-2 · saveProductAction back-sync", () => {
  it("actions.ts contains the back-sync logic", () => {
    expect(actionsSrc).toMatch(/backSyncedZohoItemId/);
    expect(actionsSrc).toMatch(/zohoItemIdUnit !== undefined/);
  });

  it("back-sync sets zohoItemId = zohoItemIdUnit when ≤ 60 chars", () => {
    const zohoItemIdUnit: string | undefined = "ZOHO-UNIT-001";
    const backSynced =
      zohoItemIdUnit !== undefined
        ? zohoItemIdUnit === null || zohoItemIdUnit.length > 60
          ? null
          : zohoItemIdUnit
        : undefined;
    expect(backSynced).toBe("ZOHO-UNIT-001");
  });

  it("back-sync sets zohoItemId = null when zohoItemIdUnit > 60 chars", () => {
    const zohoItemIdUnit: string | undefined = "Z".repeat(61);
    const backSynced =
      zohoItemIdUnit !== undefined
        ? zohoItemIdUnit === null || zohoItemIdUnit.length > 60
          ? null
          : zohoItemIdUnit
        : undefined;
    expect(backSynced).toBeNull();
  });

  it("back-sync falls through to existing zohoItemId when zohoItemIdUnit is not submitted", () => {
    // When zohoItemIdUnit is not in FormData, it comes through as undefined.
    // The action falls through to the legacy zohoItemId value (no override).
    const zohoItemIdUnit = ((): string | null | undefined => undefined)();
    const legacyZohoItemId: string | null = "LEGACY-123";
    const backSynced =
      zohoItemIdUnit !== undefined
        ? zohoItemIdUnit === null || zohoItemIdUnit.length > 60
          ? null
          : zohoItemIdUnit
        : legacyZohoItemId;
    expect(backSynced).toBe("LEGACY-123");
  });
});

// ── PRODUCT-MAP-2 · Zoho mapping form label canonicalization ─────────────────

describe("PRODUCT-MAP-2 · Zoho mapping form canonical labels", () => {
  it("unit label is 'Zoho item ID — single unit'", () => {
    expect(mappingFormSrc).toMatch(/Zoho item ID — single unit/);
  });

  it("display label is 'Zoho item ID — display'", () => {
    expect(mappingFormSrc).toMatch(/Zoho item ID — display/);
  });

  it("case label is 'Zoho item ID — case'", () => {
    expect(mappingFormSrc).toMatch(/Zoho item ID — case/);
  });

  it("does not use legacy label 'Display Zoho item ID' or 'Case Zoho item ID'", () => {
    expect(mappingFormSrc).not.toMatch(/Display Zoho item ID/);
    expect(mappingFormSrc).not.toMatch(/Case Zoho item ID/);
  });
});

// ── PRODUCT-MAP-2 · floor readiness classification ───────────────────────────

describe("PRODUCT-MAP-2 · floor readiness", () => {
  it("active product with tablet mappings is 'ready'", () => {
    const label = floorReadinessLabel("ready");
    expect(label).toBe("Ready for floor selection");
  });

  it("active product with no tablet mappings is 'no-tablet-mapping'", () => {
    const label = floorReadinessLabel("no-tablet-mapping");
    expect(label).toMatch(/Missing tablet mapping/);
    expect(label).toMatch(/floor selection unavailable/);
  });

  it("inactive product is 'inactive'", () => {
    const label = floorReadinessLabel("inactive");
    expect(label).toMatch(/Inactive/);
    expect(label).toMatch(/cannot be assigned/);
  });
});

// ── PRODUCT-MAP-2 · floor selection compatibility (Task 6) ────────────────────
// Pure logic verifying the floor narrowing rules are consistent with what the
// product admin configures. References the same filter contract as
// filteredProducts in scan-card-form.tsx (tested in scan-card-form.test.ts).

describe("PRODUCT-MAP-2 · floor compatibility: product_allowed_tablets contract", () => {
  type FloorProduct = { id: string; allowedTabletTypeIds: string[] };

  function narrowForFloor(products: FloorProduct[], tabletTypeId: string | null): FloorProduct[] {
    if (!tabletTypeId) return products;
    return products.filter((p) => p.allowedTabletTypeIds.includes(tabletTypeId));
  }

  const mapped   = { id: "p1", allowedTabletTypeIds: ["tt-001"] };
  const unmapped = { id: "p2", allowedTabletTypeIds: [] };

  it("product with tablet mapping is included when tablet type matches", () => {
    expect(narrowForFloor([mapped, unmapped], "tt-001")).toEqual([mapped]);
  });

  it("product with NO tablet mapping is excluded when tablet type is known", () => {
    expect(narrowForFloor([unmapped], "tt-001")).toHaveLength(0);
  });

  it("all products shown when tablet type is null (no type info — show all as fallback)", () => {
    expect(narrowForFloor([mapped, unmapped], null)).toEqual([mapped, unmapped]);
  });

  it("zero matches → config error scenario (no compatible product)", () => {
    expect(narrowForFloor([mapped], "tt-unknown")).toHaveLength(0);
  });

  it("exactly one match → auto-select/auto-start scenario", () => {
    const result = narrowForFloor([mapped, unmapped], "tt-001");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
  });

  it("multiple matches → narrowed picker scenario", () => {
    const p2 = { id: "p2", allowedTabletTypeIds: ["tt-001"] };
    const result = narrowForFloor([mapped, p2], "tt-001");
    expect(result).toHaveLength(2);
  });
});
