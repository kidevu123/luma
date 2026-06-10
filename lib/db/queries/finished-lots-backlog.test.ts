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
//   3. The Production Output page exposes per-row + bulk auto-issue
//      and labels the units column "Sellable units".

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const finishedLotsSrc = readFileSync(join(__dirname, "finished-lots.ts"), "utf8");
const pageSrc = readFileSync(
  join(__dirname, "../../../app/(admin)/packaging-output/page.tsx"),
  "utf8",
);
const actionsSrc = readFileSync(
  join(__dirname, "../../../app/(admin)/packaging-output/actions.ts"),
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
      "MISSING_COUNTS",
      "EXCLUDED_FROM_OUTPUT",
      "LOT_NUMBER_CONFLICT",
    ]) {
      expect(finishedLotsSrc).toContain(reason);
    }
  });

  it("wrong-route/voided bags are excluded from auto-issue", () => {
    const idx = finishedLotsSrc.indexOf("evaluateBacklogAutoIssueForWorkflowBag");
    const block = finishedLotsSrc.slice(idx, idx + 6000);
    expect(block).toMatch(/excludedFromOutput/);
    expect(block).toMatch(/EXCLUDED_FROM_OUTPUT/);
  });
});

describe("closeout precedes lot issuance (generalized)", () => {
  it("auto-create blocks when the bag has no allocation session at all", () => {
    const idx = finishedLotsSrc.indexOf(
      "export async function autoCreateAndReleaseFinishedLotForWorkflowBag",
    );
    const block = finishedLotsSrc.slice(idx, idx + 4000);
    expect(block).toMatch(/MISSING_ALLOCATION_SESSION/);
    expect(block).toMatch(/sessions\.length === 0/);
    expect(block).toMatch(/OPEN_ALLOCATION_SESSION/);
  });
});

describe("Production Output backlog tooling", () => {
  it("page renders per-row readiness + bulk auto-issue", () => {
    expect(pageSrc).toMatch(/evaluateBacklogAutoIssueForWorkflowBag/);
    expect(pageSrc).toMatch(/AutoIssueAllButton/);
    expect(pageSrc).toMatch(/IssueLotButton/);
    // Blocked rows keep the manual review escape hatch.
    expect(pageSrc).toMatch(/Review \/ issue lot/);
  });

  it('ambiguous "Units" column renamed to "Sellable units"', () => {
    expect(pageSrc).toMatch(/Sellable units/);
    expect(pageSrc).not.toMatch(/>Units</);
  });

  it("bulk sweep is sequential and reports blockers instead of swallowing them", () => {
    expect(actionsSrc).toMatch(/for \(const row of backlog\)/);
    expect(actionsSrc).toMatch(/blocked: results\.filter\(\(r\) => !r\.ok\)\.length/);
    expect(actionsSrc).toMatch(/requireAdmin/);
  });
});
