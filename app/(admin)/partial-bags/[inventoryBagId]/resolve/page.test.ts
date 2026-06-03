import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("partial-bags resolve page", () => {
  it("passes only serializable fields to the client resolve form", () => {
    const page = read("app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx");
    expect(page).not.toMatch(/ResolvePartialBagForm context=\{context\}/);
    expect(page).toMatch(/inventoryBagId: context\.inventoryBagId/);
    expect(page).toMatch(/declaredPillCount: context\.declaredPillCount/);
  });

  it("loads review context server-side and keeps dates on the server", () => {
    const page = read("app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx");
    expect(page).toMatch(/loadPartialBagReviewContext/);
    expect(page).toMatch(/fmtDate\(context\.partialSealingAt\)/);
    expect(page).toMatch(
      /ResolvePartialBagForm[\s\S]*inventoryBagId: context\.inventoryBagId[\s\S]*declaredPillCount: context\.declaredPillCount/,
    );
  });
});

describe("partial-bags list page", () => {
  it("handles null remaining source and confidence for Needs review rows", () => {
    const page = read("app/(admin)/partial-bags/page.tsx");
    expect(page).toMatch(/labelPartialBagEndingBalanceSource/);
    expect(page).toMatch(/row\.eligibility === "ready" && sourceLabel/);
    expect(page).toMatch(/remainingEstimate == null/);
    expect(page).toMatch(/Start run blocked/);
    expect(page).toMatch(/Resolve inventory/);
  });
});
