// OVERS-RESOLUTION-v1.2.0 — pure-function tests for the validation +
// canonical vocabulary. State-machine + DB transitions are covered by
// the source-contract tests against the staging-actions / panel /
// freeze files; here we pin the pure helpers.

import { describe, expect, it } from "vitest";
import {
  canAcceptOversDecision,
  findOverReceiveBlocker,
  OVER_RECEIVE_BLOCKER_CODE,
  OVERS_AUDIT_ACTIONS,
  prefillAdjustDownQuantity,
  validateClearOversReason,
  validateOversDecisionInput,
} from "./overs-resolution";
import {
  extractMappingBlockers,
  type CommitMappingBlocker,
} from "./shared-raw-bag-receive-commit";

const OVER_RECEIVE: CommitMappingBlocker = {
  code: OVER_RECEIVE_BLOCKER_CODE,
  message: "Receive qty 4408 exceeds PO line remaining (4000).",
  remainingQuantity: 4000,
};

const MAPPING_GAP: CommitMappingBlocker = {
  code: "PO_NOT_FOUND",
  message: "Purchase order not found in Zoho.",
};

// ─── Canonical vocabulary ─────────────────────────────────────────

describe("OVERS_AUDIT_ACTIONS — canonical action strings (pin for log readers)", () => {
  it("includes the five action strings the design report names", () => {
    expect(OVERS_AUDIT_ACTIONS.adjust_down).toBe(
      "zoho_raw_bag_receive.overs_decision.adjust_down",
    );
    expect(OVERS_AUDIT_ACTIONS.hold_for_po_update).toBe(
      "zoho_raw_bag_receive.overs_decision.hold_for_po_update",
    );
    expect(OVERS_AUDIT_ACTIONS.needs_overs_po).toBe(
      "zoho_raw_bag_receive.overs_decision.needs_overs_po",
    );
    expect(OVERS_AUDIT_ACTIONS.reconciled_manually).toBe(
      "zoho_raw_bag_receive.overs_decision.reconciled_manually",
    );
    expect(OVERS_AUDIT_ACTIONS.cleared).toBe(
      "zoho_raw_bag_receive.overs_decision.cleared",
    );
  });

  it("OVER_RECEIVE_BLOCKER_CODE is exactly the string the routing/parsing code matches against", () => {
    expect(OVER_RECEIVE_BLOCKER_CODE).toBe("OVER_RECEIVE_EXCEEDS_PO_REMAINING");
  });
});

// ─── extractMappingBlockers — remainingQuantity hint ─────────────

describe("extractMappingBlockers — accepts the optional remaining_quantity hint", () => {
  it("picks up snake_case remaining_quantity when the gateway sends it", () => {
    const result = extractMappingBlockers({
      mapping_blockers: [
        {
          code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING",
          message: "qty 4408 > remaining 4000",
          remaining_quantity: 4000,
        },
      ],
    });
    expect(result[0]?.remainingQuantity).toBe(4000);
  });

  it("picks up camelCase remainingQuantity too (defence in depth)", () => {
    const result = extractMappingBlockers({
      mapping_blockers: [
        {
          code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING",
          message: "msg",
          remainingQuantity: 1234,
        },
      ],
    });
    expect(result[0]?.remainingQuantity).toBe(1234);
  });

  it("omits remainingQuantity when the field is absent (legacy behaviour)", () => {
    const result = extractMappingBlockers({
      mapping_blockers: [
        { code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING", message: "msg" },
      ],
    });
    expect(result[0]?.remainingQuantity).toBeUndefined();
  });

  it("rejects non-integer values (we never guess)", () => {
    expect(
      extractMappingBlockers({
        mapping_blockers: [
          { code: "X", message: "y", remaining_quantity: "4000" },
        ],
      })[0]?.remainingQuantity,
    ).toBeUndefined();
    expect(
      extractMappingBlockers({
        mapping_blockers: [
          { code: "X", message: "y", remaining_quantity: -1 },
        ],
      })[0]?.remainingQuantity,
    ).toBeUndefined();
  });

  it("floors fractional integers (Zoho-side guardrail)", () => {
    expect(
      extractMappingBlockers({
        mapping_blockers: [
          { code: "X", message: "y", remaining_quantity: 4000.7 },
        ],
      })[0]?.remainingQuantity,
    ).toBe(4000);
  });
});

// ─── findOverReceiveBlocker + prefillAdjustDownQuantity ───────────

describe("findOverReceiveBlocker / prefillAdjustDownQuantity", () => {
  it("findOverReceiveBlocker returns the over-receive entry from a mixed list", () => {
    const found = findOverReceiveBlocker([MAPPING_GAP, OVER_RECEIVE]);
    expect(found?.code).toBe(OVER_RECEIVE_BLOCKER_CODE);
  });

  it("findOverReceiveBlocker returns null when only mapping gaps are present", () => {
    expect(findOverReceiveBlocker([MAPPING_GAP])).toBeNull();
  });

  it("prefillAdjustDownQuantity returns the gateway-supplied integer when valid", () => {
    expect(prefillAdjustDownQuantity(OVER_RECEIVE, 4408)).toBe(4000);
  });

  it("prefillAdjustDownQuantity returns null when remainingQuantity is missing — never guess", () => {
    // Strip the optional field rather than assigning undefined —
    // exactOptionalPropertyTypes refuses the latter.
    const withoutHint: CommitMappingBlocker = {
      code: OVER_RECEIVE.code,
      message: OVER_RECEIVE.message,
    };
    expect(prefillAdjustDownQuantity(withoutHint, 4408)).toBeNull();
  });

  it("prefillAdjustDownQuantity returns null when remainingQuantity >= current (would not actually adjust)", () => {
    expect(prefillAdjustDownQuantity({ ...OVER_RECEIVE, remainingQuantity: 4408 }, 4408)).toBeNull();
    expect(prefillAdjustDownQuantity({ ...OVER_RECEIVE, remainingQuantity: 9999 }, 4408)).toBeNull();
  });

  it("prefillAdjustDownQuantity returns null for zero / negative remaining", () => {
    expect(prefillAdjustDownQuantity({ ...OVER_RECEIVE, remainingQuantity: 0 }, 4408)).toBeNull();
    expect(prefillAdjustDownQuantity({ ...OVER_RECEIVE, remainingQuantity: -1 }, 4408)).toBeNull();
  });
});

// ─── canAcceptOversDecision pre-flight ────────────────────────────

describe("canAcceptOversDecision — gates the resolveOversBlockerAction entry", () => {
  function row(over = true, status = "NEEDS_REVIEW", heldAt: Date | null = null, voidedAt: Date | null = null) {
    return {
      status,
      heldAt,
      voidedAt,
      mappingBlockers: over ? [OVER_RECEIVE] : [MAPPING_GAP],
    };
  }

  it("accepts a NEEDS_REVIEW row with an over-receive blocker", () => {
    expect(canAcceptOversDecision(row())).toEqual({ ok: true });
  });

  it("rejects rows in any non-NEEDS_REVIEW status", () => {
    for (const s of ["PENDING", "PREVIEWED", "HELD", "COMMITTING", "COMMITTED", "FAILED", "NEEDS_MAPPING"]) {
      const r = canAcceptOversDecision(row(true, s));
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected reject");
      expect(r.reason).toMatch(/NEEDS_REVIEW/);
    }
  });

  it("rejects voided rows even if otherwise eligible", () => {
    const r = canAcceptOversDecision(row(true, "NEEDS_REVIEW", null, new Date()));
    if (r.ok) throw new Error("expected reject");
    expect(r.reason).toMatch(/voided/);
  });

  it("rejects NEEDS_REVIEW rows whose blocker is NOT over-receive (future codes)", () => {
    const r = canAcceptOversDecision(row(false));
    if (r.ok) throw new Error("expected reject");
    expect(r.reason).toMatch(/over-receive/);
  });
});

// ─── validateOversDecisionInput ───────────────────────────────────

describe("validateOversDecisionInput — adjust_down branch", () => {
  const CTX = { currentReceivedQuantity: 4408 };

  it("accepts a valid adjustment with reason", () => {
    const r = validateOversDecisionInput(
      { kind: "adjust_down", newQuantity: 4000, reason: "vendor over-shipped, accepting loss" },
      CTX,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects empty reason", () => {
    const r = validateOversDecisionInput(
      { kind: "adjust_down", newQuantity: 4000, reason: "" },
      CTX,
    );
    if (r.ok) throw new Error("expected reject");
    expect(r.error).toMatch(/reason/i);
  });

  it("rejects oversized reason (> 500 chars)", () => {
    const r = validateOversDecisionInput(
      { kind: "adjust_down", newQuantity: 4000, reason: "x".repeat(501) },
      CTX,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects zero / negative quantities", () => {
    expect(
      validateOversDecisionInput({ kind: "adjust_down", newQuantity: 0, reason: "x" }, CTX).ok,
    ).toBe(false);
    expect(
      validateOversDecisionInput({ kind: "adjust_down", newQuantity: -5, reason: "x" }, CTX).ok,
    ).toBe(false);
  });

  it("rejects newQuantity equal to or greater than current", () => {
    expect(
      validateOversDecisionInput({ kind: "adjust_down", newQuantity: 4408, reason: "x" }, CTX).ok,
    ).toBe(false);
    expect(
      validateOversDecisionInput({ kind: "adjust_down", newQuantity: 4500, reason: "x" }, CTX).ok,
    ).toBe(false);
  });

  it("rejects fractional quantities", () => {
    expect(
      validateOversDecisionInput({ kind: "adjust_down", newQuantity: 4000.5, reason: "x" }, CTX).ok,
    ).toBe(false);
  });
});

describe("validateOversDecisionInput — hold_for_po_update / needs_overs_po / reconciled_manually", () => {
  const CTX = { currentReceivedQuantity: 100 };

  it("hold_for_po_update requires reason", () => {
    expect(
      validateOversDecisionInput({ kind: "hold_for_po_update", reason: "" }, CTX).ok,
    ).toBe(false);
    expect(
      validateOversDecisionInput({ kind: "hold_for_po_update", reason: "PO bump expected by EOD" }, CTX).ok,
    ).toBe(true);
  });

  it("needs_overs_po — note is OPTIONAL (overs PO creation may not require operator commentary)", () => {
    expect(validateOversDecisionInput({ kind: "needs_overs_po", note: null }, CTX).ok).toBe(true);
    expect(validateOversDecisionInput({ kind: "needs_overs_po", note: "" }, CTX).ok).toBe(true);
    expect(
      validateOversDecisionInput({ kind: "needs_overs_po", note: "ask procurement" }, CTX).ok,
    ).toBe(true);
  });

  it("needs_overs_po — long note rejected (≤ 500)", () => {
    expect(
      validateOversDecisionInput({ kind: "needs_overs_po", note: "x".repeat(501) }, CTX).ok,
    ).toBe(false);
  });

  it("reconciled_manually requires reason (terminal — audit trail must justify)", () => {
    expect(
      validateOversDecisionInput({ kind: "reconciled_manually", reason: "" }, CTX).ok,
    ).toBe(false);
    expect(
      validateOversDecisionInput({ kind: "reconciled_manually", reason: "voided in Zoho PR-00244" }, CTX).ok,
    ).toBe(true);
  });
});

describe("validateOversDecisionInput — input shape", () => {
  const CTX = { currentReceivedQuantity: 100 };

  it("rejects an unknown kind", () => {
    expect(
      validateOversDecisionInput(
        { kind: "split" as unknown as "adjust_down", newQuantity: 50, reason: "x" } as never,
        CTX,
      ).ok,
    ).toBe(false);
  });

  it("rejects null / undefined / non-object input", () => {
    expect(validateOversDecisionInput(null as never, CTX).ok).toBe(false);
    expect(validateOversDecisionInput(undefined as never, CTX).ok).toBe(false);
  });
});

// ─── validateClearOversReason ─────────────────────────────────────

describe("validateClearOversReason — clearing requires a reason (audit-trail rule)", () => {
  it("accepts a non-empty reason ≤ 500 chars", () => {
    expect(validateClearOversReason("operator changed their mind").ok).toBe(true);
  });

  it("rejects empty / whitespace reason", () => {
    expect(validateClearOversReason("").ok).toBe(false);
    expect(validateClearOversReason("   ").ok).toBe(false);
    expect(validateClearOversReason(null).ok).toBe(false);
    expect(validateClearOversReason(undefined).ok).toBe(false);
  });

  it("rejects oversized reason", () => {
    expect(validateClearOversReason("x".repeat(501)).ok).toBe(false);
  });
});
