import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getSealingProductFilterHint } from "./workflow-bag-tablet-context";

const src = readFileSync(join(import.meta.dirname, "workflow-bag-tablet-context.ts"), "utf8");

describe("getSealingProductFilterHint", () => {
  it("returns null when tablet type is known", () => {
    expect(getSealingProductFilterHint("tt-1")).toBeNull();
  });

  it("explains unfiltered list when tablet type is unknown", () => {
    const hint = getSealingProductFilterHint(null);
    expect(hint).toMatch(/Tablet type is unknown/);
    expect(hint).toMatch(/all active card products/);
  });
});

describe("HANDPACK-TABLET-TYPE-SOURCE-1 · resolveWorkflowBagTabletTypeId paths", () => {
  it("Path 3: reads HANDPACK_BLISTER_COMPLETE event payload.tablet_type_id", () => {
    expect(src).toMatch(/HANDPACK_BLISTER_COMPLETE/);
    expect(src).toMatch(/'tablet_type_id'/);
    expect(src).toMatch(/fromHandpack/);
  });

  it("Path 3 is a fallback after paths 1 and 2", () => {
    const p1Idx = src.indexOf("inventory_bag_id");
    const p2Idx = src.indexOf("CARD_ASSIGNED");
    const p3Idx = src.indexOf("HANDPACK_BLISTER_COMPLETE");
    expect(p1Idx).toBeGreaterThan(-1);
    expect(p2Idx).toBeGreaterThan(p1Idx);
    expect(p3Idx).toBeGreaterThan(p2Idx);
  });

  it("hint text updated to mention hand-pack completion", () => {
    const hint = getSealingProductFilterHint(null);
    expect(hint).toMatch(/hand-pack completion/);
  });
});
