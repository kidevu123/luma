import { describe, it, expect } from "vitest";
import { sortCloseoutRows, listDistinctTablets, filterRowsByTablet } from "./closeout-row-sort";

const rows = [
  { receiptNumber: "R-2", tabletName: "Spearmint", startedAt: new Date("2026-06-02"), finalizedAt: null },
  { receiptNumber: "R-1", tabletName: "BlueRaz", startedAt: new Date("2026-06-03"), finalizedAt: new Date("2026-06-04") },
  { receiptNumber: null, tabletName: null, startedAt: null, finalizedAt: null },
];

describe("sortCloseoutRows", () => {
  it("sorts by receipt asc with nulls last, stable", () => {
    const out = sortCloseoutRows(rows, "receipt", "asc");
    expect(out.map((r) => r.receiptNumber)).toEqual(["R-1", "R-2", null]);
  });
  it("sorts by started desc with nulls last", () => {
    const out = sortCloseoutRows(rows, "started", "desc");
    expect(out.map((r) => r.receiptNumber)).toEqual(["R-1", "R-2", null]);
  });
  it("sorts by completed asc: dated rows first, null completions last", () => {
    const out = sortCloseoutRows(rows, "completed", "asc");
    expect(out[0]!.receiptNumber).toBe("R-1");
  });
  it("does not mutate the input array", () => {
    const copy = [...rows];
    sortCloseoutRows(rows, "tablet", "asc");
    expect(rows).toEqual(copy);
  });
});

describe("tablet filter", () => {
  it("lists distinct tablets alphabetically, skipping null", () => {
    expect(listDistinctTablets(rows)).toEqual(["BlueRaz", "Spearmint"]);
  });
  it("filters by exact tablet name; null filter returns all", () => {
    expect(filterRowsByTablet(rows, "BlueRaz")).toHaveLength(1);
    expect(filterRowsByTablet(rows, null)).toHaveLength(3);
  });
});
