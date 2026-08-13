import { describe, it, expect } from "vitest";
import { resolveProductChoice } from "./resolve-product-choice";
import type { ProductOption } from "./types";

const CHOCOLATE: ProductOption = {
  productId: "prod-1",
  name: "Chocolate Brown 30ct",
  sku: "CB-30",
};
const CHOCOLATE_60: ProductOption = {
  productId: "prod-2",
  name: "Chocolate Brown 60ct",
  sku: "CB-60",
};
const CHOCOLATE_TRIAL: ProductOption = {
  productId: "prod-3",
  name: "Chocolate Brown Trial",
  sku: "CB-TRIAL",
};

describe("resolveProductChoice", () => {
  it("returns NONE when no compatible product exists", () => {
    // Master data is wrong or the tablet type is unmapped. The operator
    // cannot fix that from the tablet, so nothing is offered.
    expect(resolveProductChoice([])).toEqual({ kind: "NONE" });
  });

  it("auto-resolves a single compatible product without asking", () => {
    expect(resolveProductChoice([CHOCOLATE])).toEqual({
      kind: "AUTO",
      productId: "prod-1",
    });
  });

  it("asks the operator when two or more products are compatible", () => {
    const out = resolveProductChoice([CHOCOLATE, CHOCOLATE_60]);
    expect(out.kind).toBe("PICK");
    if (out.kind === "PICK") {
      expect(out.options.map((o) => o.productId)).toEqual(["prod-1", "prod-2"]);
    }
  });

  it("preserves the loader's option order", () => {
    // Two callers must never show the same operator two different button
    // orders for the same bag.
    const out = resolveProductChoice([CHOCOLATE_TRIAL, CHOCOLATE, CHOCOLATE_60]);
    if (out.kind === "PICK") {
      expect(out.options.map((o) => o.sku)).toEqual(["CB-TRIAL", "CB-30", "CB-60"]);
    }
  });

  it("carries name and sku so the operator reads words, not ids", () => {
    const out = resolveProductChoice([CHOCOLATE, CHOCOLATE_60]);
    if (out.kind === "PICK") {
      expect(out.options[0]).toEqual({
        productId: "prod-1",
        name: "Chocolate Brown 30ct",
        sku: "CB-30",
      });
    }
  });

  it("does not hand back the caller's array", () => {
    // A pick that shares the loader's array would let a consumer mutate
    // the row data the view was built from.
    const input = [CHOCOLATE, CHOCOLATE_60];
    const out = resolveProductChoice(input);
    if (out.kind === "PICK") {
      expect(out.options).not.toBe(input);
      expect(out.options).toEqual(input);
    }
  });
});
