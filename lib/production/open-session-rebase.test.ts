// REBASE-OPEN-SESSION-1 — the Resolve page can correct an OPEN session's wrong
// starting balance IN PLACE (keeping the run open for later production). The
// write path runs against Postgres (no harness in the default vitest run), so
// these are structural assertions on the service / action / page / button.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { hasRealProductionOutput } from "./open-session-rebase";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("hasRealProductionOutput — the sealed=0 rebase-blocker bug (v1.17.1)", () => {
  it("bag-card-104: a fresh run (no sealing) reports NO output even though sealedOutput is 0, not null", () => {
    // deriveStageOutputForBag returns sealedOutput 0 (COALESCE(...,0)+COALESCE(...,0))
    // for a run with no sealing events — the exact shape of run 4cb0ed2f.
    expect(
      hasRealProductionOutput({
        grossBlisters: null,
        sealedOutput: 0,
        packagedOutput: null,
        finishedOutput: null,
      }),
    ).toBe(false);
  });

  it("all-null / all-zero output → no output (eligible for rebase)", () => {
    expect(
      hasRealProductionOutput({ grossBlisters: null, sealedOutput: null, packagedOutput: null, finishedOutput: null }),
    ).toBe(false);
    expect(
      hasRealProductionOutput({ grossBlisters: 0, sealedOutput: 0, packagedOutput: 0, finishedOutput: 0 }),
    ).toBe(false);
  });

  it("any POSITIVE stage output → has output (rebase blocked)", () => {
    expect(hasRealProductionOutput({ grossBlisters: 5, sealedOutput: 0, packagedOutput: null, finishedOutput: null })).toBe(true);
    expect(hasRealProductionOutput({ grossBlisters: null, sealedOutput: 1656, packagedOutput: null, finishedOutput: null })).toBe(true);
    expect(hasRealProductionOutput({ grossBlisters: null, sealedOutput: 0, packagedOutput: 12, finishedOutput: null })).toBe(true);
    expect(hasRealProductionOutput({ grossBlisters: null, sealedOutput: 0, packagedOutput: null, finishedOutput: 3 })).toBe(true);
  });
});
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

  it("refuses to rebase a session that already has POSITIVE production output (0/null is not output)", () => {
    expect(service).toMatch(/deriveStageOutputForBag/);
    expect(service).toMatch(/reason: "HAS_PRODUCTION_OUTPUT"/);
    // Uses the shared > 0 helper, NOT a `!= null` check (sealedOutput is 0 for
    // a no-sealing run, which must not block the rebase).
    expect(service).toMatch(/hasRealProductionOutput\(output\)/);
    expect(service).not.toMatch(/sealedOutput != null/);
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
  it("computes rebase eligibility defensively and renders the button + spec copy when available", () => {
    expect(page).toMatch(/computeOpenSessionRebaseEligibility\(inventoryBagId\)/);
    expect(page).toMatch(/reason: "COMPUTE_FAILED"/);
    expect(page).toMatch(/rebase\?\.available \?/);
    expect(page).toMatch(/RebaseOpenSessionButton/);
    expect(page).toMatch(/Correct open session starting balance/);
    expect(page).toMatch(/opened from the original declared\s*\n?\s*count instead of the prior/);
    expect(page).toMatch(/Current start:[\s\S]*Corrected start:/);
  });

  it("NEVER shows a vague 'if offered' without an action or reason — shows the exact reason when ineligible", () => {
    expect(page).toMatch(/rebase && !rebase\.available \?/);
    expect(page).toMatch(/Starting-balance correction unavailable:/);
    expect(page).toMatch(/\{rebase\.message\}/);
    // The old dead-end wording (offering nothing) is gone.
    expect(page).not.toMatch(/Correct the open\s*\n?\s*session starting balance \(above, if offered\)/);
  });

  it("manual closeout warns that 'Correct remaining' closes the session", () => {
    expect(page).toMatch(/“Correct\s*\n?\s*remaining”\s*<span[^>]*>closes<\/span>/);
    expect(page).toMatch(/keep this run open for later/);
    expect(page).toMatch(/Each opens an inline form when\s*\n?\s*clicked/);
  });

  it("button confirms the session stays open and QR stays assigned; admin action", () => {
    expect(button).toMatch(/rebaseOpenSessionStartingBalanceAction/);
    expect(button).toMatch(/session stays OPEN/i);
    expect(button).toMatch(/QR stays assigned/i);
    expect(button).toMatch(/can still receive production numbers/i);
  });
});
