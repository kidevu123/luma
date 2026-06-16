// Source-level contract tests for the production-output staging
// buttons. We assert the visibility/disabled rules by reading the
// component source (the same pattern sidebar.test.ts uses), so the
// tests run fast and don't need a React renderer or DB.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "staging-buttons.tsx"), "utf8");

describe("ProductionOutputStagingButtons — visibility matrix", () => {
  it("imports the five server actions and no others (no legacy queue or commit-by-id)", () => {
    expect(src).toMatch(/approveProductionOutputForAutoCommit/);
    expect(src).toMatch(/approveAndCommitProductionOutputNow/);
    expect(src).toMatch(/holdProductionOutputOp/);
    expect(src).toMatch(/unholdProductionOutputOp/);
    expect(src).toMatch(/voidProductionOutputOpAction/);
    // Legacy actions explicitly NOT imported here.
    expect(src).not.toMatch(/queueProductionOutputOpAction\b/);
    expect(src).not.toMatch(/processProductionOutputOpAction\b/);
  });

  it("Approve buttons are gated on isCommittable (not held / not voided / status in COMMITTABLE_STATUSES)", () => {
    expect(src).toMatch(/const isCommittable =\s*!isHeld\s*&&\s*!isVoided/);
    expect(src).toMatch(
      /COMMITTABLE_STATUSES = new Set\(\[\s*"DRAFT"[\s\S]+"PREVIEWED"[\s\S]+"APPROVED"[\s\S]+"QUEUED"[\s\S]+"FAILED"/,
    );
  });

  it("Hold is hidden when the row is already held, voided, committed, or in-flight", () => {
    expect(src).toMatch(
      /\{!isHeld\s*&&\s*!isVoided\s*&&\s*row\.status\s*!==\s*"COMMITTED"\s*&&\s*row\.status\s*!==\s*"COMMITTING"\s*\?[\s\S]+confirmAndRun[\s\S]+holdProductionOutputOp/,
    );
  });

  it("Unhold is visible only when heldAt is set", () => {
    expect(src).toMatch(/\{isHeld\s*\?[\s\S]+unholdProductionOutputOp/);
  });

  it("Void is hidden once voided, committed, or in-flight", () => {
    expect(src).toMatch(
      /\{!isVoided\s*&&\s*row\.status\s*!==\s*"COMMITTED"\s*&&\s*row\.status\s*!==\s*"COMMITTING"\s*\?[\s\S]+voidProductionOutputOpAction/,
    );
  });

  it("NEEDS_REVIEW renders a business-decision message", () => {
    expect(src).toMatch(/Business decision required/);
    expect(src).toMatch(/row\.status\s*===\s*"NEEDS_REVIEW"/);
  });

  it("NEEDS_MAPPING renders a mapping/config message, distinct from NEEDS_REVIEW", () => {
    expect(src).toMatch(/Mapping \/ config missing/);
    expect(src).toMatch(/row\.status\s*===\s*"NEEDS_MAPPING"/);
  });

  it("NEEDS_REVIEW and NEEDS_MAPPING are listed in TERMINAL_OR_BLOCKED (no commit action)", () => {
    expect(src).toMatch(
      /TERMINAL_OR_BLOCKED = new Set\(\[\s*"COMMITTED"[\s\S]+"COMMITTING"[\s\S]+"NEEDS_MAPPING"[\s\S]+"NEEDS_REVIEW"/,
    );
  });

  it("auto-commit ETA copy renders for QUEUED rows with autoCommitEligibleAt", () => {
    expect(src).toMatch(/Auto-commit at \{row\.autoCommitEligibleAt/);
  });

  it("auto-commit-disabled copy renders for QUEUED rows without autoCommitEligibleAt", () => {
    expect(src).toMatch(/Auto-commit disabled — use “Commit now”/);
  });

  it("the row type carries all the staging columns the actions need", () => {
    expect(src).toMatch(/heldAt:\s*Date \| null/);
    expect(src).toMatch(/voidedAt:\s*Date \| null/);
    expect(src).toMatch(/autoCommitEligibleAt:\s*Date \| null/);
    expect(src).toMatch(/mappingBlockers:\s*Array<\{ code: string; message: string \}>/);
  });
});
