import { describe, expect, it } from "vitest";
import { grepRepo, grepRepoSymbol, readRepoSource } from "./source-scan";

describe("source-scan helpers", () => {
  it("REPO_ROOT resolves to the package root", () => {
    expect(readRepoSource("package.json")).toContain('"name": "luma"');
  });

  it("grepRepoSymbol finds a known export in a pinned module", () => {
    const hits = grepRepoSymbol("readRepoSource", {
      excludePathFragments: ["node_modules/", ".next/", "coverage/", "lib/test/source-scan.test.ts:"],
    });
    expect(hits.some((line) => line.startsWith("lib/test/source-scan.ts:"))).toBe(true);
  });

  it("grepRepo supports literal pattern search", () => {
    const hits = grepRepo("zoho-live-commit-eligibility", {
      includes: ["*.ts"],
      excludePathFragments: ["node_modules/", ".next/", "coverage/"],
    });
    expect(hits.some((line) => line.includes("zoho-live-commit-eligibility.ts"))).toBe(true);
  });

  it("returns an empty array when nothing matches", () => {
    expect(
      grepRepoSymbol("__luma_source_scan_no_match__", {
        excludePathFragments: [
          "node_modules/",
          ".next/",
          "coverage/",
          "lib/test/source-scan.test.ts:",
        ],
      }),
    ).toEqual([]);
  });
});
