// AUTO-QC-RELEASE-1 + v1.18.1 RETURNED_TO_STOCK eligibility fix.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  classifyFinishedLotReleaseEligibility,
  type FinishedLotReleaseEligibilityInput,
} from "./finished-lot-release-eligibility";
import {
  TERMINAL_ALLOCATION_STATUSES,
  resolveNewSessionStartingBalance,
} from "./bag-allocation";

// ── Part A — RETURNED_TO_STOCK terminal-session accuracy ─────────────

describe("v1.18.1 — RETURNED_TO_STOCK is a terminal allocation status", () => {
  it("the shared terminal set includes CLOSED, RETURNED_TO_STOCK, and DEPLETED", () => {
    expect([...TERMINAL_ALLOCATION_STATUSES].sort()).toEqual(
      ["CLOSED", "DEPLETED", "RETURNED_TO_STOCK"].sort(),
    );
  });

  it("a returned-to-stock ending balance drives the reused starting balance (no over-consumption)", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: {
        id: "s1",
        allocationStatus: "RETURNED_TO_STOCK",
        endingBalanceQty: 3598,
        startingBalanceQty: 7197,
        consumedQty: 3599,
        endingBalanceSource: "SUPERVISOR_ESTIMATE",
      },
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(3598); // not 7197
    expect(r.startingBalance).toBeGreaterThanOrEqual(0); // never negative
  });

  const backlogSrc = readFileSync(join(process.cwd(), "lib/db/queries/production-output-backlog.ts"), "utf8");
  const finishedLotsSrc = readFileSync(join(process.cwd(), "lib/db/queries/finished-lots.ts"), "utf8");

  it("the backlog + auto-issue eligibility lookups use the full terminal set (not CLOSED/DEPLETED only)", () => {
    expect(backlogSrc).toMatch(/\.\.\.TERMINAL_ALLOCATION_STATUSES/);
    expect(backlogSrc).not.toMatch(/allocationStatus, \["CLOSED", "DEPLETED"\]/);
    // Both eligibility + create balance inferences in finished-lots use it.
    const uses = finishedLotsSrc.match(/\.\.\.TERMINAL_ALLOCATION_STATUSES/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    // The Zoho consumed-session LINK stays CLOSED/DEPLETED (returned != consumed).
    expect(finishedLotsSrc).toMatch(/allocationStatus, \["CLOSED", "DEPLETED"\]/);
  });
});

// ── Part B/C — finished-lot release eligibility (pure, fail closed) ──

const clean: FinishedLotReleaseEligibilityInput = {
  found: true,
  lotStatus: "PENDING_QC",
  workflowBagId: "wb-1",
  workflowFinalized: true,
  productId: "p-1",
  unitsPerDisplay: 6,
  displaysPerCase: 12,
  tabletsPerUnit: 4,
  unitsProduced: 864,
  finishedLotNumber: "PO123-R1-B2-7",
  isOnHold: false,
  reworkPending: false,
  hasCorrection: false,
  excludedFromOutput: false,
  recoveryFlagged: false,
  qcEventCount: 0,
  openAllocationOnSource: false,
  lotNumberConflict: false,
};

describe("classifyFinishedLotReleaseEligibility — clean + terminal states", () => {
  it("a clean PENDING_QC lot is AUTO_RELEASE_READY", () => {
    const r = classifyFinishedLotReleaseEligibility(clean);
    expect(r.status).toBe("AUTO_RELEASE_READY");
    expect(r.code).toBe("READY");
  });
  it("not found → NOT_FOUND", () => {
    expect(classifyFinishedLotReleaseEligibility({ ...clean, found: false }).status).toBe("NOT_FOUND");
  });
  it("already RELEASED → ALREADY_RELEASED", () => {
    expect(classifyFinishedLotReleaseEligibility({ ...clean, lotStatus: "RELEASED" }).status).toBe("ALREADY_RELEASED");
  });
  it("non-pending (ON_HOLD/SHIPPED/RECALLED) → BLOCKED NOT_PENDING_QC", () => {
    for (const s of ["ON_HOLD", "SHIPPED", "RECALLED"]) {
      const r = classifyFinishedLotReleaseEligibility({ ...clean, lotStatus: s });
      expect(r.status).toBe("BLOCKED");
      expect(r.code).toBe("NOT_PENDING_QC");
    }
  });
});

describe("classifyFinishedLotReleaseEligibility — must NOT auto-release", () => {
  const cases: Array<[Partial<FinishedLotReleaseEligibilityInput>, string, string]> = [
    [{ lotNumberConflict: true }, "BLOCKED", "LOT_NUMBER_CONFLICT"],
    [{ excludedFromOutput: true }, "BLOCKED", "EXCLUDED_FROM_OUTPUT"],
    [{ workflowBagId: null }, "NEEDS_QC_REVIEW", "MISSING_WORKFLOW_BAG"],
    [{ workflowFinalized: false }, "BLOCKED", "WORKFLOW_NOT_FINALIZED"],
    [{ productId: null }, "BLOCKED", "MISSING_PRODUCT"],
    [{ isOnHold: true }, "NEEDS_QC_REVIEW", "ON_HOLD"],
    [{ reworkPending: true }, "NEEDS_QC_REVIEW", "REWORK_PENDING"],
    [{ hasCorrection: true }, "NEEDS_QC_REVIEW", "HAS_CORRECTION"],
    [{ recoveryFlagged: true }, "NEEDS_QC_REVIEW", "RECOVERY_FLAGGED"],
    [{ qcEventCount: 1 }, "NEEDS_QC_REVIEW", "QC_EVENT_PRESENT"],
    [{ openAllocationOnSource: true }, "NEEDS_QC_REVIEW", "OPEN_ALLOCATION_ON_SOURCE"],
    [{ tabletsPerUnit: null }, "NEEDS_QC_REVIEW", "INCOMPLETE_PRODUCT_SETUP"],
    [{ unitsProduced: 0 }, "NEEDS_QC_REVIEW", "MISSING_OUTPUT_COUNTS"],
    [{ finishedLotNumber: "" }, "NEEDS_QC_REVIEW", "MISSING_RECEIPT"],
  ];
  for (const [override, status, code] of cases) {
    it(`${code} → ${status}`, () => {
      const r = classifyFinishedLotReleaseEligibility({ ...clean, ...override });
      expect(r.status).toBe(status);
      expect(r.code).toBe(code);
    });
  }
});

// ── Structural — batch action + UI ──────────────────────────────────

const actionsSrc = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/actions.ts"), "utf8");
const pageSrc = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/page.tsx"), "utf8");
const buttonSrc = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/auto-release-all-button.tsx"), "utf8");

describe("autoReleaseAllSafeLotsAction — safe, idempotent, no Zoho", () => {
  it("lead-gated; releases only ready lots; re-checks eligibility per lot", () => {
    expect(actionsSrc).toMatch(/export async function autoReleaseAllSafeLotsAction/);
    expect(actionsSrc).toMatch(/autoReleaseAllSafeLotsAction[\s\S]{0,120}requireLead\(\)/);
    expect(actionsSrc).toMatch(/c\.evaluation\.status === "AUTO_RELEASE_READY"/);
    expect(actionsSrc).toMatch(/evaluateFinishedLotReleaseEligibility\(c\.finishedLotId\)/);
    expect(actionsSrc).toMatch(/AUTO_RELEASE_BATCH_CAP = 100/);
  });

  it("reuses the manual setFinishedLotStatus release path (identical audit/event/side-effects)", () => {
    expect(actionsSrc).toMatch(/setFinishedLotStatus\(\s*c\.finishedLotId,\s*"RELEASED"/);
  });

  it("writes an AUTO_QC_RELEASE batch audit and does NOT commit Zoho", () => {
    expect(actionsSrc).toMatch(/action: "finished_lot\.auto_release_batch"/);
    expect(actionsSrc).toMatch(/source: "AUTO_QC_RELEASE"/);
    expect(actionsSrc).toMatch(/zoho_output_committed: false/);
    const start = actionsSrc.indexOf("export async function autoReleaseAllSafeLotsAction");
    const body = actionsSrc.slice(start, start + 2600);
    expect(body).not.toMatch(/commitZoho|zohoProductionOutput|committed_at|commit\(/i);
  });
});

describe("Finished Lots page + button — clear QC statuses, manual release intact", () => {
  it("shows summary cards, auto-release button, and Zoho-separate copy", () => {
    expect(pageSrc).toMatch(/listFinishedLotReleaseCandidates/);
    expect(pageSrc).toMatch(/AutoReleaseAllButton/);
    expect(pageSrc).toMatch(/Auto-release ready/);
    expect(pageSrc).toMatch(/Needs QC review/);
    expect(pageSrc).toMatch(/auto-release\s*\n?\s*does not send anything to Zoho/);
    expect(pageSrc).toMatch(/Ready to auto-release/);
    // Per-lot detail link (manual Approve & release lives on the detail page).
    expect(pageSrc).toMatch(/\/finished-lots\/\$\{lot\.id\}/);
  });
  it("button confirms Zoho is not committed and reports released/skipped", () => {
    expect(buttonSrc).toMatch(/autoReleaseAllSafeLotsAction/);
    expect(buttonSrc).toMatch(/Zoho output is NOT committed/i);
    expect(buttonSrc).toMatch(/Released \{result\.released\}/);
  });
});

void vi;
