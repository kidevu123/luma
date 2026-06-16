// ZOHO-STAGING-BUFFER-v1.1.0 — shared idempotent commit for raw-bag receives.
//
// Single entry point for BOTH the manual "Commit now" button and the
// auto-commit cron worker. Calling code does not get to choose how the
// state machine advances — every transition is owned here.
//
// State machine (this function only):
//
//   PENDING / PREVIEWED / NEEDS_MAPPING / FAILED
//       │ (atomic claim: UPDATE ... WHERE status IN (legal-pre-commit))
//       ▼
//   COMMITTING
//       │
//       ├── gateway 2xx ───────────────────────────► COMMITTED  (terminal happy)
//       ├── gateway 4xx + product mapping blockers ► NEEDS_MAPPING (fix on product page)
//       ├── gateway 4xx + OVER_RECEIVE blocker ────► NEEDS_REVIEW (business decision)
//       ├── gateway 4xx no blockers ──────────────► FAILED (manual review)
//       └── transport / 5xx ──────────────────────► PENDING (retry-eligible)
//
// HELD, VOIDED, and NEEDS_REVIEW are NOT legal pre-commit states. If
// an operator holds or voids during the buffer — or if a prior commit
// turned up an over-receive that needs a business decision — the
// claim's WHERE clause won't match and we exit early with
// STATE_BLOCKED. The cron continues to the next row; the operator
// must explicitly resolve before the row becomes committable again.
//
// NEEDS_REVIEW exists for receiving exceptions (e.g. over-receive)
// that are NOT product-setup gaps. NEEDS_MAPPING means "fix the
// product"; NEEDS_REVIEW means "make a business call." Crucially,
// NEEDS_REVIEW does NOT burn retry budget — the row stays parked
// until a human acts, which is exactly what the over-receive
// acceptance criteria require.
//
// PAYLOAD FREEZING. The 24h buffer is a review/safety buffer — if the
// underlying bag/receive data changes after the operator has reviewed,
// the buffer loses its purpose. So:
//   1. The seed/preview step (Phase E) populates
//      zoho_raw_bag_receives.commit_request_payload with the exact
//      payload that will be sent on commit.
//   2. This function PREFERS the frozen payload — it does NOT rebuild
//      from current DB truth at commit time.
//   3. For legacy rows seeded before Phase E (no frozen payload), we
//      fall back to rebuilding from context. That fallback is logged
//      in the audit trail and goes away as the queue drains.
//   4. If an operator edits the staged receive after preview, the
//      edit handler MUST regenerate the frozen payload + commit
//      idempotency key + reset auto_commit_eligible_at (so the buffer
//      restarts on the edited payload).
//
// Idempotency: commit_idempotency_key is a stable hash of (op id +
// payload-defining fields). Two replays produce the SAME key, the
// gateway treats them as the same operation, and the second call
// returns either the prior commit result (replay) or a duplicate-key
// rejection — never a double-write.

import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { zohoRawBagReceives } from "@/lib/db/schema";
import type { CurrentUser } from "@/lib/auth";
import {
  buildBagFinishReceivePayload,
  loadBagFinishReceiveContext,
} from "@/lib/zoho/bag-finish-receive";
import { callBagFinishReceiveCommit } from "@/lib/zoho/bag-finish-receive-client";
import {
  bagFinishCommitBlockedReason,
  shouldPersistBagFinishCommitFailure,
} from "@/lib/zoho/bag-finish-receive-commit-state";
import {
  parseZohoPurchaseReceiveId,
  parseZohoReceiveNumber,
} from "@/lib/zoho/zoho-purchase-receive-id";
import {
  appendCommitTriggerToNotes,
  type CommitTrigger,
} from "@/lib/zoho/zoho-commit-notes";
import { resolveAutoCommitWriteGates } from "@/lib/zoho/auto-commit-write-gates";

export type CommitSource = "manual" | "auto";

export type CommitMappingBlocker = { code: string; message: string };

/** Blocker codes that mean "business decision required" (NEEDS_REVIEW),
 *  NOT "product setup gap" (NEEDS_MAPPING). The set is closed here so
 *  the gateway can extend with new receiving-exception codes without
 *  Luma routing them to the wrong queue.
 *
 *  Future extension points (Phase 2+ overs-PO workflow):
 *   - OVER_RECEIVE_EXCEEDS_PO_REMAINING: this PR — receive qty > PO remaining
 *   - UNDER_RECEIVE_BELOW_THRESHOLD: future
 *   - LATE_RECEIVE_OUTSIDE_WINDOW: future
 *   - DUPLICATE_RECEIPT_NUMBER: future
 *  When you add a new code, add it here AND ensure the operator-facing
 *  copy in the admin queue surfaces an appropriate decision prompt. */
export const NEEDS_REVIEW_BLOCKER_CODES: ReadonlySet<string> = new Set([
  "OVER_RECEIVE_EXCEEDS_PO_REMAINING",
]);

export type SharedRawBagCommitResult =
  | {
      ok: true;
      kind: "COMMITTED";
      opId: string;
      zohoPurchaseReceiveId: string;
      attemptCount: number;
    }
  | {
      ok: false;
      kind: "STATE_BLOCKED";
      opId: string;
      reason: string;
    }
  | {
      // ZOHO-STAGING-BUFFER-v1.1.0 — env-level live-write gate is off.
      // Pre-flight check inside this fn refuses BEFORE claiming, so
      // commit_attempt_count is untouched and the gateway client is
      // never called. Manual button + cron both surface this kind.
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
      attemptCount: number;
    }
  | {
      ok: false;
      // NEEDS_REVIEW is the receiving-exception state — over-receive
      // today, more codes later. Crucially separate from NEEDS_MAPPING
      // so the operator UI and queue routing don't conflate "fix the
      // product" with "make a business call."
      kind: "NEEDS_REVIEW";
      opId: string;
      blockers: CommitMappingBlocker[];
      attemptCount: number;
    }
  | {
      ok: false;
      kind: "TRANSPORT_RETRYABLE";
      opId: string;
      reason: string;
      attemptCount: number;
    }
  | {
      ok: false;
      kind: "PERMANENT_FAILURE";
      opId: string;
      reason: string;
      attemptCount: number;
    };

/** Legal statuses to claim for commit. HELD/VOIDED/COMMITTED/COMMITTING are NOT here. */
const COMMITTABLE_STATUSES: ReadonlyArray<
  "PENDING" | "PREVIEWED" | "NEEDS_MAPPING" | "FAILED"
> = ["PENDING", "PREVIEWED", "NEEDS_MAPPING", "FAILED"];

const MAX_COMMIT_ATTEMPTS_BEFORE_PERMANENT = 5;

/** Sanity-check that a frozen payload has every field
 *  callBagFinishReceiveCommit needs. We don't trust the JSONB blob
 *  blindly — if anything is missing (e.g. a row was hand-edited via
 *  psql before Phase E backfilled the freeze), fall back to rebuild
 *  rather than send a malformed request to the gateway. */
function isCompleteFrozenPayload(payload: Record<string, unknown>): boolean {
  return (
    typeof payload["source_bag_id"] === "string" &&
    typeof payload["purchaseorder_id"] === "string" &&
    typeof payload["purchaseorder_line_item_id"] === "string" &&
    typeof payload["raw_item_id"] === "string" &&
    typeof payload["received_quantity"] === "number" &&
    typeof payload["receive_date"] === "string" &&
    typeof payload["idempotency_key"] === "string"
  );
}

/** Stable hash for commit idempotency. Replays produce the same key. */
export function buildRawBagCommitIdempotencyKey(input: {
  opId: string;
  zohoPoId: string;
  zohoLineItemId: string;
  receivedQuantity: number;
  receiveDate: string;
}): string {
  const material = [
    "v1",
    input.opId,
    input.zohoPoId,
    input.zohoLineItemId,
    String(input.receivedQuantity),
    input.receiveDate,
  ].join("|");
  return `rbg-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/** Parse structured mapping blockers from a 4xx gateway body. */
export function extractMappingBlockers(body: unknown): CommitMappingBlocker[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const raw = obj["mapping_blockers"] ?? obj["blockers"];
  if (!Array.isArray(raw)) return [];
  const out: CommitMappingBlocker[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const code = typeof o["code"] === "string" ? o["code"] : null;
    const message = typeof o["message"] === "string" ? o["message"] : null;
    if (code && message) out.push({ code, message });
  }
  return out;
}

/** Split parsed blockers into the two routing buckets. NEEDS_REVIEW
 *  wins over NEEDS_MAPPING when both are present — a business decision
 *  has to land before any product-side fix can move the row forward,
 *  and surfacing both at once is worse than surfacing the bigger one. */
export function classifyBlockers(blockers: CommitMappingBlocker[]): {
  needsReview: CommitMappingBlocker[];
  needsMapping: CommitMappingBlocker[];
} {
  const needsReview: CommitMappingBlocker[] = [];
  const needsMapping: CommitMappingBlocker[] = [];
  for (const b of blockers) {
    if (NEEDS_REVIEW_BLOCKER_CODES.has(b.code)) {
      needsReview.push(b);
    } else {
      needsMapping.push(b);
    }
  }
  return { needsReview, needsMapping };
}

/** Atomically transition row to COMMITTING. Returns null when the row is
 *  not in a committable state (held, voided, already committed,
 *  already in-flight via another worker, or parked in NEEDS_REVIEW
 *  awaiting a business decision). */
async function claimForCommit(opId: string): Promise<
  | {
      claimed: true;
      attemptCount: number;
      commitIdempotencyKey: string;
      inventoryBagId: string;
      /** Frozen payload from preview/seed time. null for legacy rows
       *  that pre-date the freeze (Phase E backfill not yet run). */
      frozenPayload: Record<string, unknown> | null;
    }
  | { claimed: false; reason: string }
> {
  const [row] = await db
    .select({
      id: zohoRawBagReceives.id,
      inventoryBagId: zohoRawBagReceives.inventoryBagId,
      status: zohoRawBagReceives.zohoReceiveStatus,
      heldAt: zohoRawBagReceives.heldAt,
      voidedAt: zohoRawBagReceives.voidedAt,
      commitIdempotencyKey: zohoRawBagReceives.commitIdempotencyKey,
      commitAttemptCount: zohoRawBagReceives.commitAttemptCount,
      commitRequestPayload: zohoRawBagReceives.commitRequestPayload,
    })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.id, opId))
    .limit(1);

  if (!row) return { claimed: false, reason: "Op not found." };
  if (row.heldAt) return { claimed: false, reason: "Op is on hold." };
  if (row.voidedAt) return { claimed: false, reason: "Op is voided." };
  if (row.status === "COMMITTED") {
    return { claimed: false, reason: "Op is already committed." };
  }
  if (row.status === "COMMITTING") {
    return { claimed: false, reason: "Op is already in flight." };
  }
  if (row.status === "NEEDS_REVIEW") {
    return {
      claimed: false,
      reason: "Op needs a business decision (e.g. over-receive). Resolve before commit.",
    };
  }
  if (row.commitAttemptCount >= MAX_COMMIT_ATTEMPTS_BEFORE_PERMANENT) {
    return {
      claimed: false,
      reason: `Op exceeded ${MAX_COMMIT_ATTEMPTS_BEFORE_PERMANENT} commit attempts; manual review required.`,
    };
  }

  const now = new Date();
  // Conditional update — only succeeds if status is STILL committable
  // when this UPDATE hits the row. Two concurrent workers race here;
  // exactly one wins because Postgres serializes the UPDATE.
  const result = await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "COMMITTING",
      commitStartedAt: now,
      commitAttemptCount: sql`${zohoRawBagReceives.commitAttemptCount} + 1`,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoRawBagReceives.id, opId),
        inArray(zohoRawBagReceives.zohoReceiveStatus, [...COMMITTABLE_STATUSES]),
        sql`${zohoRawBagReceives.heldAt} is null`,
        sql`${zohoRawBagReceives.voidedAt} is null`,
      ),
    )
    .returning({
      id: zohoRawBagReceives.id,
      commitAttemptCount: zohoRawBagReceives.commitAttemptCount,
      commitIdempotencyKey: zohoRawBagReceives.commitIdempotencyKey,
    });

  if (result.length === 0) {
    return {
      claimed: false,
      reason: "Op state changed during claim (raced with another worker or operator).",
    };
  }

  return {
    claimed: true,
    attemptCount: result[0]!.commitAttemptCount,
    commitIdempotencyKey: result[0]!.commitIdempotencyKey ?? "",
    inventoryBagId: row.inventoryBagId,
    frozenPayload:
      row.commitRequestPayload &&
      typeof row.commitRequestPayload === "object" &&
      !Array.isArray(row.commitRequestPayload)
        ? (row.commitRequestPayload as Record<string, unknown>)
        : null,
  };
}

async function transitionToCommitted(
  opId: string,
  result: {
    zohoPurchaseReceiveId: string;
    zohoReceiveNumber: string | null;
    receivedQuantity: number;
    responseBody: unknown;
  },
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "COMMITTED",
      committedAt: now,
      zohoReceivedAt: now,
      zohoPurchaseReceiveId: result.zohoPurchaseReceiveId,
      zohoReceiveNumber: result.zohoReceiveNumber,
      zohoReceivedQuantity: result.receivedQuantity,
      reconciliationStatus: "RECEIVED_BY_LUMA",
      reconciledAt: now,
      reconciledBy: actor?.id ?? null,
      commitResponsePayload: result.responseBody as object,
      commitError: null,
      mappingBlockers: null,
      zohoReceiveError: null,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.committed",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: {
      zohoPurchaseReceiveId: result.zohoPurchaseReceiveId,
      quantity: result.receivedQuantity,
      policy: "shared_commit",
    },
  });
}

async function transitionToNeedsMapping(
  opId: string,
  blockers: CommitMappingBlocker[],
  errorMessage: string,
  responseBody: unknown,
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "NEEDS_MAPPING",
      mappingBlockers: blockers,
      commitError: errorMessage,
      commitResponsePayload: responseBody as object,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.needs_mapping",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { blockers, message: errorMessage },
  });
}

async function transitionToNeedsReview(
  opId: string,
  blockers: CommitMappingBlocker[],
  errorMessage: string,
  responseBody: unknown,
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "NEEDS_REVIEW",
      mappingBlockers: blockers,
      commitError: errorMessage,
      commitResponsePayload: responseBody as object,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.needs_review",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { blockers, message: errorMessage },
  });
}

async function transitionToRetryable(
  opId: string,
  errorMessage: string,
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<void> {
  const now = new Date();
  // Bounce back to PENDING so the cron picks it up again. We don't push
  // auto_commit_eligible_at out — the worker's filter already includes
  // "no in-flight commit", and we want the retry to happen on the next
  // pass.
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "PENDING",
      commitError: errorMessage,
      commitStartedAt: null,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.transport_retryable",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { message: errorMessage },
  });
}

async function transitionToPermanentFailure(
  opId: string,
  errorMessage: string,
  responseBody: unknown,
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "FAILED",
      commitError: errorMessage,
      commitResponsePayload: responseBody as object,
      zohoReceiveError: errorMessage,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.permanent_failure",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: { message: errorMessage },
  });
}

/** Persist the commit idempotency key + request payload at claim time so
 *  the gateway sees the SAME key on every retry. */
async function persistCommitMaterials(
  opId: string,
  idempotencyKey: string,
  requestPayload: unknown,
): Promise<void> {
  await db
    .update(zohoRawBagReceives)
    .set({
      commitIdempotencyKey: idempotencyKey,
      commitRequestPayload: requestPayload as object,
      updatedAt: new Date(),
    })
    .where(eq(zohoRawBagReceives.id, opId));
}

export type SharedRawBagCommitInput = {
  /** zoho_raw_bag_receives.id — the staged op to commit. */
  opId: string;
  /** "manual" = operator clicked Commit now; "auto" = buffer expired + cron picked it up. */
  source: CommitSource;
  /** Operator on manual path; null for auto. Used for audit + reconciled_by. */
  actor: Pick<CurrentUser, "id" | "role"> | null;
};

/** The single shared commit function. Manual button and auto-commit
 *  cron both call this; the state machine is owned here, not in the
 *  caller. */
export async function sharedCommitRawBagReceive(
  input: SharedRawBagCommitInput,
): Promise<SharedRawBagCommitResult> {
  // ZOHO-STAGING-BUFFER-v1.1.0 — pre-flight gate check. If the env
  // says live writes are off (first-deploy posture), refuse BEFORE
  // claiming the row. This keeps commit_attempt_count untouched and
  // means the gateway client is never invoked. Same outcome whether
  // the trigger was the cron or the manual button.
  const gates = resolveAutoCommitWriteGates();
  if (!gates.rawBagWritesAllowed) {
    return {
      ok: false,
      kind: "GUARD_BLOCKED",
      opId: input.opId,
      reason:
        gates.reasons.rawBag ??
        "Raw-bag live writes are disabled by env flag.",
    };
  }

  const claim = await claimForCommit(input.opId);
  if (!claim.claimed) {
    return { ok: false, kind: "STATE_BLOCKED", opId: input.opId, reason: claim.reason };
  }

  // Prefer the frozen payload from preview/seed (the buffer's whole
  // point — operator reviewed THIS payload, not whatever DB truth
  // happens to look like now). For legacy rows that pre-date Phase E,
  // fall back to rebuilding from current context.
  let payload: import("@/lib/zoho/bag-finish-receive-client").BagFinishReceiveRequest;
  let buildInput: {
    inventoryBagId: string;
    zohoPoId: string;
    zohoLineItemId: string;
    receivedQuantity: number;
    receiveDate: string;
  };
  if (claim.frozenPayload && isCompleteFrozenPayload(claim.frozenPayload)) {
    payload =
      claim.frozenPayload as unknown as import("@/lib/zoho/bag-finish-receive-client").BagFinishReceiveRequest;
    buildInput = {
      inventoryBagId: payload.source_bag_id,
      zohoPoId: payload.purchaseorder_id,
      zohoLineItemId: payload.purchaseorder_line_item_id,
      receivedQuantity: payload.received_quantity,
      receiveDate: payload.receive_date,
    };
  } else {
    const ctx = await loadBagFinishReceiveContext(claim.inventoryBagId);
    if (!ctx.ok) {
      // Context lost between intake and commit — surface as NEEDS_MAPPING
      // so the operator knows to look at it.
      await transitionToNeedsMapping(
        input.opId,
        [{ code: "CONTEXT_MISSING", message: ctx.reason }],
        ctx.reason,
        null,
        input.actor,
      );
      return {
        ok: false,
        kind: "NEEDS_MAPPING",
        opId: input.opId,
        blockers: [{ code: "CONTEXT_MISSING", message: ctx.reason }],
        attemptCount: claim.attemptCount,
      };
    }
    if (!ctx.eligibility.eligible) {
      await transitionToNeedsMapping(
        input.opId,
        [{ code: "INELIGIBLE", message: ctx.eligibility.reason }],
        ctx.eligibility.reason,
        null,
        input.actor,
      );
      return {
        ok: false,
        kind: "NEEDS_MAPPING",
        opId: input.opId,
        blockers: [{ code: "INELIGIBLE", message: ctx.eligibility.reason }],
        attemptCount: claim.attemptCount,
      };
    }
    payload = buildBagFinishReceivePayload(ctx.buildInput);
    buildInput = ctx.buildInput;
  }

  // Reuse the stored commit idempotency key if one exists (retry replay);
  // otherwise derive it from the op + payload-defining fields. Either
  // way, the SAME inputs always produce the SAME key.
  const idempotencyKey =
    claim.commitIdempotencyKey ||
    buildRawBagCommitIdempotencyKey({
      opId: input.opId,
      zohoPoId: buildInput.zohoPoId,
      zohoLineItemId: buildInput.zohoLineItemId,
      receivedQuantity: buildInput.receivedQuantity,
      receiveDate: buildInput.receiveDate,
    });
  await persistCommitMaterials(input.opId, idempotencyKey, payload);

  // ZOHO-STAGING-BUFFER-v1.1.0 — append the commit-trigger line to the
  // frozen notes RIGHT BEFORE the gateway call. The frozen body in
  // commit_request_payload is never mutated; only the OUTGOING payload
  // carries the suffix. This preserves the "notes are frozen at
  // preview/seed" contract while still telling Zoho-side accounting
  // who actually pushed.
  const trigger: CommitTrigger =
    input.source === "auto"
      ? { kind: "AUTO_COMMIT_AFTER_BUFFER" }
      : { kind: "MANUAL_COMMIT_NOW", actor: input.actor?.id ?? null };
  const frozenNotes =
    typeof (payload as { notes?: unknown }).notes === "string"
      ? (payload as { notes: string }).notes
      : "";
  const outgoingNotes = appendCommitTriggerToNotes(frozenNotes, trigger);

  const result = await callBagFinishReceiveCommit({
    ...payload,
    idempotency_key: idempotencyKey,
    notes: outgoingNotes,
  });

  if (result.ok) {
    const zohoPurchaseReceiveId = parseZohoPurchaseReceiveId(result.body);
    if (!zohoPurchaseReceiveId) {
      const msg = "Zoho response did not include purchase_receive_id.";
      await transitionToPermanentFailure(input.opId, msg, result.body, input.actor);
      return {
        ok: false,
        kind: "PERMANENT_FAILURE",
        opId: input.opId,
        reason: msg,
        attemptCount: claim.attemptCount,
      };
    }
    const zohoReceiveNumber = parseZohoReceiveNumber(result.body);
    await transitionToCommitted(
      input.opId,
      {
        zohoPurchaseReceiveId,
        zohoReceiveNumber,
        receivedQuantity: buildInput.receivedQuantity,
        responseBody: result.body,
      },
      input.actor,
    );
    return {
      ok: true,
      kind: "COMMITTED",
      opId: input.opId,
      zohoPurchaseReceiveId,
      attemptCount: claim.attemptCount,
    };
  }

  // Failure path — classify it. NEEDS_REVIEW (over-receive etc.) wins
  // over NEEDS_MAPPING when both are present because a business
  // decision must land before any product-side fix can move the row
  // forward. Routing both at once would scatter the operator across
  // two queues for the same row.
  const allBlockers = extractMappingBlockers(result.body);
  const { needsReview, needsMapping } = classifyBlockers(allBlockers);
  if (needsReview.length > 0) {
    await transitionToNeedsReview(
      input.opId,
      // Pass ALL blockers — the queue UI shows both buckets, the
      // operator decides which to act on first. The status routing
      // alone tells them which queue this row sits in.
      allBlockers,
      result.message,
      result.body,
      input.actor,
    );
    return {
      ok: false,
      kind: "NEEDS_REVIEW",
      opId: input.opId,
      blockers: allBlockers,
      attemptCount: claim.attemptCount,
    };
  }
  if (needsMapping.length > 0) {
    await transitionToNeedsMapping(
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
      attemptCount: claim.attemptCount,
    };
  }

  // Transport / 5xx → retry on the next worker pass.
  const isTransportFailure = result.httpStatus == null || result.httpStatus >= 500;
  if (isTransportFailure) {
    await transitionToRetryable(
      input.opId,
      result.message ||
        (result.httpStatus == null ? "Gateway unreachable." : `Gateway ${result.httpStatus}.`),
      input.actor,
    );
    return {
      ok: false,
      kind: "TRANSPORT_RETRYABLE",
      opId: input.opId,
      reason: result.message,
      attemptCount: claim.attemptCount,
    };
  }

  // 4xx without structured blockers — manual review.
  const reason = bagFinishCommitBlockedReason(result);
  if (shouldPersistBagFinishCommitFailure(result)) {
    await transitionToPermanentFailure(input.opId, reason, result.body, input.actor);
  } else {
    // Guard-blocked (e.g. ZOHO_DRY_RUN_WRITES_ENABLED=false). Don't mark
    // FAILED — bounce back to PENDING so the next attempt (once the
    // env flag is corrected) can proceed.
    await transitionToRetryable(input.opId, reason, input.actor);
    return {
      ok: false,
      kind: "TRANSPORT_RETRYABLE",
      opId: input.opId,
      reason,
      attemptCount: claim.attemptCount,
    };
  }
  return {
    ok: false,
    kind: "PERMANENT_FAILURE",
    opId: input.opId,
    reason,
    attemptCount: claim.attemptCount,
  };
}
