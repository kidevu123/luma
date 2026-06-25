// D-1 · CommitSource must have a single canonical definition in zoho-commit-notes.ts.

import { describe, expect, it } from "vitest";
import { readRepoSource } from "@/lib/test/source-scan";

describe("CommitSource dedup (D-1)", () => {
  it("canonical CommitSource lives only in zoho-commit-notes.ts", () => {
    expect(readRepoSource("lib/zoho/zoho-commit-notes.ts")).toMatch(
      /export type CommitSource = "manual" \| "auto"/,
    );
  });

  it("shared-raw-bag-receive-commit re-exports CommitSource instead of redefining it", () => {
    const src = readRepoSource("lib/zoho/shared-raw-bag-receive-commit.ts");
    expect(src).toMatch(/type CommitSource,\s*\n\s*type CommitTrigger,/);
    expect(src).toMatch(/export type \{ CommitSource \}/);
    expect(src).not.toMatch(/export type CommitSource = "manual" \| "auto"/);
  });

  it("shared-production-output-commit imports CommitSource instead of a parallel alias type", () => {
    const src = readRepoSource("lib/zoho/shared-production-output-commit.ts");
    expect(src).toMatch(/type CommitSource,/);
    expect(src).not.toMatch(/ProductionOutputCommitSource/);
    expect(src).not.toMatch(/export type CommitSource = "manual" \| "auto"/);
  });
});
