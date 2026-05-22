import { describe, it, expect } from "vitest";
import { hasCapacityData, sortCapacityRows } from "./capacity";

const base = {
  product: { name: "X" },
  tablets: 0,
  runnableUnits: null,
  runnableDisplays: null,
  runnableCases: null,
};

describe("hasCapacityData", () => {
  it("returns false when tablets 0 and all runnable fields null", () => {
    expect(hasCapacityData(base)).toBe(false);
  });

  it("returns false when runnableUnits is exactly 0 (configured, constrained)", () => {
    expect(hasCapacityData({ ...base, runnableUnits: 0 })).toBe(false);
  });

  it("returns false when all runnable are 0", () => {
    expect(
      hasCapacityData({ ...base, runnableUnits: 0, runnableDisplays: 0, runnableCases: 0 }),
    ).toBe(false);
  });

  it("returns true when tablets > 0", () => {
    expect(hasCapacityData({ ...base, tablets: 100 })).toBe(true);
  });

  it("returns true when runnableUnits > 0", () => {
    expect(hasCapacityData({ ...base, runnableUnits: 5 })).toBe(true);
  });

  it("returns true when runnableDisplays > 0", () => {
    expect(hasCapacityData({ ...base, runnableDisplays: 1 })).toBe(true);
  });

  it("returns true when runnableCases > 0", () => {
    expect(hasCapacityData({ ...base, runnableCases: 2 })).toBe(true);
  });
});

describe("sortCapacityRows", () => {
  it("returns empty array unchanged", () => {
    expect(sortCapacityRows([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const rows = [
      { ...base, product: { name: "B" } },
      { ...base, product: { name: "A" }, tablets: 1 },
    ];
    const origFirst = rows[0];
    sortCapacityRows(rows);
    expect(rows[0]).toBe(origFirst);
  });

  it("row with data sorts above all-zero row regardless of name order", () => {
    const noData = { ...base, product: { name: "Alpha" } }; // A comes first alphabetically
    const withData = { ...base, product: { name: "Zeta" }, tablets: 10 }; // Z comes last
    const result = sortCapacityRows([noData, withData]);
    expect(result[0]).toBe(withData);
    expect(result[1]).toBe(noData);
  });

  it("both rows with data: alphabetical by product name", () => {
    const beta = { ...base, product: { name: "Beta" }, runnableUnits: 3 };
    const alpha = { ...base, product: { name: "Alpha" }, tablets: 10 };
    const result = sortCapacityRows([beta, alpha]);
    expect(result[0]).toBe(alpha);
    expect(result[1]).toBe(beta);
  });

  it("both rows without data: alphabetical by product name", () => {
    const beta = { ...base, product: { name: "Beta" } };
    const alpha = { ...base, product: { name: "Alpha" } };
    const result = sortCapacityRows([beta, alpha]);
    expect(result[0]).toBe(alpha);
    expect(result[1]).toBe(beta);
  });

  it("mixed groups: has-data first (alphabetical), then no-data (alphabetical)", () => {
    const rows = [
      { ...base, product: { name: "Zephyr" } },
      { ...base, product: { name: "Alpha" }, tablets: 1 },
      { ...base, product: { name: "Delta" } },
      { ...base, product: { name: "Bravo" }, runnableUnits: 3 },
    ];
    const result = sortCapacityRows(rows);
    expect(result.map((r) => r.product.name)).toEqual(["Alpha", "Bravo", "Delta", "Zephyr"]);
  });

  it("runnableUnits 0 is treated as no data (stays in no-data group)", () => {
    const constrained = { ...base, product: { name: "A" }, runnableUnits: 0 };
    const real = { ...base, product: { name: "B" }, runnableUnits: 5 };
    const result = sortCapacityRows([constrained, real]);
    expect(result[0]).toBe(real);
    expect(result[1]).toBe(constrained);
  });
});
