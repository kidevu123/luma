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

describe("OPEN-ALLOCATION-GUARD-1 — createFinishedLotInTx refuses an open allocation on ALL input modes", () => {
  it("checks for an OPEN allocation session before the insert, for any input mode (explicit + derived)", () => {
    // The guard runs at the top of createFinishedLotInTx, gated only on
    // workflowBagId + not-skipped — so explicit inputs no longer bypass it
    // (the gap behind lot 352267).
    const fnStart = querySrc.indexOf("export async function createFinishedLotInTx");
    const insertAt = querySrc.indexOf(".insert(finishedLots)", fnStart);
    const guardAt = querySrc.indexOf('eq(rawBagAllocationSessions.allocationStatus, "OPEN")', fnStart);
    expect(guardAt).toBeGreaterThan(fnStart);
    // Guard precedes the insert → no dangling lot row is created when it throws.
    expect(guardAt).toBeLessThan(insertAt);
    const guardBlock = querySrc.slice(fnStart, insertAt);
    expect(guardBlock).toMatch(/input\.workflowBagId && !options\?\.skipOpenAllocationSessionCheck/);
    expect(guardBlock).toMatch(/open allocation session/);
  });

  it("the coordinated + auto paths set skipOpenAllocationSessionCheck (they close the session in-tx)", () => {
    // Both allocation-closing callers must skip the guard, else they'd throw on
    // the still-open session they are about to close.
    const skips = querySrc.match(/skipOpenAllocationSessionCheck: true/g) ?? [];
    expect(skips.length).toBeGreaterThanOrEqual(1); // auto path in this file
  });

  it("exposes a read-only detector for lots with an open allocation (no mutation)", () => {
    expect(querySrc).toContain("export async function listFinishedLotsWithOpenAllocation");
    const fnStart = querySrc.indexOf("export async function listFinishedLotsWithOpenAllocation");
    const body = querySrc.slice(fnStart, fnStart + 900);
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
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
