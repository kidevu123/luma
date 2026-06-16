// Source-level contract tests for the raw-bag staging buttons.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "staging-buttons.tsx"), "utf8");

describe("RawBagStagingButtons — visibility matrix", () => {
  it("imports the four server actions, none of the production-output ones", () => {
    expect(src).toMatch(/commitNowRawBagReceiveOp/);
    expect(src).toMatch(/holdRawBagReceiveOp/);
    expect(src).toMatch(/unholdRawBagReceiveOp/);
    expect(src).toMatch(/voidRawBagReceiveOp/);
    expect(src).not.toMatch(/approveProductionOutputForAutoCommit/);
    expect(src).not.toMatch(/sharedCommitProductionOutputOp/);
  });

  it("Commit-now button is gated on isCommittable (not held / not voided / in COMMITTABLE_STATUSES)", () => {
    expect(src).toMatch(/const isCommittable =\s*!isHeld\s*&&\s*!isVoided/);
    expect(src).toMatch(
      /COMMITTABLE_STATUSES = new Set\(\[\s*"PENDING"[\s\S]+"PREVIEWED"[\s\S]+"FAILED"/,
    );
  });

  it("NEEDS_REVIEW + over-receive routes to the OversResolutionPanel (decision copy lives in the panel)", () => {
    // v1.2.0 moved the static "exceeds the remaining PO line quantity"
    // copy out of staging-buttons.tsx and into the OversResolutionPanel
    // component, which renders only for NEEDS_REVIEW + over-receive.
    // staging-buttons must still IMPORT the panel and route to it via
    // OVER_RECEIVE_BLOCKER_CODE; the actual copy is asserted by the
    // overs-resolution-contract test file.
    expect(src).toMatch(/OVER_RECEIVE_BLOCKER_CODE/);
    expect(src).toMatch(/OversResolutionPanel/);
    // Sanity: the non-over-receive NEEDS_REVIEW branch is the plain
    // notice (still rendered by staging-buttons itself).
    expect(src).toMatch(/Business decision required/);
  });

  it("NEEDS_MAPPING renders a mapping-fix message distinct from NEEDS_REVIEW", () => {
    expect(src).toMatch(/Mapping \/ config missing/);
    expect(src).toMatch(/The buffer does not auto-retry until/);
  });

  it("Commit-now is hidden when held / voided / not in committable status", () => {
    // The button only renders inside the isCommittable branch.
    expect(src).toMatch(/\{isCommittable\s*\?[\s\S]+commitNowRawBagReceiveOp/);
  });

  it("Unhold is visible only when heldAt is set", () => {
    expect(src).toMatch(/\{isHeld\s*\?[\s\S]+unholdRawBagReceiveOp/);
  });

  it("Hold is hidden when already held, voided, committed, or in-flight", () => {
    expect(src).toMatch(
      /\{!isHeld\s*&&\s*!isVoided\s*&&\s*row\.status\s*!==\s*"COMMITTED"\s*&&\s*row\.status\s*!==\s*"COMMITTING"\s*\?[\s\S]+confirmAndRun[\s\S]+holdRawBagReceiveOp/,
    );
  });

  it("Auto-commit eligibility copy renders for PENDING rows", () => {
    expect(src).toMatch(/Auto-commit at \{row\.autoCommitEligibleAt/);
    expect(src).toMatch(/Auto-commit disabled/);
  });

  it("Voided rows surface the void status (not the buttons)", () => {
    expect(src).toMatch(/Voided — will not be sent/);
  });

  it("Committed rows surface the already-committed status", () => {
    expect(src).toMatch(/Already committed to Zoho/);
  });
});
