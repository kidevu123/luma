// Phase H.x5/H.x6 — server-action validation contract tests.
//
// The tests below pin the zod schemas + validation rules used by
// the admin actions without spinning up the DB. Real DB writes are
// covered by deploy-time smoke. The schemas live inline in the
// actions files; we redefine the shape here and exercise the
// invariants the user spec mandates.

import { describe, it, expect } from "vitest";
import { z } from "zod";

// Mirror the materials-action schema shape.
const MATERIAL_KINDS = [
  "DISPLAY",
  "CASE",
  "LABEL",
  "BOTTLE",
  "CAP",
  "INDUCTION_SEAL",
  "INSERT",
  "SHRINK_BAND",
  "PVC_ROLL",
  "FOIL_ROLL",
  "OTHER",
] as const;

const materialSchema = z.object({
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  kind: z.enum(MATERIAL_KINDS),
  uom: z.string().min(1).max(40),
  parLevel: z.coerce.number().int().min(0).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

describe("materials schema", () => {
  it("rejects missing material kind", () => {
    const r = materialSchema.safeParse({
      sku: "X",
      name: "X",
      uom: "each",
    });
    expect(r.success).toBe(false);
  });
  it("rejects invalid kind value", () => {
    const r = materialSchema.safeParse({
      sku: "X",
      name: "X",
      kind: "WIDGET",
      uom: "each",
    });
    expect(r.success).toBe(false);
  });
  it("rejects empty SKU", () => {
    const r = materialSchema.safeParse({
      sku: "",
      name: "X",
      kind: "BOTTLE",
      uom: "each",
    });
    expect(r.success).toBe(false);
  });
  it("rejects negative par level", () => {
    const r = materialSchema.safeParse({
      sku: "X",
      name: "X",
      kind: "BOTTLE",
      uom: "each",
      parLevel: -5,
    });
    expect(r.success).toBe(false);
  });
  it("accepts a complete material record", () => {
    const r = materialSchema.safeParse({
      sku: "BTL-30",
      name: "Bottle 30ct",
      kind: "BOTTLE",
      uom: "each",
      parLevel: 1000,
      isActive: true,
    });
    expect(r.success).toBe(true);
  });
});

const PER_SCOPES = ["UNIT", "DISPLAY", "CASE"] as const;
const bomSchema = z.object({
  productId: z.string().uuid(),
  packagingMaterialId: z.string().uuid(),
  perScope: z.enum(PER_SCOPES),
  qtyPerUnit: z.coerce.number().int().min(1, "Quantity must be > 0"),
  wasteAllowancePercent: z.coerce.number().min(0).max(100),
});

describe("packaging-BOM schema", () => {
  it("rejects zero quantity", () => {
    const r = bomSchema.safeParse({
      productId: "00000000-0000-0000-0000-000000000001",
      packagingMaterialId: "00000000-0000-0000-0000-000000000002",
      perScope: "CASE",
      qtyPerUnit: 0,
      wasteAllowancePercent: 0,
    });
    expect(r.success).toBe(false);
  });
  it("rejects negative quantity", () => {
    const r = bomSchema.safeParse({
      productId: "00000000-0000-0000-0000-000000000001",
      packagingMaterialId: "00000000-0000-0000-0000-000000000002",
      perScope: "CASE",
      qtyPerUnit: -1,
      wasteAllowancePercent: 0,
    });
    expect(r.success).toBe(false);
  });
  it("rejects waste > 100", () => {
    const r = bomSchema.safeParse({
      productId: "00000000-0000-0000-0000-000000000001",
      packagingMaterialId: "00000000-0000-0000-0000-000000000002",
      perScope: "CASE",
      qtyPerUnit: 1,
      wasteAllowancePercent: 150,
    });
    expect(r.success).toBe(false);
  });
  it("rejects negative waste", () => {
    const r = bomSchema.safeParse({
      productId: "00000000-0000-0000-0000-000000000001",
      packagingMaterialId: "00000000-0000-0000-0000-000000000002",
      perScope: "CASE",
      qtyPerUnit: 1,
      wasteAllowancePercent: -1,
    });
    expect(r.success).toBe(false);
  });
  it("rejects invalid perScope", () => {
    const r = bomSchema.safeParse({
      productId: "00000000-0000-0000-0000-000000000001",
      packagingMaterialId: "00000000-0000-0000-0000-000000000002",
      perScope: "PALLET",
      qtyPerUnit: 1,
      wasteAllowancePercent: 0,
    });
    expect(r.success).toBe(false);
  });
  it("accepts a valid BOM line", () => {
    const r = bomSchema.safeParse({
      productId: "00000000-0000-0000-0000-000000000001",
      packagingMaterialId: "00000000-0000-0000-0000-000000000002",
      perScope: "CASE",
      qtyPerUnit: 1,
      wasteAllowancePercent: 5,
    });
    expect(r.success).toBe(true);
  });
});

const ROLES = ["PVC", "FOIL"] as const;
const standardSchema = z
  .object({
    packagingMaterialId: z.string().uuid(),
    materialRole: z.enum(ROLES),
    expectedGramsPerBlister: z.coerce.number().min(0).optional().nullable(),
    expectedBlistersPerKg: z.coerce.number().min(0).optional().nullable(),
    setupWasteGrams: z.coerce.number().int().min(0),
    changeoverWasteGrams: z.coerce.number().int().min(0),
    effectiveFrom: z.string().date(),
  })
  .refine(
    (d) =>
      (d.expectedGramsPerBlister != null && d.expectedGramsPerBlister > 0) ||
      (d.expectedBlistersPerKg != null && d.expectedBlistersPerKg > 0),
    {
      message: "Need either grams per blister or blisters per kg",
      path: ["expectedGramsPerBlister"],
    },
  );

describe("blister-standard schema", () => {
  it("rejects standard with no usage basis", () => {
    const r = standardSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      materialRole: "PVC",
      setupWasteGrams: 0,
      changeoverWasteGrams: 0,
      effectiveFrom: "2026-05-07",
    });
    expect(r.success).toBe(false);
  });
  it("rejects invalid role", () => {
    const r = standardSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      materialRole: "BOTTLE",
      expectedGramsPerBlister: 5,
      setupWasteGrams: 0,
      changeoverWasteGrams: 0,
      effectiveFrom: "2026-05-07",
    });
    expect(r.success).toBe(false);
  });
  it("accepts grams-per-blister standard", () => {
    const r = standardSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      materialRole: "PVC",
      expectedGramsPerBlister: 5.5,
      setupWasteGrams: 100,
      changeoverWasteGrams: 50,
      effectiveFrom: "2026-05-07",
    });
    expect(r.success).toBe(true);
  });
  it("accepts blisters-per-kg standard", () => {
    const r = standardSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      materialRole: "FOIL",
      expectedBlistersPerKg: 200,
      setupWasteGrams: 0,
      changeoverWasteGrams: 0,
      effectiveFrom: "2026-05-07",
    });
    expect(r.success).toBe(true);
  });
});

const countReceiveSchema = z.object({
  packagingMaterialId: z.string().uuid(),
  qtyReceived: z.coerce.number().int().min(1),
  uom: z.string().min(1),
});

describe("count receive schema", () => {
  it("rejects zero quantity", () => {
    const r = countReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      qtyReceived: 0,
      uom: "each",
    });
    expect(r.success).toBe(false);
  });
  it("rejects negative quantity", () => {
    const r = countReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      qtyReceived: -1,
      uom: "each",
    });
    expect(r.success).toBe(false);
  });
  it("rejects empty unit", () => {
    const r = countReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      qtyReceived: 100,
      uom: "",
    });
    expect(r.success).toBe(false);
  });
  it("accepts a valid receive", () => {
    const r = countReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      qtyReceived: 100,
      uom: "each",
    });
    expect(r.success).toBe(true);
  });
});

const rollReceiveSchema = z
  .object({
    packagingMaterialId: z.string().uuid(),
    rollNumber: z.string().min(1).max(80),
    grossWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    tareWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    netWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    weightUnit: z.enum(["g", "kg", "lb"]),
  })
  .refine(
    (d) =>
      (d.grossWeightGrams != null && d.tareWeightGrams != null) ||
      (d.netWeightGrams != null && d.netWeightGrams > 0),
    {
      message: "Need gross+tare or net",
      path: ["netWeightGrams"],
    },
  );

describe("roll receive schema", () => {
  it("rejects empty roll number", () => {
    const r = rollReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      rollNumber: "",
      grossWeightGrams: 5000,
      tareWeightGrams: 200,
      weightUnit: "g",
    });
    expect(r.success).toBe(false);
  });
  it("rejects with neither gross+tare nor net", () => {
    const r = rollReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      rollNumber: "PVC-1",
      weightUnit: "g",
    });
    expect(r.success).toBe(false);
  });
  it("accepts gross + tare", () => {
    const r = rollReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      rollNumber: "PVC-1",
      grossWeightGrams: 5000,
      tareWeightGrams: 200,
      weightUnit: "g",
    });
    expect(r.success).toBe(true);
  });
  it("accepts direct net only", () => {
    const r = rollReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      rollNumber: "PVC-1",
      netWeightGrams: 4800,
      weightUnit: "g",
    });
    expect(r.success).toBe(true);
  });
  it("rejects net = 0", () => {
    const r = rollReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      rollNumber: "PVC-1",
      netWeightGrams: 0,
      weightUnit: "g",
    });
    expect(r.success).toBe(false);
  });
  it("rejects invalid weight unit", () => {
    const r = rollReceiveSchema.safeParse({
      packagingMaterialId: "00000000-0000-0000-0000-000000000001",
      rollNumber: "PVC-1",
      netWeightGrams: 4800,
      weightUnit: "tons",
    });
    expect(r.success).toBe(false);
  });
});
