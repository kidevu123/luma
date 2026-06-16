"use server";

// ZOHO-STAGING-BUFFER-v1.1.0 — admin server actions for the
// production-output queue. Five buttons:
//
//   Hold                — pause the buffer.
//   Unhold              — resume the buffer.
//   Void                — cancel the staged op.
//   Approve for auto-commit — operator-approved; cron commits when
//                             auto_commit_eligible_at <= now().
//   Approve & commit now — operator-approved; bypasses the buffer and
//                          calls the shared commit fn immediately.
//
// "Approve for auto-commit" and "Approve & commit now" perform the
// EXACT SAME internal transitions (approve → queue + buffer stamp).
// They only differ on the FINAL step: the auto path leaves the row
// for the cron; the commit-now path immediately fires the shared
// commit fn. That guarantees the manual path and the cron path
// behave identically — same payload, same idempotency, same
// state machine.
//
// The explicit-Queue button is gone from the operator UI: the state
// machine still does APPROVED → QUEUED internally, but the operator
// only sees two buttons.

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { requireLead } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import {
  approveZohoProductionOutputOp,
  queueZohoProductionOutputOpForFutureCommit,
  voidZohoProductionOutputOp,
} from "@/lib/db/queries/zoho-production-output";
import {
  sharedCommitProductionOutputOp,
  type ProductionOutputCommitCallable,
} from "@/lib/zoho/shared-production-output-commit";
import { callProductionOutputCommit } from "@/lib/zoho/production-output-service-client";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import {
  deriveAutoCommitEligibleAt,
  resolveZohoAutoCommitBufferConfig,
} from "@/lib/zoho/zoho-auto-commit-buffer-config";

export type ProductionOutputStagingActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const REVALIDATE_PATHS = [
  "/zoho-production-operations",
  "/dashboard",
] as const;

function revalidateAll() {
  for (const path of REVALIDATE_PATHS) revalidatePath(path);
}

// ─── Hold / Unhold / Void ─────────────────────────────────────────

export async function holdProductionOutputOp(
  opId: string,
  reason: string,
): Promise<ProductionOutputStagingActionResult> {
  const actor = await requireLead();
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Provide a reason for the hold." };
  }
  if (trimmed.length > 500) {
    return { ok: false, error: "Hold reason must be 500 characters or fewer." };
  }
  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      // Use the existing free-text status column — HELD doesn't need
      // an enum extension on this table.
      status: "HELD",
      heldAt: now,
      heldReason: trimmed,
      autoCommitEligibleAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .returning({ id: zohoProductionOutputOps.id });

  if (!updated) {
    return { ok: false, error: "Op not found or already voided." };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.held",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    after: { reason: trimmed },
  });
  revalidateAll();
  return { ok: true, message: "Held. Auto-commit paused." };
}

export async function unholdProductionOutputOp(
  opId: string,
): Promise<ProductionOutputStagingActionResult> {
  const actor = await requireLead();
  const now = new Date();
  const config = resolveZohoAutoCommitBufferConfig();
  const eligibleAt = deriveAutoCommitEligibleAt(now, config);

  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      // Hold was set on a row that was QUEUED before — return to QUEUED.
      // If you held a row that was in APPROVED state (rare), it returns
      // to APPROVED on unhold via the existing flow (the operator would
      // re-click Approve & queue). We keep the simple QUEUED-default
      // here to avoid stashing the pre-hold status.
      status: "QUEUED",
      heldAt: null,
      heldReason: null,
      autoCommitEligibleAt: eligibleAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "HELD"),
      ),
    )
    .returning({ id: zohoProductionOutputOps.id });

  if (!updated) {
    return { ok: false, error: "Op not currently HELD." };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.unheld",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    after: { autoCommitEligibleAt: eligibleAt?.toISOString() ?? null },
  });
  revalidateAll();
  return { ok: true, message: "Unheld. Buffer restarted." };
}

export async function voidProductionOutputOpAction(
  opId: string,
  reason: string,
): Promise<ProductionOutputStagingActionResult> {
  const actor = await requireLead();
  const result = await voidZohoProductionOutputOp(opId, reason, actor);
  revalidateAll();
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, message: "Voided. Will not be sent to Zoho." };
}

// ─── Approve for auto-commit ────────────────────────────────────

/** Approve → Queue → stamp auto_commit_eligible_at. The cron picks
 *  this row up at eligibleAt; until then the operator can hold/void. */
export async function approveProductionOutputForAutoCommit(
  opId: string,
): Promise<ProductionOutputStagingActionResult> {
  const actor = await requireLead();

  const approve = await approveZohoProductionOutputOp(opId, actor);
  if (!approve.ok) return { ok: false, error: approve.error };

  const queue = await queueZohoProductionOutputOpForFutureCommit(opId, actor);
  if (!queue.ok) return { ok: false, error: queue.error };

  // Stamp the buffer. If auto-commit is disabled (no env config), this
  // is null and the row sits in QUEUED until an operator clicks
  // commit-now manually. That's intentional — the env flag is a hard
  // gate, not a default.
  const now = new Date();
  const eligibleAt = deriveAutoCommitEligibleAt(
    now,
    resolveZohoAutoCommitBufferConfig(),
  );
  if (eligibleAt) {
    await db
      .update(zohoProductionOutputOps)
      .set({ autoCommitEligibleAt: eligibleAt, updatedAt: now })
      .where(eq(zohoProductionOutputOps.id, opId));
  }

  revalidateAll();
  return {
    ok: true,
    message: eligibleAt
      ? `Approved. Will commit automatically at ${eligibleAt.toLocaleString()}.`
      : "Approved & queued. Use 'Commit now' to push to Zoho when ready.",
  };
}

// ─── Approve & commit now ──────────────────────────────────────

/** Live callable adapter — wraps callProductionOutputCommit so the
 *  shared wrapper's contract is satisfied. */
const liveCommitCallable: ProductionOutputCommitCallable = async (input) => {
  const result = await callProductionOutputCommit({
    payload: input.requestPayload as unknown as ProductionOutputPreviewPayload,
    idempotencyKey: input.commitIdempotencyKey,
  });
  if (result.ok) {
    return {
      ok: true,
      body: result.body,
      externalReferenceId: result.externalReferenceId,
    };
  }
  return {
    ok: false,
    body: result.body,
    httpStatus: result.httpStatus,
    message: result.message,
  };
};

/** Approve → Queue → immediately call sharedCommitProductionOutputOp
 *  with source="manual". Same shared commit fn the cron uses, same
 *  idempotency, same state machine. */
export async function approveAndCommitProductionOutputNow(
  opId: string,
): Promise<ProductionOutputStagingActionResult> {
  const actor = await requireLead();

  // Approve + queue first — the shared commit fn requires status=QUEUED.
  const approve = await approveZohoProductionOutputOp(opId, actor);
  if (!approve.ok) return { ok: false, error: approve.error };

  const queue = await queueZohoProductionOutputOpForFutureCommit(opId, actor);
  if (!queue.ok) return { ok: false, error: queue.error };

  // Now commit. Source = "manual" so the commit-trigger suffix on the
  // notes reflects the actual trigger.
  const result = await sharedCommitProductionOutputOp({
    opId,
    source: "manual",
    actor,
    callable: liveCommitCallable,
  });

  revalidateAll();

  if (result.ok && result.kind === "COMMITTED") {
    return { ok: true, message: "Approved and committed to Zoho." };
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
        error: `Mapping fix required: ${result.blockers
          .map((b) => b.message)
          .join("; ")}`,
      };
    }
    return { ok: false, error: result.reason };
  }
  return { ok: false, error: "Unknown commit outcome." };
}
