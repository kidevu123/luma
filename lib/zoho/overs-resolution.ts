// OVERS-RESOLUTION-v1.2.0 — pure helpers for the operator decisions on
// over-receive blockers.
//
// The state machine + DB transitions live in the server actions
// (app/(admin)/partial-bags/.../zoho-receive/staging-actions.ts). This
// module owns the vocabulary, validation, and copy that both the
// server actions and the UI panel consume — so server and client
// can't drift on what's a valid decision shape or what the operator
// reads.

import type { CommitMappingBlocker } from "@/lib/zoho/shared-raw-bag-receive-commit";

/** The four canonical decisions. Stored verbatim in
 *  zoho_raw_bag_receives.overs_decision. */
export type OversDecisionKind =
  | "adjust_down"
  | "hold_for_po_update"
  | "needs_overs_po"
  | "reconciled_manually";

/** Audit-log action strings — pinned by the test suite so log readers
 *  can search for the canonical vocabulary. */
export const OVERS_AUDIT_ACTIONS = {
  adjust_down: "zoho_raw_bag_receive.overs_decision.adjust_down",
  hold_for_po_update: "zoho_raw_bag_receive.overs_decision.hold_for_po_update",
  needs_overs_po: "zoho_raw_bag_receive.overs_decision.needs_overs_po",
  reconciled_manually: "zoho_raw_bag_receive.overs_decision.reconciled_manually",
  cleared: "zoho_raw_bag_receive.overs_decision.cleared",
} as const;

/** The over-receive blocker code emitted by the gateway. Pinned here
 *  so the UI surface and the routing logic share one source of
 *  truth. */
export const OVER_RECEIVE_BLOCKER_CODE = "OVER_RECEIVE_EXCEEDS_PO_REMAINING";

/** Input shape for resolveOversBlockerAction. One of four kinds. */
export type OversDecisionInput =
  | { kind: "adjust_down"; newQuantity: number; reason: string }
  | { kind: "hold_for_po_update"; reason: string }
  | { kind: "needs_overs_po"; note: string | null }
  | { kind: "reconciled_manually"; reason: string };

/** Validation outcome for the decision input. Pure function. */
export type OversDecisionValidation =
  | { ok: true; decision: OversDecisionInput }
  | { ok: false; error: string };

const MAX_REASON_LENGTH = 500;
const MAX_NOTE_LENGTH = 500;

/** Validate an overs-decision input. Server actions call this before
 *  any DB mutation. */
export function validateOversDecisionInput(
  raw: OversDecisionInput,
  context: { currentReceivedQuantity: number },
): OversDecisionValidation {
  if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") {
    return { ok: false, error: "Pick a decision (adjust / hold / overs / reconcile)." };
  }

  switch (raw.kind) {
    case "adjust_down": {
      const reason = (raw.reason ?? "").trim();
      if (reason.length === 0) {
        return { ok: false, error: "Provide a reason for the adjustment." };
      }
      if (reason.length > MAX_REASON_LENGTH) {
        return { ok: false, error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer.` };
      }
      const qty = raw.newQuantity;
      if (!Number.isInteger(qty) || qty <= 0) {
        return { ok: false, error: "Adjusted quantity must be a positive whole number." };
      }
      if (qty >= context.currentReceivedQuantity) {
        return {
          ok: false,
          error: `Adjusted quantity must be smaller than the original (${context.currentReceivedQuantity}). Hold or void if you want to keep the same quantity.`,
        };
      }
      return { ok: true, decision: { kind: "adjust_down", newQuantity: qty, reason } };
    }
    case "hold_for_po_update": {
      const reason = (raw.reason ?? "").trim();
      if (reason.length === 0) {
        return { ok: false, error: "Provide a reason for the hold." };
      }
      if (reason.length > MAX_REASON_LENGTH) {
        return { ok: false, error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer.` };
      }
      return { ok: true, decision: { kind: "hold_for_po_update", reason } };
    }
    case "needs_overs_po": {
      const note = (raw.note ?? "").trim();
      if (note.length > MAX_NOTE_LENGTH) {
        return { ok: false, error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` };
      }
      return { ok: true, decision: { kind: "needs_overs_po", note: note.length > 0 ? note : null } };
    }
    case "reconciled_manually": {
      const reason = (raw.reason ?? "").trim();
      if (reason.length === 0) {
        return { ok: false, error: "Provide a reason for the manual reconciliation." };
      }
      if (reason.length > MAX_REASON_LENGTH) {
        return { ok: false, error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer.` };
      }
      return { ok: true, decision: { kind: "reconciled_manually", reason } };
    }
    default:
      return { ok: false, error: "Unknown decision kind." };
  }
}

/** Validate the "clear overs decision" reason. v1.2.0 requires a
 *  reason so the audit row explains why the tag was removed. */
export function validateClearOversReason(
  raw: string | null | undefined,
): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = (raw ?? "").trim();
  if (reason.length === 0) {
    return {
      ok: false,
      error: "Provide a short reason for clearing the overs decision.",
    };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, reason };
}

/** Find the over-receive blocker (if any) in a NEEDS_REVIEW row's
 *  mapping_blockers array. Returns null when the row's NEEDS_REVIEW
 *  was for a different (future) code. */
export function findOverReceiveBlocker(
  blockers: ReadonlyArray<CommitMappingBlocker> | null | undefined,
): CommitMappingBlocker | null {
  if (!blockers) return null;
  return blockers.find((b) => b.code === OVER_RECEIVE_BLOCKER_CODE) ?? null;
}

/** Compute the prefill value for the adjust-down quantity input. Per
 *  v1.2.0 decisions: prefer the gateway-supplied remainingQuantity
 *  when it's a positive integer; otherwise return null and let the
 *  UI show the "enter manually" helper copy. We never guess. */
export function prefillAdjustDownQuantity(
  blocker: CommitMappingBlocker | null,
  currentReceivedQuantity: number,
): number | null {
  if (!blocker) return null;
  const remaining = blocker.remainingQuantity;
  if (typeof remaining !== "number") return null;
  if (!Number.isInteger(remaining)) return null;
  if (remaining <= 0) return null;
  if (remaining >= currentReceivedQuantity) return null;
  return remaining;
}

/** Pre-flight check: a row can only accept an overs decision when
 *  it's in NEEDS_REVIEW with the over-receive blocker present. Other
 *  NEEDS_REVIEW reasons (future codes) go through different flows. */
export function canAcceptOversDecision(row: {
  status: string;
  heldAt: Date | null;
  voidedAt: Date | null;
  mappingBlockers: ReadonlyArray<CommitMappingBlocker> | null;
}): { ok: true } | { ok: false; reason: string } {
  if (row.voidedAt) return { ok: false, reason: "Op is voided." };
  if (row.status !== "NEEDS_REVIEW") {
    return {
      ok: false,
      reason: `Op is in status ${row.status}; only NEEDS_REVIEW rows accept an overs decision.`,
    };
  }
  if (!findOverReceiveBlocker(row.mappingBlockers)) {
    return {
      ok: false,
      reason:
        "This NEEDS_REVIEW row does not carry an over-receive blocker. Use Hold / Void instead.",
    };
  }
  return { ok: true };
}
