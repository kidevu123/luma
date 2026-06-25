// ZOHO-LIVE-COMMIT-ELIGIBILITY-GUARD — module is complete but not yet
// wired into queue UI pages (comments only). Forbid importing it from
// production routes until wiring lands; tests may import directly.

import { describe, expect, it } from "vitest";
import { grepRepo, readRepoSource } from "@/lib/test/source-scan";

describe("zoho-live-commit-eligibility unwired guard", () => {
  it("has no app/ importers until queue pages wire it in", () => {
    const refs = grepRepo("zoho-live-commit-eligibility", { includes: ["*.ts", "*.tsx"] });
    const appImporters = refs.filter((line) => {
      if (!line.startsWith("app/")) return false;
      const content = line.replace(/^[^:]+:\d+:/, "");
      if (content.trimStart().startsWith("//") || content.trimStart().startsWith("*")) {
        return false;
      }
      return /\bfrom\s+["']@\/lib\/zoho\/zoho-live-commit-eligibility["']/.test(content);
    });
    expect(
      appImporters,
      `Unexpected app importer before UI wiring.\n${appImporters.join("\n")}`,
    ).toEqual([]);
  });

  it("module still exports evaluateLiveCommitEligibility", () => {
    const file = readRepoSource("lib/zoho/zoho-live-commit-eligibility.ts");
    expect(file).toMatch(/export function evaluateLiveCommitEligibility/);
  });
});
