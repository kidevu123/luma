// PBOM-2 — compatibility helper tests.
//
// The query-shaped helpers (getCompatibleMaterialsForProduct,
// isMaterialCompatibleWithProduct, validateProductBomMaterial) take a
// drizzle Db handle. We stub tx.execute() / tx.select() with a small
// fake that returns canned data per call. The tests pin behaviour:
//   - empty matrix yields COMPATIBILITY_MISSING (no silent fallback)
//   - registered row yields ok=true
//   - mismatched material yields NOT_COMPATIBLE_WITH_PRODUCT
//   - PVC/FOIL/BLISTER_FOIL rejected as MACHINE_CONSUMABLE before
//     touching the matrix
//   - kind cross-scope rejected with KIND_NOT_ALLOWED_AT_SCOPE
//
// The pure helpers (canRegisterCompatibility, suggestRole,
// explainCompatibilityRejection) round out the file.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import {
  COMPATIBILITY_ROLES,
  canRegisterCompatibility,
  explainCompatibilityRejection,
  getCompatibleMaterialsForProduct,
  isMaterialCompatibleWithProduct,
  suggestRole,
  validateProductBomMaterial,
} from "./product-material-compatibility";

type ExecQueue = Array<Array<Record<string, unknown>>>;
type SelectQueue = Array<Array<Record<string, unknown>>>;

function buildDb(
  execQueue: ExecQueue = [],
  selectQueue: SelectQueue = [],
) {
  return {
    execute: async () => {
      const next = execQueue.shift();
      return (next ?? []) as unknown[];
    },
    select: () => ({
      from: () => ({
        where: () => {
          const next = selectQueue.shift();
          return Promise.resolve(next ?? []);
        },
      }),
    }),
  } as unknown as Parameters<typeof getCompatibleMaterialsForProduct>[0];
}

const MANGO_PEACH = "11111111-1111-4111-8111-111111111111";
const BLUE_RAZ = "22222222-2222-4222-8222-222222222222";
const ROUTE_CARD = "33333333-3333-4333-8333-333333333333";
const MAT_MANGO_CARD = "44444444-4444-4444-8444-444444444444";
const MAT_BLUE_RAZ_CARD = "55555555-5555-4555-8555-555555555555";
const MAT_DISPLAY = "66666666-6666-4666-8666-666666666666";
const MAT_CASE = "77777777-7777-4777-8777-777777777777";
const MAT_PVC = "88888888-8888-4888-8888-888888888888";

describe("COMPATIBILITY_ROLES vocabulary", () => {
  it("ships exactly the 10 roles from the spec", () => {
    expect([...COMPATIBILITY_ROLES].sort()).toEqual(
      [
        "BOTTLE",
        "CAP",
        "CARD_MATERIAL",
        "DISPLAY_BOX",
        "INDUCTION_SEAL",
        "INSERT",
        "LABEL",
        "MASTER_CASE",
        "OTHER",
        "SHRINK_BAND",
      ].sort(),
    );
  });
});

describe("getCompatibleMaterialsForProduct", () => {
  it("returns rows shaped from the execute() result", async () => {
    const db = buildDb([
      [
        {
          materialId: MAT_MANGO_CARD,
          materialSku: "MP-CARD",
          materialName: "Mango Peach printed card",
          materialKind: "INSERT",
          uom: "each",
          compatibilityRole: "CARD_MATERIAL",
          required: true,
          defaultForProduct: true,
          routeMatched: true,
        },
      ],
    ]);
    const rows = await getCompatibleMaterialsForProduct(
      db,
      MANGO_PEACH,
      ROUTE_CARD,
      "UNIT",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      materialId: MAT_MANGO_CARD,
      materialSku: "MP-CARD",
      compatibilityRole: "CARD_MATERIAL",
      required: true,
      defaultForProduct: true,
      routeMatched: true,
    });
  });

  it("returns empty array when no compatibility rows exist", async () => {
    const db = buildDb([[]]);
    const rows = await getCompatibleMaterialsForProduct(
      db,
      MANGO_PEACH,
      null,
      "DISPLAY",
    );
    expect(rows).toEqual([]);
  });
});

describe("isMaterialCompatibleWithProduct", () => {
  it("rejects PVC_ROLL as MACHINE_CONSUMABLE (never touches matrix)", async () => {
    const db = buildDb(
      [],
      [
        [
          {
            id: MAT_PVC,
            kind: "PVC_ROLL",
            isActive: true,
            sku: "PVC-1",
            name: "PVC roll 200mm",
            uom: "kg",
          },
        ],
      ],
    );
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      ROUTE_CARD,
      MAT_PVC,
      "UNIT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MACHINE_CONSUMABLE");
  });

  it("rejects inactive material with MATERIAL_INACTIVE", async () => {
    const db = buildDb(
      [],
      [
        [
          {
            id: MAT_DISPLAY,
            kind: "DISPLAY",
            isActive: false,
            sku: "DSP-1",
            name: "Old display",
            uom: "each",
          },
        ],
      ],
    );
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      null,
      MAT_DISPLAY,
      "DISPLAY",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MATERIAL_INACTIVE");
  });

  it("rejects unknown material id with MATERIAL_NOT_FOUND", async () => {
    const db = buildDb([], [[]]);
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      null,
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "UNIT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MATERIAL_NOT_FOUND");
  });

  it("rejects DISPLAY-kind at UNIT scope with KIND_NOT_ALLOWED_AT_SCOPE", async () => {
    const db = buildDb(
      [],
      [
        [
          {
            id: MAT_DISPLAY,
            kind: "DISPLAY",
            isActive: true,
            sku: "DSP-1",
            name: "Display",
            uom: "each",
          },
        ],
      ],
    );
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      null,
      MAT_DISPLAY,
      "UNIT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("KIND_NOT_ALLOWED_AT_SCOPE");
  });

  it("returns COMPATIBILITY_MISSING when matrix has zero rows for the scope", async () => {
    const db = buildDb(
      [
        [], // matrix lookup → empty
        [], // anyRows → empty
      ],
      [
        [
          {
            id: MAT_DISPLAY,
            kind: "DISPLAY",
            isActive: true,
            sku: "DSP-1",
            name: "Display",
            uom: "each",
          },
        ],
      ],
    );
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      null,
      MAT_DISPLAY,
      "DISPLAY",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("COMPATIBILITY_MISSING");
      expect(r.reason).toMatch(/missing/i);
    }
  });

  it("returns NOT_COMPATIBLE_WITH_PRODUCT when matrix exists but material is not approved", async () => {
    const db = buildDb(
      [
        [], // matrix lookup for this material → empty
        [{ ok: 1 }], // anyRows → at least one (Mango uses different material)
      ],
      [
        [
          {
            id: MAT_BLUE_RAZ_CARD,
            kind: "INSERT",
            isActive: true,
            sku: "BR-CARD",
            name: "Blue Raz printed card",
            uom: "each",
          },
        ],
      ],
    );
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      null,
      MAT_BLUE_RAZ_CARD,
      "UNIT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NOT_COMPATIBLE_WITH_PRODUCT");
      expect(r.reason).toMatch(/not approved/i);
    }
  });

  it("returns ok=true when the material is on the compatibility list", async () => {
    const db = buildDb(
      [
        [
          {
            compatibilityRole: "CARD_MATERIAL",
            required: true,
            defaultForProduct: true,
            routeMatched: true,
          },
        ],
      ],
      [
        [
          {
            id: MAT_MANGO_CARD,
            kind: "INSERT",
            isActive: true,
            sku: "MP-CARD",
            name: "Mango Peach printed card",
            uom: "each",
          },
        ],
      ],
    );
    const r = await isMaterialCompatibleWithProduct(
      db,
      MANGO_PEACH,
      ROUTE_CARD,
      MAT_MANGO_CARD,
      "UNIT",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.compatibilityRole).toBe("CARD_MATERIAL");
      expect(r.row.defaultForProduct).toBe(true);
      expect(r.row.routeMatched).toBe(true);
    }
  });
});

describe("validateProductBomMaterial — action-layer entry point", () => {
  it("is a thin wrapper that returns the same shape", async () => {
    const db = buildDb(
      [
        [
          {
            compatibilityRole: "CARD_MATERIAL",
            required: false,
            defaultForProduct: false,
            routeMatched: false,
          },
        ],
      ],
      [
        [
          {
            id: MAT_MANGO_CARD,
            kind: "INSERT",
            isActive: true,
            sku: "MP-CARD",
            name: "Mango Peach printed card",
            uom: "each",
          },
        ],
      ],
    );
    const r = await validateProductBomMaterial(db, {
      productId: MANGO_PEACH,
      routeId: null,
      materialId: MAT_MANGO_CARD,
      scope: "UNIT",
    });
    expect(r.ok).toBe(true);
  });
});

describe("canRegisterCompatibility — pure pre-check on the admin page", () => {
  it("rejects PVC_ROLL outright", () => {
    const r = canRegisterCompatibility("PVC_ROLL", "UNIT");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/blister/i);
  });
  it("rejects FOIL_ROLL outright", () => {
    expect(canRegisterCompatibility("FOIL_ROLL", "UNIT").ok).toBe(false);
  });
  it("rejects BLISTER_FOIL outright", () => {
    expect(canRegisterCompatibility("BLISTER_FOIL", "UNIT").ok).toBe(false);
  });
  it("accepts DISPLAY kind at DISPLAY scope", () => {
    expect(canRegisterCompatibility("DISPLAY", "DISPLAY").ok).toBe(true);
  });
  it("rejects DISPLAY kind at UNIT scope (cross-level)", () => {
    expect(canRegisterCompatibility("DISPLAY", "UNIT").ok).toBe(false);
  });
});

describe("suggestRole", () => {
  it("maps DISPLAY kind at DISPLAY scope to DISPLAY_BOX role", () => {
    expect(suggestRole("DISPLAY", "DISPLAY")).toBe("DISPLAY_BOX");
  });
  it("maps CASE kind at CASE scope to MASTER_CASE role", () => {
    expect(suggestRole("CASE", "CASE")).toBe("MASTER_CASE");
  });
  it("maps bottle-route kinds to their specific role", () => {
    expect(suggestRole("BOTTLE", "UNIT")).toBe("BOTTLE");
    expect(suggestRole("CAP", "UNIT")).toBe("CAP");
    expect(suggestRole("LABEL", "UNIT")).toBe("LABEL");
    expect(suggestRole("INDUCTION_SEAL", "UNIT")).toBe("INDUCTION_SEAL");
  });
  it("falls back to OTHER for unmapped combinations", () => {
    expect(suggestRole("HEAT_SEAL_FILM", "UNIT")).toBe("OTHER");
  });
});

describe("explainCompatibilityRejection", () => {
  it("returns null on ok=true checks", () => {
    expect(
      explainCompatibilityRejection({
        ok: true,
        row: {
          materialId: MAT_MANGO_CARD,
          materialSku: "MP-CARD",
          materialName: "Mango Peach card",
          materialKind: "INSERT",
          uom: "each",
          compatibilityRole: "CARD_MATERIAL",
          required: false,
          defaultForProduct: false,
          routeMatched: false,
        },
      }),
    ).toBeNull();
  });
  it("returns the rejection reason string on failure", () => {
    expect(
      explainCompatibilityRejection({
        ok: false,
        code: "NOT_COMPATIBLE_WITH_PRODUCT",
        reason: "Blue Raz card is not approved for Mango Peach.",
      }),
    ).toMatch(/not approved/i);
  });
});
