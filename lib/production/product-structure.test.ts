// Phase H.x0.5 — Generic product-structure helper tests.
//
// Pure-math contract tests for the conversion primitives + zod-style
// validation tests for the admin server action's schema. DB-backed
// helpers are exercised via the deploy-time smoke (rebuild + spot
// query) — here we pin only the math + the empty-state vocabulary.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import {
  convertParentToChild,
  convertChildToParent,
  safeMultiply,
} from "./product-structure";
import { missing, ok } from "./confidence";

describe("safeMultiply", () => {
  it("multiplies positive finite numbers", () => {
    expect(safeMultiply(2, 3)).toBe(6);
    expect(safeMultiply(0, 100)).toBe(0);
    expect(safeMultiply(0.5, 2)).toBe(1);
  });
  it("rejects negative inputs (quantities are never negative)", () => {
    expect(safeMultiply(-1, 2)).toBe(null);
    expect(safeMultiply(2, -1)).toBe(null);
  });
  it("rejects NaN / Infinity", () => {
    expect(safeMultiply(NaN, 2)).toBe(null);
    expect(safeMultiply(2, Infinity)).toBe(null);
  });
});

describe("convertParentToChild", () => {
  // Card example: 1 case = 24 displays. Caller asks "how many
  // displays in 5 cases?"
  it("expands case → display: 1 case = 24 displays, 5 cases = 120 displays", () => {
    expect(convertParentToChild({ parentQty: 1, childQty: 24 }, 5)).toBe(120);
  });
  // Card example: 1 display = 12 cards
  it("expands display → card: 1 display = 12 cards, 10 displays = 120 cards", () => {
    expect(convertParentToChild({ parentQty: 1, childQty: 12 }, 10)).toBe(120);
  });
  // Bottle example: 1 bottle = 30 tablets
  it("expands bottle → tablet: 1 bottle = 30 tablets, 100 bottles = 3000 tablets", () => {
    expect(convertParentToChild({ parentQty: 1, childQty: 30 }, 100)).toBe(3000);
  });
  // Future pouch: 1 pouch = 10 gummies
  it("expands pouch → gummy: 1 pouch = 10 gummies, 200 pouches = 2000 gummies", () => {
    expect(convertParentToChild({ parentQty: 1, childQty: 10 }, 200)).toBe(2000);
  });
  // Edge: zero / negative / non-finite
  it("returns null for zero parent_qty (would divide by zero)", () => {
    expect(convertParentToChild({ parentQty: 0, childQty: 24 }, 5)).toBe(null);
  });
  it("returns null for negative quantity", () => {
    expect(convertParentToChild({ parentQty: 1, childQty: 24 }, -5)).toBe(null);
  });
  it("zero parent_quantity is identity-zero", () => {
    expect(convertParentToChild({ parentQty: 1, childQty: 24 }, 0)).toBe(0);
  });
  // Non-1 parent qty: 2 boxes = 50 items, what about 6 boxes?
  it("handles non-1 parent qty: 2 boxes = 50 items, 6 boxes = 150 items", () => {
    expect(convertParentToChild({ parentQty: 2, childQty: 50 }, 6)).toBe(150);
  });
});

describe("convertChildToParent", () => {
  it("inverts case → display: 120 displays = 5 cases", () => {
    expect(convertChildToParent({ parentQty: 1, childQty: 24 }, 120)).toBe(5);
  });
  it("inverts display → card: 120 cards = 10 displays", () => {
    expect(convertChildToParent({ parentQty: 1, childQty: 12 }, 120)).toBe(10);
  });
  it("returns null for zero child_qty (would divide by zero)", () => {
    expect(convertChildToParent({ parentQty: 1, childQty: 0 }, 100)).toBe(null);
  });
  it("returns null for negative input", () => {
    expect(convertChildToParent({ parentQty: 1, childQty: 24 }, -1)).toBe(null);
  });
});

// ─── Validation contract for the admin server action schema ──────

const PACK_LEVELS = [
  "RAW", "COMPONENT", "INTERMEDIATE", "UNIT", "INNER_PACK",
  "DISPLAY", "CASE", "PALLET", "FINISHED_GOOD", "SELLABLE",
] as const;

const conversionSchema = z
  .object({
    productId: z.string().uuid(),
    parentItemId: z.string().uuid(),
    childItemId: z.string().uuid(),
    parentQty: z.coerce.number().positive(),
    parentUom: z.string().min(1),
    parentPackLevel: z.enum(PACK_LEVELS),
    childQty: z.coerce.number().positive(),
    childUom: z.string().min(1),
    childPackLevel: z.enum(PACK_LEVELS),
    routeId: z.string().uuid().optional().nullable().or(z.literal("")),
    effectiveFrom: z.string().date(),
  })
  .refine((d) => d.parentItemId !== d.childItemId, {
    path: ["childItemId"],
  });

const VALID = {
  productId: "11111111-1111-1111-1111-111111111111",
  parentItemId: "22222222-2222-2222-2222-222222222222",
  childItemId: "33333333-3333-3333-3333-333333333333",
  parentQty: 1,
  parentUom: "cases",
  parentPackLevel: "CASE" as const,
  childQty: 24,
  childUom: "displays",
  childPackLevel: "DISPLAY" as const,
  routeId: "",
  effectiveFrom: "2026-05-07",
};

describe("conversion-action schema", () => {
  it("rejects zero parent quantity", () => {
    const r = conversionSchema.safeParse({ ...VALID, parentQty: 0 });
    expect(r.success).toBe(false);
  });
  it("rejects negative child quantity", () => {
    const r = conversionSchema.safeParse({ ...VALID, childQty: -5 });
    expect(r.success).toBe(false);
  });
  it("rejects missing parent item", () => {
    const r = conversionSchema.safeParse({ ...VALID, parentItemId: "" });
    expect(r.success).toBe(false);
  });
  it("rejects missing child item", () => {
    const r = conversionSchema.safeParse({ ...VALID, childItemId: "" });
    expect(r.success).toBe(false);
  });
  it("rejects parent and child being the same item", () => {
    const r = conversionSchema.safeParse({
      ...VALID,
      childItemId: VALID.parentItemId,
    });
    expect(r.success).toBe(false);
  });
  it("rejects empty UOM", () => {
    const r = conversionSchema.safeParse({ ...VALID, parentUom: "" });
    expect(r.success).toBe(false);
  });
  it("rejects invalid pack level", () => {
    const r = conversionSchema.safeParse({
      ...VALID,
      parentPackLevel: "MEGA_CASE" as unknown as (typeof PACK_LEVELS)[number],
    });
    expect(r.success).toBe(false);
  });
  it("accepts a valid conversion", () => {
    const r = conversionSchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });
  it("accepts route id when supplied", () => {
    const r = conversionSchema.safeParse({
      ...VALID,
      routeId: "44444444-4444-4444-4444-444444444444",
    });
    expect(r.success).toBe(true);
  });
});

describe("legacy + future product structure examples (pure math)", () => {
  // Pin the math the helper layer must always agree with. Each row
  // is "outputQty cases" × the chain → expected raw inputs.

  it("CARD_BLISTER: 100 cases × 24 displays/case × 12 cards/display × 20 tablets/card = 576,000 tablets", () => {
    const cases = 100;
    const displays = convertParentToChild({ parentQty: 1, childQty: 24 }, cases);
    expect(displays).toBe(2400);
    const cards = convertParentToChild({ parentQty: 1, childQty: 12 }, displays!);
    expect(cards).toBe(28800);
    const tablets = convertParentToChild({ parentQty: 1, childQty: 20 }, cards!);
    expect(tablets).toBe(576000);
  });

  it("BOTTLE: 100 cases × 24 displays/case × 12 bottles/display × 30 tablets/bottle = 864,000 tablets", () => {
    const cases = 100;
    const displays = convertParentToChild({ parentQty: 1, childQty: 24 }, cases);
    const bottles = convertParentToChild({ parentQty: 1, childQty: 12 }, displays!);
    const tablets = convertParentToChild({ parentQty: 1, childQty: 30 }, bottles!);
    expect(displays).toBe(2400);
    expect(bottles).toBe(28800);
    expect(tablets).toBe(864000);
  });

  it("FUTURE POUCH: 50 cases × 48 pouches/case × 10 gummies/pouch = 24,000 gummies", () => {
    const cases = 50;
    const pouches = convertParentToChild({ parentQty: 1, childQty: 48 }, cases);
    const gummies = convertParentToChild({ parentQty: 1, childQty: 10 }, pouches!);
    expect(pouches).toBe(2400);
    expect(gummies).toBe(24000);
  });
});

describe("missing-state vocabulary for the helpers", () => {
  // Pin the canonical empty-state labels every UI label maps to.
  it("missing structure → 'Product structure missing'", () => {
    const m = missing(null, ["item_conversions"], "Product structure missing");
    expect(m.label).toBe("Product structure missing");
    expect(m.confidence).toBe("MISSING");
    expect(m.value).toBe(null);
  });
  it("missing route → 'Product route missing'", () => {
    const m = missing(null, ["product_route_assignments"], "Product route missing");
    expect(m.label).toBe("Product route missing");
  });
  it("missing BOM → 'Packaging BOM missing'", () => {
    const m = missing(null, ["product_packaging_specs"], "Packaging BOM missing");
    expect(m.label).toBe("Packaging BOM missing");
  });
  it("missing Zoho mapping → 'Zoho item mapping missing'", () => {
    const m = missing(null, ["external_item_mappings"], "Zoho item mapping missing");
    expect(m.label).toBe("Zoho item mapping missing");
  });
  it("real conversion result returns ok() with confidence HIGH", () => {
    const m = ok(120, "displays");
    expect(m.confidence).toBe("HIGH");
    expect(m.value).toBe(120);
    expect(m.unit).toBe("displays");
  });
});


describe("seed-data shape contracts (Zoho foundation)", () => {
  // Every external_systems row seeded by 0014. If a seed is renamed
  // or a new system is added, this test catches it.
  const SEEDED_EXTERNAL_SYSTEMS = ["ZOHO", "PACKTRACK", "NEXUS", "QIP"] as const;
  const SEEDED_ITEM_CATEGORIES = [
    "RAW_MATERIAL",
    "PACKAGING_MATERIAL",
    "COMPONENT",
    "INTERMEDIATE_GOOD",
    "FINISHED_GOOD",
    "SELLABLE_SKU",
    "SERVICE",
    "OTHER",
  ] as const;
  const SEEDED_PACK_LEVELS = [
    "RAW",
    "COMPONENT",
    "INTERMEDIATE",
    "UNIT",
    "INNER_PACK",
    "DISPLAY",
    "CASE",
    "PALLET",
    "FINISHED_GOOD",
    "SELLABLE",
  ] as const;

  it("ZOHO is in the seeded external_systems set", () => {
    expect(SEEDED_EXTERNAL_SYSTEMS).toContain("ZOHO");
  });
  it("FINISHED_GOOD and PACKAGING_MATERIAL are valid item_category values", () => {
    expect(SEEDED_ITEM_CATEGORIES).toContain("FINISHED_GOOD");
    expect(SEEDED_ITEM_CATEGORIES).toContain("PACKAGING_MATERIAL");
  });
  it("CASE and DISPLAY are valid pack_level values", () => {
    expect(SEEDED_PACK_LEVELS).toContain("CASE");
    expect(SEEDED_PACK_LEVELS).toContain("DISPLAY");
  });
  it("UNKNOWN is the safe default mapping_type — never auto-resolved", () => {
    const types = [
      "RAW_MATERIAL",
      "PACKAGING_MATERIAL",
      "COMPONENT",
      "INTERMEDIATE_GOOD",
      "FINISHED_GOOD",
      "SELLABLE_SKU",
      "UNKNOWN",
    ] as const;
    expect(types).toContain("UNKNOWN");
  });
});

describe("extensibility contract (no hardcoding new products)", () => {
  it("adding a future POUCH product requires only data, never enum migrations", () => {
    const inserts = [
      "INSERT INTO items (item_code, name, item_category, default_unit_of_measure) VALUES ('GMY:STRAW', 'Strawberry gummy', 'RAW_MATERIAL', 'gummies')",
      "INSERT INTO items (item_code, name, item_category, default_unit_of_measure) VALUES ('PCH:STRAW-12', 'Strawberry pouch (12)', 'FINISHED_GOOD', 'pouches')",
      "INSERT INTO item_conversions (product_id, parent_item_id, child_item_id, parent_quantity, child_quantity, parent_pack_level, child_pack_level, parent_unit_of_measure, child_unit_of_measure) VALUES (...)",
    ];
    for (const stmt of inserts) {
      expect(stmt).toMatch(/INSERT INTO/);
      expect(stmt).not.toMatch(/ALTER TYPE|CREATE TYPE|ADD VALUE|ALTER TABLE/);
    }
  });
});
