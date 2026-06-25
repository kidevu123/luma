// P0-LOT-BACKLOG — "Needs lot review" backlog auto-issue contract.
//
// Pins:
//   1. The backlog evaluator surfaces EXPLICIT blockers (missing
//      receipt / product / shelf life / packaging structure /
//      allocation session / counts / wrong-route exclusion) instead of
//      forcing manual review per row.
//   2. The live auto-issue path refuses lots without a closed
//      allocation session (closeout precedes issuance) — generalized,
//      not a one-off script.
//   3. The Production Output page exposes per-row eligibility + next-step
//      actions and labels the units column "Sellable units".

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const finishedLotsSrc = readFileSync(join(__dirname, "finished-lots.ts"), "utf8");
const eligibilitySrc = readFileSync(
  join(__dirname, "../../production/auto-lot-backlog-eligibility.ts"),
  "utf8",
);
const pageSrc = readFileSync(
  join(__dirname, "../../../app/(admin)/packaging-output/page.tsx"),
  "utf8",
);
const backlogActionsSrc = readFileSync(
  join(__dirname, "../../../app/(admin)/packaging-output/backlog-row-actions.tsx"),
  "utf8",
);

describe("backlog evaluator blockers are explicit", () => {
  it("covers every required blocker class", () => {
    for (const reason of [
      "MISSING_PRODUCT",
      "MISSING_RECEIPT_NUMBER",
      "MISSING_SHELF_LIFE",
      "MISSING_PACKAGING_STRUCTURE",
      "OPEN_ALLOCATION_SESSION",
      "MISSING_ALLOCATION_SESSION",
      "MISSING_OUTPUT_QUANTITY",
      "LOT_NUMBER_CONFLICT",
    ]) {
      expect(finishedLotsSrc + eligibilitySrc).toContain(reason);
    }
  });

  it("wrong-route/voided bags are excluded from auto-issue", () => {
    const idx = eligibilitySrc.indexOf("export function evaluateAutoLotBacklogRow");
    const block = eligibilitySrc.slice(idx, idx + 8000);
    expect(block).toMatch(/excludedFromOutput/);
    expect(block).toMatch(/MANUAL_REVIEW_REQUIRED/);
  });
});

describe("closeout precedes lot issuance (generalized)", () => {
  it("repair auto-issue uses eligibility guard before issuing", () => {
    expect(finishedLotsSrc).toMatch(/repairAutoIssueFinishedLotForWorkflowBag/);
    expect(finishedLotsSrc).toMatch(/assertAutoLotRepairAllowed/);
    expect(finishedLotsSrc).toMatch(/closeAllocationForProductionOutputInTx/);
  });
});

describe("Production Output backlog tooling", () => {
  it("page renders per-row eligibility + next-step actions", () => {
    expect(pageSrc).toMatch(/listProductionOutputBacklogWithEligibility/);
    expect(pageSrc).toMatch(/BacklogStatusChip/);
    expect(pageSrc).toMatch(/BacklogRowActions/);
    expect(pageSrc).toMatch(/Next step/);
    expect(pageSrc).toMatch(/Auto-issue status/);
  });

  it('ambiguous "Units" column renamed to "Sellable units"', () => {
    expect(pageSrc).toMatch(/Sellable units/);
    expect(pageSrc).not.toMatch(/>Units</);
  });

  it("per-row auto-issue uses the live repair path", () => {
    expect(backlogActionsSrc).toMatch(/repairAutoIssueFinishedLotAction/);
    expect(backlogActionsSrc).toMatch(/AUTO_ISSUE_NOW/);
  });
});
