// Production output queue — receipt display wiring.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const pageSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "page.tsx"),
  "utf8",
);

describe("packaging-output page receipt wiring", () => {
  it("loads backlog rows with eligibility evaluation", () => {
    expect(pageSrc).toContain("listProductionOutputBacklogWithEligibility");
    expect(pageSrc).toContain("BacklogStatusChip");
    expect(pageSrc).toContain("BacklogRowActions");
  });

  it("shows auto-issue status and next step columns", () => {
    expect(pageSrc).toContain("Auto-issue status");
    expect(pageSrc).toContain("Next step");
    expect(pageSrc).toContain("bag.evaluation.label");
    expect(pageSrc).toContain("bag.evaluation.nextStep");
  });

  it("gates row mutations to lead roles", () => {
    expect(pageSrc).toContain('LEAD_ROLES.has(user.role)');
    expect(pageSrc).toContain("canMutate={canMutate}");
  });

  it("labels finalized bags without lots as actionable backlog", () => {
    expect(pageSrc).toContain("Finalized — awaiting lot");
    expect(pageSrc).toContain("exact blocker");
  });
});
