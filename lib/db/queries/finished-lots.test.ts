import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveFinishedLotTabletQty } from "./finished-lots";

const querySrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "finished-lots.ts"),
  "utf8",
);

describe("resolveFinishedLotTabletQty", () => {
  it("returns consumedQty from a closed allocation session", () => {
    expect(
      resolveFinishedLotTabletQty(null, { consumedQty: 3000 }, 10000),
    ).toBe(3000);
  });

  it("returns consumedQty even when it is zero (full depletion recorded)", () => {
    expect(
      resolveFinishedLotTabletQty(null, { consumedQty: 0 }, 10000),
    ).toBe(0);
  });

  it("falls back to pillCount when no allocation session exists (legacy path)", () => {
    expect(
      resolveFinishedLotTabletQty(null, null, 10000),
    ).toBe(10000);
  });

  it("falls back to pillCount when session exists but consumedQty is null", () => {
    expect(
      resolveFinishedLotTabletQty(null, { consumedQty: null }, 10000),
    ).toBe(10000);
  });

  it("falls back to 0 when no session and no pillCount", () => {
    expect(
      resolveFinishedLotTabletQty(null, null, null),
    ).toBe(0);
  });

  it("throws when an OPEN allocation session exists", () => {
    expect(() =>
      resolveFinishedLotTabletQty({ id: "sess-open-1" }, null, 10000),
    ).toThrow("open allocation session");
  });

  it("throws on OPEN session even when a closed session also exists", () => {
    expect(() =>
      resolveFinishedLotTabletQty({ id: "sess-open-1" }, { consumedQty: 3000 }, 10000),
    ).toThrow("open allocation session");
  });
});

describe("listFinalizedBagsWithoutLot", () => {
  it("loads canonical receipt and packaging output metrics for issue-lot prefill", () => {
    expect(querySrc).toContain(
      "receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`",
    );
    expect(querySrc).toContain("masterCases: readBagMetrics.masterCases");
    expect(querySrc).toContain("displaysMade: readBagMetrics.displaysMade");
    expect(querySrc).toContain("looseCards: readBagMetrics.looseCards");
    expect(querySrc).toContain("unitsYielded: readBagMetrics.unitsYielded");
    expect(querySrc).toContain(
      "leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))",
    );
  });
});
