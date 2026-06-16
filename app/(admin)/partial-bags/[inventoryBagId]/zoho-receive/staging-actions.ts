"use server";

// ZOHO-STAGING-BUFFER-v1.1.0 — admin server actions for the raw-bag
// receive queue. Five buttons:
//
//   Hold     — pause the buffer; operator decides later.
//   Unhold   — resume the buffer; auto_commit_eligible_at re-stamped.
//   Void     — cancel the staged op; never sent to Zoho.
//   Commit now — operator pushes immediately; bypasses any remaining buffer.
//   (no separate "approve" — raw-bag rows are seeded with implicit
//   approval at intake; the buffer + operator-action set IS the
//   approval gate.)
//
// Every action transitions the row through the shared state machine
// in sharedCommitRawBagReceive. The same idempotent commit fn is
// called whether the trigger is a manual button or the cron worker.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { requireLead } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { zohoRawBagReceives } from "@/lib/db/schema";
import { sharedCommitRawBagReceive } from "@/lib/zoho/shared-raw-bag-receive-commit";
import {
  deriveAutoCommitEligibleAt,
  resolveZohoAutoCommitBufferConfig,
} from "@/lib/zoho/zoho-auto-commit-buffer-config";
import {
  canAcceptOversDecision,
  OVERS_AUDIT_ACTIONS,
  validateClearOversReason,
  validateOversDecisionInput,
  type OversDecisionInput,
} from "@/lib/zoho/overs-resolution";
import { regenerateFrozenRawBagReceivePayload } from "@/lib/zoho/freeze-raw-bag-receive-payload";

export type RawBagStagingActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const REVALIDATE_PATHS = [
  "/partial-bags",
  "/zoho-production-operations",
  "/inbound",
] as const;

function revalidateAll() {
  for (const path of REVALIDATE_PATHS) revalidatePath(path);
}

export async function holdRawBagReceiveOp(
  opId: string,
  reason: string,
): Promise<RawBagStagingActionResult> {
  const actor = await requireLead();
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0) {
    return { ok: false, error: "Provide a reason for the hold." };
  }
  if (trimmedReason.length > 500) {
    return { ok: false, error: "Hold reason must be 500 characters or fewer." };
  }

  const now = new Date();
  const [updated] = await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "HELD",
      heldAt: now,
      heldReason: trimmedReason,
      // Clear the buffer while held — unhold will re-stamp it.
      autoCommitEligibleAt: null,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId))
    .returning({ id: zohoRawBagReceives.id, prevStatus: zohoRawBagReceives.zohoReceiveStatus });

  if (!updated) return { ok: false, error: "Staged op not found." };

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_raw_bag_receive.held",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { reason: trimmedReason },
  });
  revalidateAll();
  return { ok: true, message: "Held. Auto-commit paused." };
}

export async function unholdRawBagReceiveOp(
  opId: string,
): Promise<RawBagStagingActionResult> {
  const actor = await requireLead();

  const now = new Date();
  const config = resolveZohoAutoCommitBufferConfig();
  const eligibleAt = deriveAutoCommitEligibleAt(now, config);

  const [updated] = await db
    .update(zohoRawBagReceives)
    .set({
      // Returning to PENDING — the cron will pick it up once
      // eligibleAt fires. If buffer is disabled (eligibleAt=null), the
      // row stays manual-only.
      zohoReceiveStatus: "PENDING",
      heldAt: null,
      heldReason: null,
      autoCommitEligibleAt: eligibleAt,
      // OVERS-RESOLUTION-v1.2.0 — unhold clears any 'hold_for_po_update'
      // tag because the row is back in the normal flow. Audit log
      // preserves the decision history. A future retry that hits
      // over-receive again will stamp a fresh decision.
      oversDecision: null,
      oversDecisionAt: null,
      oversDecisionByUserId: null,
      oversDecisionNote: null,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId))
    .returning({ id: zohoRawBagReceives.id });

  if (!updated) return { ok: false, error: "Staged op not found." };

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_raw_bag_receive.unheld",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { autoCommitEligibleAt: eligibleAt?.toISOString() ?? null },
  });
  revalidateAll();
  return { ok: true, message: "Unheld. Buffer restarted." };
}

export async function voidRawBagReceiveOp(
  opId: string,
  reason: string,
): Promise<RawBagStagingActionResult> {
  const actor = await requireLead();
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0) {
    return { ok: false, error: "Provide a reason for the void." };
  }
  if (trimmedReason.length > 500) {
    return { ok: false, error: "Void reason must be 500 characters or fewer." };
  }

  const now = new Date();
  const [updated] = await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "VOIDED",
      voidedAt: now,
      voidReason: trimmedReason,
      autoCommitEligibleAt: null,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId))
    .returning({ id: zohoRawBagReceives.id });

  if (!updated) return { ok: false, error: "Staged op not found." };

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_raw_bag_receive.voided",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { reason: trimmedReason },
  });
  revalidateAll();
  return { ok: true, message: "Voided. Will not be sent to Zoho." };
}

/** Manual "Commit now" / "Push to Zoho now" — bypasses any remaining
 *  buffer wait. Uses the SAME shared idempotent commit fn as the cron,
 *  so identical state-machine + idempotency-key behavior. */
export async function commitNowRawBagReceiveOp(
  opId: string,
): Promise<RawBagStagingActionResult> {
  const actor = await requireLead();

  const result = await sharedCommitRawBagReceive({
    opId,
    source: "manual",
    actor,
  });

  revalidateAll();

  if (result.ok && result.kind === "COMMITTED") {
    return { ok: true, message: "Committed to Zoho." };
  }
  if (!result.ok) {
    if (result.kind === "GUARD_BLOCKED") {
      return {
        ok: false,
        error: `Live commit disabled by env flag: ${result.reason}`,
      };
    }
    if (result.kind === "STATE_BLOCKED") {
      return { ok: false, error: result.reason };
    }
    if (result.kind === "NEEDS_REVIEW") {
      return {
        ok: false,
        error: `Needs business-decision review: ${result.blockers
          .map((b) => b.message)
          .join("; ")}`,
      };
    }
    if (result.kind === "NEEDS_MAPPING") {
      return {
        ok: false,
        error: `Mapping fix required on the product: ${result.blockers
          .map((b) => b.message)
          .join("; ")}`,
      };
    }
    return { ok: false, error: result.reason };
  }
  return { ok: false, error: "Unknown commit outcome." };
}

// ─── OVERS-RESOLUTION-v1.2.0 ──────────────────────────────────────
//
// Operator decisions on NEEDS_REVIEW rows that carry the
// OVER_RECEIVE_EXCEEDS_PO_REMAINING blocker. State machine + audit
// per docs/OVERS_EXTRAS_RESOLUTION_DESIGN.md §2 + §4.

export async function resolveOversBlockerAction(
  opId: string,
  decision: OversDecisionInput,
): Promise<RawBagStagingActionResult> {
  const actor = await requireLead();

  const [row] = await db
    .select({
      id: zohoRawBagReceives.id,
      status: zohoRawBagReceives.zohoReceiveStatus,
      heldAt: zohoRawBagReceives.heldAt,
      voidedAt: zohoRawBagReceives.voidedAt,
      receivedQuantity: zohoRawBagReceives.zohoReceivedQuantity,
      adjustedQuantity: zohoRawBagReceives.adjustedReceivedQuantity,
      mappingBlockers: zohoRawBagReceives.mappingBlockers,
      currentDecision: zohoRawBagReceives.oversDecision,
    })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.id, opId))
    .limit(1);

  if (!row) return { ok: false, error: "Staged op not found." };

  const eligible = canAcceptOversDecision({
    status: row.status,
    heldAt: row.heldAt,
    voidedAt: row.voidedAt,
    mappingBlockers: row.mappingBlockers,
  });
  if (!eligible.ok) return { ok: false, error: eligible.reason };

  // Use the post-adjustment quantity if a prior adjust_down stuck;
  // otherwise the original received quantity. Either way, the new
  // adjust-down value must be smaller than this.
  const currentReceivedQuantity =
    row.adjustedQuantity ?? row.receivedQuantity ?? 0;
  const validated = validateOversDecisionInput(decision, {
    currentReceivedQuantity,
  });
  if (!validated.ok) return { ok: false, error: validated.error };
  const d = validated.decision;

  const now = new Date();

  switch (d.kind) {
    case "adjust_down": {
      // Persist the adjusted quantity FIRST (it's the new payload
      // input) so the freeze rebuild reads it as the gateway-bound
      // quantity. Also stamp overs_decision in the same UPDATE so
      // audit-time the row carries both pieces of state.
      await db
        .update(zohoRawBagReceives)
        .set({
          adjustedReceivedQuantity: d.newQuantity,
          zohoReceivedQuantity: d.newQuantity,
          oversDecision: "adjust_down",
          oversDecisionAt: now,
          oversDecisionByUserId: actor.id,
          oversDecisionNote: d.reason,
          // Re-arm: clear blocker fields and let the freeze stamp a
          // fresh idempotency key + buffer.
          mappingBlockers: null,
          commitError: null,
          zohoReceiveStatus: "PENDING",
          updatedAt: now,
        })
        .where(eq(zohoRawBagReceives.id, opId));

      // Freeze regenerates payload + notes + commit_idempotency_key
      // + auto_commit_eligible_at from the new adjusted quantity.
      // The freeze fn writes its own audit row for the regeneration;
      // we add an additional audit row for the decision below.
      await regenerateFrozenRawBagReceivePayload(opId, actor);

      await writeAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: OVERS_AUDIT_ACTIONS.adjust_down,
        targetType: "ZohoRawBagReceive",
        targetId: opId,
        before: { receivedQuantity: currentReceivedQuantity },
        after: { adjustedQuantity: d.newQuantity, reason: d.reason },
      });
      revalidateAll();
      return {
        ok: true,
        message: `Adjusted to ${d.newQuantity}. Returning to PENDING with a fresh review buffer.`,
      };
    }

    case "hold_for_po_update": {
      await db
        .update(zohoRawBagReceives)
        .set({
          zohoReceiveStatus: "HELD",
          heldAt: now,
          heldReason: `Awaiting PO update — ${d.reason}`,
          oversDecision: "hold_for_po_update",
          oversDecisionAt: now,
          oversDecisionByUserId: actor.id,
          oversDecisionNote: d.reason,
          autoCommitEligibleAt: null,
          updatedAt: now,
        })
        .where(eq(zohoRawBagReceives.id, opId));

      await writeAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: OVERS_AUDIT_ACTIONS.hold_for_po_update,
        targetType: "ZohoRawBagReceive",
        targetId: opId,
        after: { reason: d.reason },
      });
      revalidateAll();
      return {
        ok: true,
        message: "Held until PO is updated. Unhold once Zoho's PO line has been bumped.",
      };
    }

    case "needs_overs_po": {
      await db
        .update(zohoRawBagReceives)
        .set({
          // Status STAYS NEEDS_REVIEW — only the tag changes.
          oversDecision: "needs_overs_po",
          oversDecisionAt: now,
          oversDecisionByUserId: actor.id,
          oversDecisionNote: d.note,
          updatedAt: now,
        })
        .where(eq(zohoRawBagReceives.id, opId));

      await writeAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: OVERS_AUDIT_ACTIONS.needs_overs_po,
        targetType: "ZohoRawBagReceive",
        targetId: opId,
        after: { note: d.note },
      });
      revalidateAll();
      return {
        ok: true,
        message: "Tagged for overs PO. Procurement will see it in the Awaiting overs PO list.",
      };
    }

    case "reconciled_manually": {
      await db
        .update(zohoRawBagReceives)
        .set({
          zohoReceiveStatus: "VOIDED",
          voidedAt: now,
          voidReason: `Reconciled manually — ${d.reason}`,
          oversDecision: "reconciled_manually",
          oversDecisionAt: now,
          oversDecisionByUserId: actor.id,
          oversDecisionNote: d.reason,
          autoCommitEligibleAt: null,
          updatedAt: now,
        })
        .where(eq(zohoRawBagReceives.id, opId));

      await writeAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: OVERS_AUDIT_ACTIONS.reconciled_manually,
        targetType: "ZohoRawBagReceive",
        targetId: opId,
        after: { reason: d.reason },
      });
      revalidateAll();
      return {
        ok: true,
        message: "Marked reconciled manually. Op is voided and will not be sent to Zoho.",
      };
    }
  }
}

export async function clearOversDecisionAction(
  opId: string,
  reason: string,
): Promise<RawBagStagingActionResult> {
  const actor = await requireLead();

  const validatedReason = validateClearOversReason(reason);
  if (!validatedReason.ok) return { ok: false, error: validatedReason.error };

  const [row] = await db
    .select({
      currentDecision: zohoRawBagReceives.oversDecision,
      status: zohoRawBagReceives.zohoReceiveStatus,
    })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.id, opId))
    .limit(1);

  if (!row) return { ok: false, error: "Staged op not found." };
  if (!row.currentDecision) {
    return { ok: false, error: "No overs decision to clear on this op." };
  }
  if (row.currentDecision === "reconciled_manually") {
    return {
      ok: false,
      error: "reconciled_manually is terminal; the row is already voided. Use a separate compensating action.",
    };
  }

  const now = new Date();
  const previousDecision = row.currentDecision;

  await db
    .update(zohoRawBagReceives)
    .set({
      oversDecision: null,
      oversDecisionAt: null,
      oversDecisionByUserId: null,
      oversDecisionNote: null,
      // We do NOT touch adjustedReceivedQuantity here — that's a
      // separate concept. Clearing the decision tag does not
      // un-adjust a prior adjust_down.
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: OVERS_AUDIT_ACTIONS.cleared,
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    before: { decision: previousDecision },
    after: { reason: validatedReason.reason },
  });
  revalidateAll();
  return { ok: true, message: "Overs decision cleared." };
}
