// AUTO-ISSUE-BATCH-1 — batch "Auto-issue all safe lots". The eligibility rules
// themselves are covered by auto-lot-backlog-eligibility.test.ts; these tests
// cover the new categorization + the batch action / UI wiring (DB paths run
// against Postgres, so those are structural — no harness in the default run).

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// production-output-backlog imports @/lib/db at top level; stub it so the pure
// categorizer can be imported without a database.
vi.mock("@/lib/db", () => ({ db: {} }));

import { categorizeBacklogEvaluation } from "@/lib/db/queries/production-output-backlog";
import type { AutoLotBacklogEvaluation } from "@/lib/production/auto-lot-backlog-eligibility";

function evalOf(
  over: Partial<AutoLotBacklogEvaluation> & Pick<AutoLotBacklogEvaluation, "code" | "action" | "autoIssuable">,
): AutoLotBacklogEvaluation {
  return {
    label: "l",
    nextStep: "n",
    repairable: false,
    expectedConsumedQty: null,
    expectedEndingBalanceQty: null,
    productId: null,
    ...over,
  };
}

describe("categorizeBacklogEvaluation — 3 buckets", () => {
  it("READY_TO_AUTO_ISSUE → AUTO_ISSUE_READY", () => {
    expect(
      categorizeBacklogEvaluation(evalOf({ code: "READY_TO_AUTO_ISSUE", action: "AUTO_ISSUE_NOW", autoIssuable: true })),
    ).toBe("AUTO_ISSUE_READY");
  });

  it("fixable data issues → NEEDS_REVIEW", () => {
    expect(
      categorizeBacklogEvaluation(evalOf({ code: "MISSING_ALLOCATION_SESSION", action: "REPAIR_ALLOCATION", autoIssuable: false })),
    ).toBe("NEEDS_REVIEW");
    expect(
      categorizeBacklogEvaluation(evalOf({ code: "MISSING_TABLETS_PER_UNIT", action: "FIX_PRODUCT_SETUP", autoIssuable: false })),
    ).toBe("NEEDS_REVIEW");
  });

  it("manual-judgment blockers → BLOCKED", () => {
    for (const code of ["MISSING_PRODUCT", "NEGATIVE_ENDING_BALANCE", "LOT_NUMBER_CONFLICT", "MULTIPLE_SOURCE_BAGS_NEED_REVIEW"] as const) {
      expect(
        categorizeBacklogEvaluation(evalOf({ code, action: "REVIEW_MANUALLY", autoIssuable: false })),
      ).toBe("BLOCKED");
    }
  });
});

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const actionsSrc = repo("app/(admin)/finished-lots/actions.ts");
const backlogSrc = repo("lib/db/queries/production-output-backlog.ts");
const buttonSrc = repo("app/(admin)/packaging-output/auto-issue-all-button.tsx");

describe("autoIssueAllSafeLotsAction — reuses per-row service, safe + audited", () => {
  it("is lead-gated and issues ONLY autoIssuable rows via the per-row service", () => {
    expect(actionsSrc).toMatch(/export async function autoIssueAllSafeLotsAction/);
    expect(actionsSrc).toMatch(/const actor = await requireLead\(\)/);
    expect(actionsSrc).toMatch(/rows\.filter\(\(r\) => r\.evaluation\.autoIssuable\)/);
    // Reuses the idempotent, in-tx-re-checked per-row service — no bespoke create.
    expect(actionsSrc).toMatch(/repairAutoIssueFinishedLotForWorkflowBag\(row\.workflowBagId, actor\)/);
    // Bounded per invocation.
    expect(actionsSrc).toMatch(/AUTO_ISSUE_BATCH_CAP = 100/);
  });

  it("skips rows that raced/changed rather than force-creating", () => {
    expect(actionsSrc).toMatch(/skippedRows\.push\(/);
    // The batch never bypasses eligibility — it only calls the per-row service.
    const start = actionsSrc.indexOf("export async function autoIssueAllSafeLotsAction");
    const body = actionsSrc.slice(start, start + 2200);
    expect(body).not.toMatch(/ignoreEligibility|skipEligibility|createFinishedLotInTx/);
  });

  it("writes a batch audit with AUTO_FINISHED_LOT_ISSUE source and does NOT commit Zoho", () => {
    expect(actionsSrc).toMatch(/action: "finished_lot\.auto_issue_batch"/);
    expect(actionsSrc).toMatch(/source: "AUTO_FINISHED_LOT_ISSUE"/);
    expect(actionsSrc).toMatch(/zoho_output_committed: false/);
    // No Zoho commit call in the batch action body.
    const start = actionsSrc.indexOf("export async function autoIssueAllSafeLotsAction");
    const body = actionsSrc.slice(start, start + 2200);
    expect(body).not.toMatch(/commitZoho|zohoProductionOutput|committed_at|commit\(/i);
  });
});

describe("summary helper + button", () => {
  it("summarize categorizes and returns ready ids + top reasons", () => {
    expect(backlogSrc).toMatch(/export async function summarizeProductionOutputBacklog/);
    expect(backlogSrc).toMatch(/readyWorkflowBagIds/);
    expect(backlogSrc).toMatch(/topReasons/);
    expect(backlogSrc).toMatch(/capped: rows\.length >= cap/);
  });

  it("button confirms Zoho is not committed and reports issued/skipped", () => {
    expect(buttonSrc).toMatch(/autoIssueAllSafeLotsAction/);
    expect(buttonSrc).toMatch(/Zoho output is NOT committed/i);
    expect(buttonSrc).toMatch(/Issued \{result\.issued\}/);
    expect(buttonSrc).toMatch(/skipped/);
  });
});
