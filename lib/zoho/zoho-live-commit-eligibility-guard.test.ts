// ZOHO-LIVE-COMMIT-ELIGIBILITY-GUARD — module is complete but not yet
// wired into queue UI pages (comments only). Forbid importing it from
// production routes until wiring lands; tests may import directly.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");

function grepImporters(): string[] {
  let out = "";
  try {
    out = execSync(
      `grep -rEn "zoho-live-commit-eligibility" --include="*.ts" --include="*.tsx" .`,
      {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return [];
    out = e.stdout ?? "";
  }
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.includes("node_modules/"))
    .map((line) => (line.startsWith("./") ? line.slice(2) : line));
}

describe("zoho-live-commit-eligibility unwired guard", () => {
  it("has no app/ importers until queue pages wire it in", () => {
    const refs = grepImporters();
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
    const file = execSync(`cat "${resolve(REPO, "lib/zoho/zoho-live-commit-eligibility.ts")}"`, {
      encoding: "utf8",
    });
    expect(file).toMatch(/export function evaluateLiveCommitEligibility/);
  });
});
