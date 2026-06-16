// OVERS-RESOLUTION-v1.2.0 — source-level contract tests.
//
// These pin the v1.2.0 invariants directly against the implementation
// source so the contract can't drift without the test failing. Same
// pattern as sidebar.test.ts / persistent-headers.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

const STAGING_ACTIONS = read(
  "app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/staging-actions.ts",
);
const STAGING_BUTTONS = read(
  "app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/staging-buttons.tsx",
);
const PANEL = read(
  "app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/overs-resolution-panel.tsx",
);
const FREEZE = read("lib/zoho/freeze-raw-bag-receive-payload.ts");
const SWEEP = read("lib/zoho/auto-commit-sweep.ts");
const SHARED_COMMIT = read("lib/zoho/shared-raw-bag-receive-commit.ts");

// ─── Migration 0065 shape ─────────────────────────────────────────

describe("migration 0065 — additive columns + index", () => {
  const SQL = read("drizzle/0065_zoho_raw_bag_overs_resolution.sql");

  it("adds the 6 expected columns (additive only)", () => {
    for (const col of [
      "overs_decision",
      "overs_decision_at",
      "overs_decision_by_user_id",
      "overs_decision_note",
      "adjusted_received_quantity",
      "parent_op_id",
    ]) {
      expect(SQL).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${col}"`));
    }
  });

  it("creates a partial index on overs_decision (for the awaiting-overs-PO queue)", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS "zoho_raw_bag_receives_overs_decision_idx"[\s\S]+WHERE "overs_decision" IS NOT NULL/,
    );
  });

  it("has no DROP / RENAME / destructive statements", () => {
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/\bRENAME\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("parent_op_id is a self-FK (forward stub for the v1.3.0+ split workflow)", () => {
    expect(SQL).toMatch(
      /"parent_op_id" uuid\s+REFERENCES "zoho_raw_bag_receives"\("id"\) ON DELETE SET NULL/,
    );
  });

  it("journal entry is registered", () => {
    const j = read("drizzle/meta/_journal.json");
    expect(j).toMatch(/"tag":\s*"0065_zoho_raw_bag_overs_resolution"/);
  });
});

// ─── State-machine invariants in the server action ────────────────

describe("resolveOversBlockerAction — state transitions match the design", () => {
  it("adjust_down transitions status to PENDING (re-arms for a fresh commit attempt)", () => {
    const slice = STAGING_ACTIONS.slice(
      STAGING_ACTIONS.indexOf("case \"adjust_down\":"),
      STAGING_ACTIONS.indexOf("case \"hold_for_po_update\":"),
    );
    expect(slice).toMatch(/zohoReceiveStatus:\s*"PENDING"/);
    // Adjusted quantity is persisted to BOTH the column (audit) and
    // the main zoho_received_quantity (so the freeze rebuilds with the
    // new value).
    expect(slice).toMatch(/adjustedReceivedQuantity:\s*d\.newQuantity/);
    expect(slice).toMatch(/zohoReceivedQuantity:\s*d\.newQuantity/);
    // Re-arming clears stale blocker / error state.
    expect(slice).toMatch(/mappingBlockers:\s*null/);
    expect(slice).toMatch(/commitError:\s*null/);
    // Freeze is called to mint a fresh idempotency key + reset buffer.
    expect(slice).toMatch(/regenerateFrozenRawBagReceivePayload\(opId, actor\)/);
  });

  it("hold_for_po_update transitions to HELD and tags overs_decision", () => {
    const slice = STAGING_ACTIONS.slice(
      STAGING_ACTIONS.indexOf("case \"hold_for_po_update\":"),
      STAGING_ACTIONS.indexOf("case \"needs_overs_po\":"),
    );
    expect(slice).toMatch(/zohoReceiveStatus:\s*"HELD"/);
    expect(slice).toMatch(/heldAt:\s*now/);
    expect(slice).toMatch(/heldReason:\s*`Awaiting PO update — \$\{d\.reason\}`/);
    // Per v1.2.0 decision: hold_for_po_update CARRIES the tag.
    expect(slice).toMatch(/oversDecision:\s*"hold_for_po_update"/);
    expect(slice).toMatch(/autoCommitEligibleAt:\s*null/);
  });

  it("needs_overs_po STAYS in NEEDS_REVIEW (only the tag changes)", () => {
    const slice = STAGING_ACTIONS.slice(
      STAGING_ACTIONS.indexOf("case \"needs_overs_po\":"),
      STAGING_ACTIONS.indexOf("case \"reconciled_manually\":"),
    );
    // No status field is written → status stays NEEDS_REVIEW.
    expect(slice).not.toMatch(/zohoReceiveStatus:/);
    expect(slice).toMatch(/oversDecision:\s*"needs_overs_po"/);
  });

  it("reconciled_manually is terminal (transitions to VOIDED) with the canonical reason prefix", () => {
    const slice = STAGING_ACTIONS.slice(
      STAGING_ACTIONS.indexOf("case \"reconciled_manually\":"),
    );
    expect(slice).toMatch(/zohoReceiveStatus:\s*"VOIDED"/);
    expect(slice).toMatch(/voidedAt:\s*now/);
    expect(slice).toMatch(/voidReason:\s*`Reconciled manually — \$\{d\.reason\}`/);
    expect(slice).toMatch(/oversDecision:\s*"reconciled_manually"/);
  });

  it("each branch writes the canonical audit action string", () => {
    expect(STAGING_ACTIONS).toMatch(/action:\s*OVERS_AUDIT_ACTIONS\.adjust_down/);
    expect(STAGING_ACTIONS).toMatch(/action:\s*OVERS_AUDIT_ACTIONS\.hold_for_po_update/);
    expect(STAGING_ACTIONS).toMatch(/action:\s*OVERS_AUDIT_ACTIONS\.needs_overs_po/);
    expect(STAGING_ACTIONS).toMatch(/action:\s*OVERS_AUDIT_ACTIONS\.reconciled_manually/);
  });
});

describe("clearOversDecisionAction — reason required + audit", () => {
  it("requires a non-empty reason via validateClearOversReason", () => {
    expect(STAGING_ACTIONS).toMatch(/validateClearOversReason\(reason\)/);
  });

  it("refuses to clear a 'reconciled_manually' tag (the row is voided)", () => {
    expect(STAGING_ACTIONS).toMatch(
      /row\.currentDecision\s*===\s*"reconciled_manually"[\s\S]+?terminal/,
    );
  });

  it("does NOT touch adjustedReceivedQuantity (separate concept from the tag)", () => {
    const slice = STAGING_ACTIONS.slice(STAGING_ACTIONS.indexOf("clearOversDecisionAction"));
    const setBlock = slice.slice(slice.indexOf(".set({"), slice.indexOf("})", slice.indexOf(".set({")));
    expect(setBlock).toMatch(/oversDecision:\s*null/);
    // No assignment to adjustedReceivedQuantity inside the SET (the
    // word may appear in an explanatory comment — what we forbid is
    // an actual `adjustedReceivedQuantity:` property write).
    expect(setBlock).not.toMatch(/\badjustedReceivedQuantity\s*:/);
  });

  it("writes the canonical 'cleared' audit action", () => {
    expect(STAGING_ACTIONS).toMatch(/action:\s*OVERS_AUDIT_ACTIONS\.cleared/);
  });
});

// ─── Freeze + unhold clear the tag (design §4.4) ──────────────────

describe("freeze + unhold clear the overs decision tag", () => {
  it("regenerateFrozenRawBagReceivePayload nulls all four overs_decision_* columns", () => {
    expect(FREEZE).toMatch(/oversDecision:\s*null/);
    expect(FREEZE).toMatch(/oversDecisionAt:\s*null/);
    expect(FREEZE).toMatch(/oversDecisionByUserId:\s*null/);
    expect(FREEZE).toMatch(/oversDecisionNote:\s*null/);
  });

  it("unholdRawBagReceiveOp nulls all four overs_decision_* columns (back to normal flow)", () => {
    const slice = STAGING_ACTIONS.slice(
      STAGING_ACTIONS.indexOf("unholdRawBagReceiveOp"),
      STAGING_ACTIONS.indexOf("voidRawBagReceiveOp"),
    );
    expect(slice).toMatch(/oversDecision:\s*null/);
    expect(slice).toMatch(/oversDecisionAt:\s*null/);
    expect(slice).toMatch(/oversDecisionByUserId:\s*null/);
    expect(slice).toMatch(/oversDecisionNote:\s*null/);
  });
});

// ─── Cron + manual must continue to skip NEEDS_REVIEW ─────────────

describe("cron + manual commit cannot route through NEEDS_REVIEW (post-overs invariant)", () => {
  it("cron loader's RAW_BAG_COMMITTABLE_STATUSES is unchanged (no NEEDS_REVIEW added)", () => {
    const m = SWEEP.match(/RAW_BAG_COMMITTABLE_STATUSES\s*=\s*\[([\s\S]+?)\]/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("NEEDS_REVIEW");
  });

  it("sharedCommitRawBagReceive still refuses NEEDS_REVIEW at claim time", () => {
    expect(SHARED_COMMIT).toMatch(
      /row\.status\s*===\s*"NEEDS_REVIEW"[\s\S]+?business decision/,
    );
  });

  it("staging-buttons committable set does NOT include NEEDS_REVIEW (manual commit-now blocked)", () => {
    const m = STAGING_BUTTONS.match(
      /COMMITTABLE_STATUSES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("NEEDS_REVIEW");
  });
});

// ─── UI visibility contract ───────────────────────────────────────

describe("OversResolutionPanel — UI visibility per design §4.1", () => {
  it("only the staging-buttons branch for NEEDS_REVIEW + over-receive renders the panel", () => {
    // The panel is rendered ONLY when status=NEEDS_REVIEW AND
    // OVER_RECEIVE_BLOCKER_CODE is in mapping_blockers. Other
    // NEEDS_REVIEW codes fall to the generic notice.
    expect(STAGING_BUTTONS).toMatch(/OVER_RECEIVE_BLOCKER_CODE/);
    expect(STAGING_BUTTONS).toMatch(
      /overReceive[\s\S]+?<OversResolutionPanel/,
    );
  });

  it("the panel exposes all four decision kinds", () => {
    expect(PANEL).toMatch(/picked === "adjust_down"/);
    expect(PANEL).toMatch(/picked === "hold_for_po_update"/);
    expect(PANEL).toMatch(/picked === "needs_overs_po"/);
    expect(PANEL).toMatch(/picked === "reconciled_manually"/);
  });

  it("the prefill uses remainingQuantity from the gateway hint (not a guess)", () => {
    expect(PANEL).toMatch(/prefillRemainingQuantity/);
  });

  it("when prefill is unavailable, the helper copy tells the operator to enter manually", () => {
    expect(PANEL).toMatch(
      /Remaining Zoho PO-line quantity is unavailable\. Enter the adjusted receive quantity manually\./,
    );
  });

  it("'needs_overs_po' tagged rows show the awaiting-overs-PO sub-queue copy", () => {
    expect(PANEL).toMatch(/Awaiting overs PO decision/);
    expect(PANEL).toMatch(
      /Create or update an overs PO later, then return here to resolve/,
    );
  });

  it("the 'Clear tag' button is available on needs_overs_po rows", () => {
    expect(PANEL).toMatch(/Clear tag/);
    expect(PANEL).toMatch(/clearOversDecisionAction/);
  });
});

// ─── Scope guard — no split / no auto overs-PO / no bag mutation ─

describe("scope guard — split / auto overs-PO / inventory-bag mutation are NOT in v1.2.0", () => {
  it("staging-actions does NOT reference the split workflow", () => {
    expect(STAGING_ACTIONS).not.toMatch(/parent_op_id/i);
    expect(STAGING_ACTIONS).not.toMatch(/split[A-Z]/);
  });

  it("staging-actions does NOT call any overs-PO creation function", () => {
    expect(STAGING_ACTIONS).not.toMatch(/createOversPurchaseOrder|createOversPo|createOversPO/);
  });

  it("staging-actions does NOT mutate inventory_bags (bag-side truth stays at vendor-shipped qty)", () => {
    expect(STAGING_ACTIONS).not.toMatch(/inventoryBags/);
    expect(STAGING_ACTIONS).not.toMatch(/declared_pill_count/);
    expect(STAGING_ACTIONS).not.toMatch(/declaredPillCount/);
  });
});
