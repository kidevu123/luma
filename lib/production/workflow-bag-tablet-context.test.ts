import { describe, it, expect } from "vitest";
import { getSealingProductFilterHint } from "./workflow-bag-tablet-context";

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
