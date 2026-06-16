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
