// REBASE-OPEN-SESSION-1 — the Resolve page can correct an OPEN session's wrong
// starting balance IN PLACE (keeping the run open for later production). The
// write path runs against Postgres (no harness in the default vitest run), so
// these are structural assertions on the service / action / page / button.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const service = repo("lib/production/open-session-rebase.ts");
const actions = repo("app/(admin)/partial-bags/actions.ts");
const page = repo("app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx");
const button = repo("app/(admin)/partial-bags/rebase-open-session-button.tsx");

describe("rebase service — eligibility gates (fails closed)", () => {
  it("only offers rebase for a single OPEN session with a prior returned balance", () => {
    expect(service).toMatch(/reason: "SESSION_NOT_OPEN"/);
    expect(service).toMatch(/reason: "MULTIPLE_OPEN_SESSIONS"/);
    expect(service).toMatch(/reason: "NO_PRIOR_TERMINAL_SESSION"/);
    expect(service).toMatch(/reason: "NO_PRIOR_RETURNED_BALANCE"/);
    expect(service).toMatch(/reason: "ALREADY_CORRECT"/);
    // Prior ending balance must be > 0.
    expect(service).toMatch(/endingBalanceQty <= 0/);
    // Current starting must differ from prior ending.
    expect(service).toMatch(/session\.startingBalanceQty === priorTerminal\.endingBalanceQty/);
  });

  it("refuses to rebase a session that already has production output", () => {
    expect(service).toMatch(/deriveStageOutputForBag/);
    expect(service).toMatch(/reason: "HAS_PRODUCTION_OUTPUT"/);
    expect(service).toMatch(/grossBlisters != null/);
    expect(service).toMatch(/packagedOutput != null/);
  });
});

describe("rebase service — the write keeps the session OPEN and touches nothing else", () => {
  it("updates starting balance + PRIOR_RETURNED_BALANCE source and leaves status OPEN", () => {
    expect(service).toMatch(/startingBalanceQty: eligibility\.newStartingBalance/);
    expect(service).toMatch(/startingBalanceSource: "PRIOR_RETURNED_BALANCE"/);
    // No status/closedAt/consumed change → session stays OPEN.
    expect(service).not.toMatch(/allocationStatus:\s*"(CLOSED|DEPLETED|RETURNED_TO_STOCK|VOIDED)"/);
    expect(service).not.toMatch(/closedAt:/);
  });

  it("does NOT release the QR, deplete, finalize, or change production counts", () => {
    expect(service).not.toMatch(/qrCards/);
    expect(service).not.toMatch(/status: "IDLE"/);
    expect(service).not.toMatch(/assignedWorkflowBagId/);
    expect(service).not.toMatch(/consumedQty:/);
    expect(service).not.toMatch(/finishedLotId/);
    expect(service).not.toMatch(/EMPTIED|DEPLETED/);
  });

  it("re-checks OPEN inside the transaction and writes a full audit + event", () => {
    expect(service).toMatch(/current\.allocationStatus !== "OPEN"/);
    expect(service).toMatch(/eventType: "RAW_BAG_ADJUSTED"/);
    expect(service).toMatch(/admin_correction: "rebase_open_session_starting_balance"/);
    expect(service).toMatch(/action: "raw_bag_allocation\.starting_balance_rebased"/);
    expect(service).toMatch(/old_starting_balance:/);
    expect(service).toMatch(/new_starting_balance:/);
    expect(service).toMatch(/prior_session_id:/);
    expect(service).toMatch(/session_left_open: true/);
  });
});

describe("rebase action — admin-gated", () => {
  it("requires admin and delegates to the shared service", () => {
    expect(actions).toMatch(/export async function rebaseOpenSessionStartingBalanceAction/);
    expect(actions).toMatch(/rebaseOpenSessionStartingBalanceAction[\s\S]{0,260}requireAdmin\(\)/);
    expect(actions).toMatch(/rebaseOpenSessionStartingBalance\(\{/);
  });
});

describe("resolve page + button — usable, keeps run open", () => {
  it("computes rebase eligibility defensively and renders the button when available", () => {
    expect(page).toMatch(/computeOpenSessionRebaseEligibility\(inventoryBagId\)/);
    expect(page).toMatch(/reason: "COMPUTE_FAILED"/);
    expect(page).toMatch(/rebase\?\.available \?/);
    expect(page).toMatch(/RebaseOpenSessionButton/);
    expect(page).toMatch(/Correct open session starting balance \(keeps the run open\)/);
  });

  it("fixes the misleading 'no production output' copy for a reused open session", () => {
    expect(page).toMatch(/This open session has no production output counts yet/);
    expect(page).toMatch(/belongs to an earlier run and is for traceability/);
  });

  it("button confirms the session stays open and QR stays assigned; admin action", () => {
    expect(button).toMatch(/rebaseOpenSessionStartingBalanceAction/);
    expect(button).toMatch(/session stays OPEN/i);
    expect(button).toMatch(/QR stays assigned/i);
    expect(button).toMatch(/can still receive production numbers/i);
  });
});
