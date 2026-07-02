import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("RESOLVE-CLOSEOUT-ACTIONS-1 · resolve page exposes real closeout actions", () => {
  const page = read("app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx");

  it("renders actionable controls for an OPEN session (not a dead-end)", () => {
    // The open-session branch reuses the SAME workbench components/actions.
    expect(page).toMatch(/hasOpenSession \? \(/);
    expect(page).toMatch(/Close the open allocation session/);
    // Manual closeout is ALWAYS available for an open session.
    expect(page).toMatch(/PartialBagCorrectionMenu/);
    expect(page).toMatch(/Manual closeout/);
  });

  it("shows Use calculated remaining only when eligible, else a precise reason + manual fallback", () => {
    expect(page).toMatch(/systemDerived\?\.available \?/);
    expect(page).toMatch(/UseCalculatedRemainingButton/);
    expect(page).toMatch(/Calculated remaining unavailable/);
    expect(page).toMatch(/systemDerived\?\.message/);
    expect(page).toMatch(/Record a manual count \/ weigh-back \/ supervisor estimate/);
  });

  it("computes system-derived eligibility defensively (one failure can't crash the page)", () => {
    expect(page).toMatch(/computeSystemDerivedResolutionForBag\(inventoryBagId\)/);
    expect(page).toMatch(/catch \{[\s\S]*reason: "COMPUTE_FAILED"/);
  });

  it("no longer shows a floor/workbench dead-end; explains close-it-here", () => {
    expect(page).not.toMatch(/close it at the floor/i);
    expect(page).not.toMatch(/close it from the workbench/i);
    expect(page).toMatch(/open allocation session from the previous run/i);
    expect(page).toMatch(/Mark depleted only if the\s+physical bag is empty/);
  });

  it("keeps the missing-linkage new-session form for the non-open-session path", () => {
    expect(page).toMatch(/gate\.ok \? \(/);
    expect(page).toMatch(/ResolvePartialBagForm/);
  });
});

describe("eligibility copy — actionable, no 'at the floor' dead-end", () => {
  it("needs-closeout / missing-linkage notes point to the workbench, not the floor", () => {
    const src = read("lib/production/partial-bags.ts");
    expect(src).not.toMatch(/close or return remaining quantity at the floor/i);
    expect(src).not.toMatch(/Close allocation at the floor/i);
    expect(src).toMatch(/Open allocation session from the previous run/);
  });
});

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
  it("handles null remaining source and confidence honestly (workbench)", () => {
    // P1-PARTIAL: the workbench renders remaining quantities via the
    // honest formatter — unknowns say "closeout required" instead of a
    // fake integer; non-HIGH values carry their provenance.
    const page = read("app/(admin)/partial-bags/page.tsx");
    expect(page).toMatch(/labelPartialBagEndingBalanceSource/);
    expect(page).toMatch(/formatRemainingEstimate/);
    expect(page).toMatch(/remainingEstimate == null/);
    expect(page).toMatch(/Resolve inventory/);
  });
});
