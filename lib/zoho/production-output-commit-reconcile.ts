// ZOHO-PRODUCTION-OUTPUT-COMMIT-RECONCILE — recover Luma state from Zoho idempotency proof.

import type { CurrentUser } from "@/lib/auth";
import {
  completeZohoProductionOutputCommitAmbiguous,
  completeZohoProductionOutputCommitFailure,
  completeZohoProductionOutputCommitSuccess,
  type ZohoProductionOutputOpRow,
} from "@/lib/db/queries/zoho-production-output";
import {
  parseZohoCommitResponseIds,
} from "@/lib/zoho/production-output-source-allocations";
import {
  hashProductionOutputServicePayload,
  idempotencyReplayIndicatesSucceededCommit,
  isZohoCommitSuccessBody,
  parseZohoGatewayErrorCode,
  shouldAttemptProductionOutputIdempotencyReplay,
} from "@/lib/zoho/production-output-idempotency";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import {
  callProductionOutputCommit,
  type ProductionOutputCommitFailure,
  type ProductionOutputCommitResult,
} from "@/lib/zoho/production-output-service-client";

export type ProductionOutputCommitReconcileOutcome =
  | { kind: "success"; op: ZohoProductionOutputOpRow; reconciled: boolean }
  | { kind: "failed"; error: string; op: ZohoProductionOutputOpRow | null }
  | { kind: "ambiguous"; error: string; code: string; op: ZohoProductionOutputOpRow | null };

function attachReconcileNote(body: unknown, note: string): unknown {
  if (body == null || typeof body !== "object") {
    return { repair_note: note, raw: body };
  }
  return { ...(body as Record<string, unknown>), repair_note: note };
}

async function persistCommitSuccess(
  opId: string,
  actor: CurrentUser,
  body: unknown,
  externalReferenceId: string | null,
  reconciled: boolean,
): Promise<
  | { ok: true; op: ZohoProductionOutputOpRow }
  | { ok: false; error: string }
> {
  const parsed = parseZohoCommitResponseIds(body);
  const commitResponse = reconciled
    ? attachReconcileNote(
        body,
        "Reconciled from Zoho idempotency replay after gateway/Luma persistence mismatch.",
      )
    : body;

  return completeZohoProductionOutputCommitSuccess(opId, actor, {
    commitResponse,
    externalReferenceId,
    zohoReceiveId: parsed.receiveId,
    zohoBundleIds: parsed.bundleIds,
    humanReviewRequired: parsed.humanReviewRequired,
    partialFailure: parsed.partialFailure,
  });
}

export async function reconcileProductionOutputCommitAfterGatewayFailure(
  input: {
    opId: string;
    actor: CurrentUser;
    idempotencyKey: string;
    servicePayload: ProductionOutputPreviewPayload;
    servicePayloadHash: string;
    initial: ProductionOutputCommitFailure;
    fetchImpl?: typeof fetch;
  },
): Promise<ProductionOutputCommitReconcileOutcome> {
  const { opId, actor, idempotencyKey, servicePayload, initial } = input;

  if (idempotencyReplayIndicatesSucceededCommit(initial)) {
    const done = await persistCommitSuccess(
      opId,
      actor,
      initial.body,
      null,
      true,
    );
    if (done.ok) {
      return { kind: "success", op: done.op, reconciled: true };
    }
    return { kind: "failed", error: done.error, op: null };
  }

  if (!shouldAttemptProductionOutputIdempotencyReplay(initial)) {
    const failed = await completeZohoProductionOutputCommitFailure(opId, actor, {
      commitError: initial.message,
      commitResponse: initial.body,
    });
    if (!failed.ok) {
      return { kind: "failed", error: failed.error, op: null };
    }
    return { kind: "failed", error: initial.message, op: failed.op };
  }

  const replay = await callProductionOutputCommit({
    payload: servicePayload,
    idempotencyKey,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });

  return finalizeAfterReplayAttempt({
    opId,
    actor,
    replay,
    initial,
    servicePayloadHash: input.servicePayloadHash,
  });
}

export async function finalizeAfterReplayAttempt(input: {
  opId: string;
  actor: CurrentUser;
  replay: ProductionOutputCommitResult;
  initial: ProductionOutputCommitFailure;
  servicePayloadHash: string;
}): Promise<ProductionOutputCommitReconcileOutcome> {
  const { opId, actor, replay, initial } = input;

  if (replay.ok || idempotencyReplayIndicatesSucceededCommit(replay)) {
    const body = replay.ok ? replay.body : replay.body;
    if (!isZohoCommitSuccessBody(body)) {
      const ambiguous = await completeZohoProductionOutputCommitAmbiguous(opId, actor, {
        commitError:
          "Zoho idempotency replay returned a non-success body; operator review required.",
        commitResponse: body,
        code: "COMMIT_REPLAY_NON_SUCCESS",
      });
      if (!ambiguous.ok) {
        return { kind: "failed", error: ambiguous.error, op: null };
      }
      return {
        kind: "ambiguous",
        error: ambiguous.op.commitError ?? "Ambiguous commit outcome.",
        code: "COMMIT_REPLAY_NON_SUCCESS",
        op: ambiguous.op,
      };
    }

    const done = await persistCommitSuccess(
      opId,
      actor,
      body,
      replay.ok ? replay.externalReferenceId : null,
      true,
    );
    if (!done.ok) {
      return { kind: "failed", error: done.error, op: null };
    }
    return { kind: "success", op: done.op, reconciled: true };
  }

  const replayCode = parseZohoGatewayErrorCode(replay.body);
  if (replayCode === "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS") {
    const ambiguous = await completeZohoProductionOutputCommitAmbiguous(opId, actor, {
      commitError: replay.message,
      commitResponse: replay.body ?? initial.body,
      code: replayCode,
    });
    if (!ambiguous.ok) {
      return { kind: "failed", error: ambiguous.error, op: null };
    }
    return {
      kind: "ambiguous",
      error: replay.message,
      code: replayCode,
      op: ambiguous.op,
    };
  }

  if (replayCode === "ZOHO_IDEMPOTENCY_CONFLICT") {
    const ambiguous = await completeZohoProductionOutputCommitAmbiguous(opId, actor, {
      commitError:
        "Zoho idempotency conflict: commit key was used with a different payload. Operator review required before any live retry.",
      commitResponse: replay.body ?? initial.body,
      code: replayCode,
    });
    if (!ambiguous.ok) {
      return { kind: "failed", error: ambiguous.error, op: null };
    }
    return {
      kind: "ambiguous",
      error: ambiguous.op.commitError ?? replay.message,
      code: replayCode,
      op: ambiguous.op,
    };
  }

  const failed = await completeZohoProductionOutputCommitFailure(opId, actor, {
    commitError: replay.message,
    commitResponse: replay.body,
  });
  if (!failed.ok) {
    return { kind: "failed", error: failed.error, op: null };
  }
  return { kind: "failed", error: replay.message, op: failed.op };
}

export function buildCommitAttemptMetadata(input: {
  servicePayloadHash: string;
  idempotencyKey: string;
  httpStatus: number | null;
  errorCode: string | null;
}): Record<string, unknown> {
  return {
    service_payload_hash: input.servicePayloadHash,
    idempotency_key: input.idempotencyKey,
    http_status: input.httpStatus,
    error_code: input.errorCode,
    recorded_at: new Date().toISOString(),
  };
}
