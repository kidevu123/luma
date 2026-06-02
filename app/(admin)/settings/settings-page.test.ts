import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("BUG-UI-FIX-BATCH-1 · settings system info", () => {
  it("shows package semver as Release, not as git SHA", () => {
    expect(src).toMatch(/getBuildFooterParts/);
    expect(src).toMatch(/label="Release".*v\$\{build\.version\}/s);
    expect(src).toMatch(/label="Git SHA"/);
  });

  it("links shift review from workflow section", () => {
    expect(src).toMatch(/href="\/shift-review"/);
    expect(src).toMatch(/Shift review/);
  });
});
