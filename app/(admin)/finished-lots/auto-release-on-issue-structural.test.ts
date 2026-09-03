// SIMPLIFY-B — a cleanly issued lot should not need a separate release tap.
// Structural (DB paths need Postgres).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/actions.ts"), "utf8");

describe("auto-release on issue", () => {
  it("both manual issue paths evaluate release eligibility and release only AUTO_RELEASE_READY", () => {
    const matches = src.match(/maybeAutoReleaseOnIssue\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
    expect(src).toMatch(/status === "AUTO_RELEASE_READY"/);
    expect(src).toMatch(/Auto-released on issue/);
  });
  it("release failure is swallowed (never fails the issue)", () => {
    expect(src).toMatch(/maybeAutoReleaseOnIssue[\s\S]{0,600}catch/);
  });
});
