// ZOHO-STAGING-BUFFER-v1.1.0 — shared idempotent commit for production-output ops.
//
// Symmetric counterpart to shared-raw-bag-receive-commit.ts. Single
// entry point for BOTH the manual "Commit now" button and the
// auto-commit cron worker. Builds on the existing primitives in
// lib/db/queries/zoho-production-output.ts (claim / completeSuccess /
// completeFailure / completeAmbiguous) and adds:
//
//   - Pre-claim hold / void / auto-commit-eligible gate.
//   - Blocker classification (NEEDS_REVIEW vs NEEDS_MAPPING) — same
//     OVER_RECEIVE_EXCEEDS_PO_REMAINING semantics as raw-bag.
//   - Transport-retry path: revert COMMITTING back to QUEUED so the
//     next cron pass can replay with the same idempotency key.
//
// The function takes a `commitCallable` argument so we can ship the
// machinery in this PR without wiring the live gateway endpoint yet
// (Phase G). Tests pass a mock; the cron route (Phase G) will pass
// the real gateway caller.
//
// Frozen payload semantics: zoho_production_output_ops.requestPayload
// is already populated at preview time and carried forward through
// approve / queue. The commit fn reads it as-is — no rebuild.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import type { CurrentUser } from "@/lib/auth";
import {
  claimZohoProductionOutputOpForCommit,
  completeZohoProductionOutputCommitSuccess,
  completeZohoProductionOutputCommitFailure,
  completeZohoProductionOutputCommitAmbiguous,
} from "@/lib/db/queries/zoho-production-output";
import {
  classifyBlockers,
  extractMappingBlockers,
  type CommitMappingBlocker,
} from "@/lib/zoho/shared-raw-bag-receive-commit";
import {
  appendCommitTriggerToNotes,
  type CommitTrigger,
} from "@/lib/zoho/zoho-commit-notes";
import { resolveAutoCommitWriteGates } from "@/lib/zoho/auto-commit-write-gates";

export type ProductionOutputCommitSource = "manual" | "auto";

export type ProductionOutputCommitCallInput = {
  requestPayload: Record<string, unknown>;
  commitIdempotencyKey: string;
};

export type ProductionOutputCommitCallResult =
  | {
      ok: true;
      body: unknown;
      externalReferenceId?: string | null;
      zohoReceiveId?: string | null;
      zohoBundleIds?: string[];
      partialFailure?: boolean;
    }
  | {
      ok: false;
      body: unknown;
      httpStatus: number | null;
      message: string;
    };

export type ProductionOutputCommitCallable = (
  input: ProductionOutputCommitCallInput,
) => Promise<ProductionOutputCommitCallResult>;

export type SharedProductionOutputCommitResult =
  | {
      ok: true;
      kind: "COMMITTED";
      opId: string;
      externalReferenceId: string | null;
    }
  | { ok: false; kind: "STATE_BLOCKED"; opId: string; reason: string }
  | {
      // ZOHO-STAGING-BUFFER-v1.1.0 — env-level live-write gate is off.
      // Pre-flight check refuses BEFORE claim so commit_attempt_count
      // is untouched and the gateway is never called.
      ok: false;
      kind: "GUARD_BLOCKED";
      opId: string;
      reason: string;
    }
  | {
      ok: false;
      kind: "NEEDS_MAPPING";
      opId: string;
      blockers: CommitMappingBlocker[];
    }
  | {
      ok: false;
      kind: "NEEDS_REVIEW";
      opId: string;
      blockers: CommitMappingBlocker[];
    }
  | {
      ok: false;
      kind: "TRANSPORT_RETRYABLE";
      opId: string;
      reason: string;
    }
  | {
      ok: false;
      kind: "PERMANENT_FAILURE";
      opId: string;
      reason: string;
    };

export type SharedProductionOutputCommitInput = {
  opId: string;
  source: ProductionOutputCommitSource;
  actor: CurrentUser;
  /** Inject the gateway caller so the live cron and unit tests can
   *  share the same wrapper. Phase G wires the live caller. */
  callable: ProductionOutputCommitCallable;
  /** Optional "now" injection for buffer-window tests. */
  now?: Date;
};

/** Pre-claim guard: row must be in a committable state AND not held,
 *  voided, or in-flight. For source=auto, the buffer must also have
 *  expired. */
async function checkPreCommitGate(
  opId: string,
  source: ProductionOutputCommitSource,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db
    .select({
      status: zohoProductionOutputOps.status,
      heldAt: zohoProductionOutputOps.heldAt,
      voidedAt: zohoProductionOutputOps.voidedAt,
      autoCommitEligibleAt: zohoProductionOutputOps.autoCommitEligibleAt,
    })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);

  if (!row) return { ok: false, reason: "Production output op not found." };
  if (row.heldAt) return { ok: false, reason: "Op is on hold." };
  if (row.voidedAt) return { ok: false, reason: "Op is voided." };
  if (row.status === "COMMITTED") {
    return { ok: false, reason: "Op is already committed." };
  }
  if (row.status === "COMMITTING") {
    return { ok: false, reason: "Op is already in flight." };
  }
  if (row.status !== "QUEUED") {
    // Production-output state machine requires APPROVED → QUEUED before
    // commit. The cron / manual button cannot skip those gates.
    return {
      ok: false,
      reason: `Op is in status ${row.status}; must be QUEUED before commit.`,
    };
  }

  // Auto-commit only fires after the buffer expires. Manual commit
  // bypasses the buffer entirely — that's the whole point of the
  // manual button (an operator has confirmed in person).
  if (source === "auto") {
    if (!row.autoCommitEligibleAt) {
      return {
        ok: false,
        reason: "Auto-commit not eligible (auto_commit_eligible_at is null).",
      };
    }
    if (row.autoCommitEligibleAt > now) {
      return {
        ok: false,
        reason: `Auto-commit eligible at ${row.autoCommitEligibleAt.toISOString()}, not yet.`,
      };
    }
  }

  return { ok: true };
}

/** Production-output's claim primitive transitions QUEUED → COMMITTING.
 *  On transport retry we need to revert COMMITTING → QUEUED so the
 *  cron picks it up again on the next pass (same idempotency key,
 *  same payload, gateway treats it as a replay). */
async function revertCommittingToQueued(
  opId: string,
  reason: string,
  actor: CurrentUser,
): Promise<void> {
  const now = new Date();
  await db
    .update(zohoProductionOutputOps)
    .set({
      status: "QUEUED",
      commitStartedAt: null,
      commitError: reason,
      commitStatus: "transport_retry_pending",
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "COMMITTING"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    );

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.commit_transport_retryable",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    after: { reason, status: "QUEUED" },
  });
}

async function markNeedsMapping(
  opId: string,
  blockers: CommitMappingBlocker[],
  reason: string,
  responseBody: unknown,
  actor: CurrentUser,
): Promise<void> {
  const now = new Date();
  await db
    .update(zohoProductionOutputOps)
    .set({
      status: "NEEDS_MAPPING",
      mappingBlockers: blockers,
      commitFinishedAt: now,
      commitError: reason,
      commitResponse: responseBody,
      commitStatus: "needs_mapping",
      humanReviewRequired: true,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "COMMITTING"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    );

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.commit_needs_mapping",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    after: { blockers, reason },
  });
}

async function markNeedsReview(
  opId: string,
  blockers: CommitMappingBlocker[],
  reason: string,
  responseBody: unknown,
  actor: CurrentUser,
): Promise<void> {
  const now = new Date();
  // zoho_production_output_ops.status is a free-text column so
  // "NEEDS_REVIEW" needs no enum extension here. Status carries the
  // routing; mapping_blockers carries the specific blocker codes;
  // commit_status documents the failure shape.
  await db
    .update(zohoProductionOutputOps)
    .set({
      status: "NEEDS_REVIEW",
      mappingBlockers: blockers,
      commitFinishedAt: now,
      commitError: reason,
      commitResponse: responseBody,
      commitStatus: "needs_review",
      humanReviewRequired: true,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "COMMITTING"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    );

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.commit_needs_review",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    after: { blockers, reason },
  });
}

export async function sharedCommitProductionOutputOp(
  input: SharedProductionOutputCommitInput,
): Promise<SharedProductionOutputCommitResult> {
  const now = input.now ?? new Date();

  // ZOHO-STAGING-BUFFER-v1.1.0 — env-level pre-flight gate. Refuse
  // before any state-machine transition or gateway call when the
  // env says live writes are off.
  const writeGates = resolveAutoCommitWriteGates();
  if (!writeGates.productionOutputWritesAllowed) {
    return {
      ok: false,
      kind: "GUARD_BLOCKED",
      opId: input.opId,
      reason:
        writeGates.reasons.productionOutput ??
        "Production-output live writes are disabled by env flag.",
    };
  }

  const gate = await checkPreCommitGate(input.opId, input.source, now);
  if (!gate.ok) {
    return { ok: false, kind: "STATE_BLOCKED", opId: input.opId, reason: gate.reason };
  }

  const claim = await claimZohoProductionOutputOpForCommit(input.opId, input.actor);
  if (!claim.ok) {
    return { ok: false, kind: "STATE_BLOCKED", opId: input.opId, reason: claim.error };
  }

  const op = claim.op;
  // Frozen payload: production-output ops carry requestPayload from
  // preview/approve/queue through to commit unchanged. No rebuild.
  const frozenPayload = op.requestPayload as Record<string, unknown>;
  // The op may already carry a commitIdempotencyKey from a prior
  // queue attempt; reuse it for the gateway's replay semantics.
  const idempotencyKey =
    op.commitIdempotencyKey ??
    `pop-${op.lumaOperationId}-${op.commitAttemptCount}`;

  // ZOHO-STAGING-BUFFER-v1.1.0 — append the commit-trigger line to the
  // frozen notes RIGHT BEFORE the gateway call. The frozen body in
  // request_payload stays untouched; only the OUTGOING payload carries
  // the suffix.
  const trigger: CommitTrigger =
    input.source === "auto"
      ? { kind: "AUTO_COMMIT_AFTER_BUFFER" }
      : { kind: "MANUAL_COMMIT_NOW", actor: input.actor.id };
  const frozenNotes =
    typeof frozenPayload["notes"] === "string"
      ? (frozenPayload["notes"] as string)
      : "";
  const outgoingNotes = appendCommitTriggerToNotes(frozenNotes, trigger, {
    // production-output preview validator caps notes at 1000 — match it
    maxLength: 1000,
  });
  const outgoingPayload: Record<string, unknown> = {
    ...frozenPayload,
    notes: outgoingNotes,
  };

  const result = await input.callable({
    requestPayload: outgoingPayload,
    commitIdempotencyKey: idempotencyKey,
  });

  if (result.ok) {
    await completeZohoProductionOutputCommitSuccess(input.opId, input.actor, {
      commitResponse: result.body,
      externalReferenceId: result.externalReferenceId ?? null,
      zohoReceiveId: result.zohoReceiveId ?? null,
      zohoBundleIds: result.zohoBundleIds ?? [],
      partialFailure: result.partialFailure ?? false,
    });
    return {
      ok: true,
      kind: "COMMITTED",
      opId: input.opId,
      externalReferenceId: result.externalReferenceId ?? null,
    };
  }

  // Failure path — classify.
  const allBlockers = extractMappingBlockers(result.body);
  const { needsReview, needsMapping } = classifyBlockers(allBlockers);

  if (needsReview.length > 0) {
    await markNeedsReview(input.opId, allBlockers, result.message, result.body, input.actor);
    return {
      ok: false,
      kind: "NEEDS_REVIEW",
      opId: input.opId,
      blockers: allBlockers,
    };
  }

  if (needsMapping.length > 0) {
    await markNeedsMapping(
      input.opId,
      needsMapping,
      result.message,
      result.body,
      input.actor,
    );
    return {
      ok: false,
      kind: "NEEDS_MAPPING",
      opId: input.opId,
      blockers: needsMapping,
    };
  }

  // Transport / 5xx → retryable; revert COMMITTING → QUEUED.
  const isTransport = result.httpStatus == null || result.httpStatus >= 500;
  if (isTransport) {
    await revertCommittingToQueued(
      input.opId,
      result.message || `Gateway ${result.httpStatus ?? "unreachable"}.`,
      input.actor,
    );
    return {
      ok: false,
      kind: "TRANSPORT_RETRYABLE",
      opId: input.opId,
      reason: result.message,
    };
  }

  // Ambiguous? Use the existing primitive to mark ambiguous —
  // structured 4xx with a known ambiguous shape that needs human eyes
  // before any retry.
  if (
    result.body &&
    typeof result.body === "object" &&
    typeof (result.body as Record<string, unknown>)["ambiguous_code"] === "string"
  ) {
    await completeZohoProductionOutputCommitAmbiguous(input.opId, input.actor, {
      commitError: result.message,
      commitResponse: result.body,
      code: String((result.body as Record<string, unknown>)["ambiguous_code"]),
    });
    return {
      ok: false,
      kind: "PERMANENT_FAILURE",
      opId: input.opId,
      reason: result.message,
    };
  }

  // 4xx without structured blockers — manual review.
  await completeZohoProductionOutputCommitFailure(input.opId, input.actor, {
    commitError: result.message,
    commitResponse: result.body,
  });
  return {
    ok: false,
    kind: "PERMANENT_FAILURE",
    opId: input.opId,
    reason: result.message,
  };
}

/** Helper for tests + cron — uses the same canonical idempotency key
 *  builder for production-output ops. */
export function buildProductionOutputCommitIdempotencyKey(
  lumaOperationId: string,
  attemptCount: number,
): string {
  // Production-output ops use the lumaOperationId as the stable
  // identifier (it's already a UUID set at preview time). We don't
  // include the payload hash here because attempting the same payload
  // twice with the same key is the WHOLE POINT — the gateway dedupes.
  // attemptCount is included only so an explicit "force retry after
  // resolving the underlying issue" path can opt into a fresh key
  // when needed.
  void attemptCount; // currently unused — see comment above
  return `pop-${lumaOperationId}`;
}
