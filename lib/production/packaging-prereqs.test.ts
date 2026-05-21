import { describe, it, expect } from "vitest";
import { checkPackagingPrereqs } from "./packaging-prereqs";

describe("PRD-2: packaging completion prereq guard", () => {
  it("rejects when workflow_bag.product_id is null", () => {
    const r = checkPackagingPrereqs({
      bag: { id: "8a08c639", productId: null },
      product: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Product not selected/);
  });

  it("rejects when product is missing (referenced row not found)", () => {
    const r = checkPackagingPrereqs({
      bag: { id: "8a08c639", productId: "ghost-product-uuid" },
      product: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/product that was not found/);
  });

  it("rejects when product.units_per_display is null", () => {
    const r = checkPackagingPrereqs({
      bag: { id: "bag-1", productId: "p-1" },
      product: {
        id: "p-1",
        name: "Energy 4ct",
        sku: "ENERGY-4",
        unitsPerDisplay: null,
        displaysPerCase: 12,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/units per display/);
      expect(r.reason).toMatch(/ENERGY-4/);
    }
  });

  it("rejects when product.displays_per_case is null", () => {
    const r = checkPackagingPrereqs({
      bag: { id: "bag-1", productId: "p-1" },
      product: {
        id: "p-1",
        name: "Energy 4ct",
        sku: "ENERGY-4",
        unitsPerDisplay: 24,
        displaysPerCase: null,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/displays per case/);
  });

  it("rejects when both structure fields are null and lists both", () => {
    const r = checkPackagingPrereqs({
      bag: { id: "bag-1", productId: "p-1" },
      product: {
        id: "p-1",
        name: null,
        sku: null,
        unitsPerDisplay: null,
        displaysPerCase: null,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/units per display/);
      expect(r.reason).toMatch(/displays per case/);
    }
  });

  it("allows when product is set and structure is complete", () => {
    const r = checkPackagingPrereqs({
      bag: { id: "bag-1", productId: "p-1" },
      product: {
        id: "p-1",
        name: "Energy 4ct",
        sku: "ENERGY-4",
        unitsPerDisplay: 24,
        displaysPerCase: 12,
      },
    });
    expect(r.ok).toBe(true);
  });

  it("never returns 'ok' when there is no product (regression: silent zero-yield bug)", () => {
    // The bug we're fixing: a null product would silently produce
    // unitsYielded=0 in the projector. This is the inverse — verify
    // we never approve a null-product packaging.
    for (const productId of [null, "" as unknown as null]) {
      const r = checkPackagingPrereqs({
        bag: { id: "bag", productId: productId as null },
        product: null,
      });
      expect(r.ok).toBe(false);
    }
  });
});
