import { and, count, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  zohoAssemblyOps,
  zohoProductionOutputOps,
  zohoPushes,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import type {
  ProductionOutputDataQualityState,
  ProductionOutputPreviewPayload,
} from "@/lib/zoho/production-output-preview";
import {
  buildZohoProductionOutputCommitIdempotencyKey,
  canVoidZohoProductionOutputOp,
  evaluateZohoProductionOutputCommitReadiness,
  evaluateZohoProductionOutputProcessCommitEligibility,
  evaluateZohoProductionOutputQueueEligibility,
  evaluateZohoProductionOutputApproval,
  type ZohoProductionOutputCommitReadiness,
  type ZohoProductionOutputOpStatus,
  type ZohoProductionOutputProcessCommitEligibility,
  type ZohoProductionOutputQueueEligibility,
} from "@/lib/zoho/production-output-approval";
import {
  mockCallZohoProductionOutputCommit,
  type MockProductionOutputCommitFixture,
  type MockProductionOutputCommitResult,
} from "@/lib/zoho/production-output-commit-mock";

export type ZohoProductionOutputOpRow =
  typeof zohoProductionOutputOps.$inferSelect;

export type { ZohoProductionOutputOpStatus };

export type ZohoProductionOutputPreviewMetadata = {
  id: string;
  status: ZohoProductionOutputOpStatus;
  requestHash: string;
  approvedRequestHash: string | null;
  metricsState: ProductionOutputDataQualityState;
  genealogyState: ProductionOutputDataQualityState;
  previewedAt: Date | null;
  previewHttpStatus: number | null;
  hasPreviewResponse: boolean;
  approvedAt: Date | null;
  approvalEligible: boolean;
  approvalBlockers: string[];
  commitReadiness?: ZohoProductionOutputCommitReadiness;
  queueEligible?: boolean;
  queueBlockers?: string[];
  commitRequestedAt?: Date | null;
  commitIdempotencyKey?: string | null;
  commitStartedAt?: Date | null;
  committedAt?: Date | null;
  commitFinishedAt?: Date | null;
  commitAttemptCount?: number;
  commitError?: string | null;
  externalReferenceId?: string | null;
  zohoPurchaseorderId: string | null;
  zohoPurchaseorderLineItemId: string | null;
  zohoWarehouseId: string | null;
  zohoCompositeItemId: string | null;
};

export type UpsertZohoProductionOutputPreviewOpInput = {
  finishedLotId: string;
  workflowBagId: string | null;
  lumaOperationId: string;
  status: "DRAFT" | "PREVIEWED";
  payload: ProductionOutputPreviewPayload;
  requestHash: string;
  previewIdempotencyKey: string;
  previewHttpStatus: number | null;
  previewResponse: unknown;
  metricsState: ProductionOutputDataQualityState;
  genealogyState: ProductionOutputDataQualityState;
  userId: string | null;
};

type ZohoProductionOutputPreviewOpValues =
  typeof zohoProductionOutputOps.$inferInsert;

export function buildZohoProductionOutputPreviewOpValues(
  input: UpsertZohoProductionOutputPreviewOpInput,
  now = new Date(),
): ZohoProductionOutputPreviewOpValues {
  const wasPreviewed = input.status === "PREVIEWED";
  const metricsAreKnown = input.metricsState !== "MISSING";

  return {
    lumaOperationId: input.lumaOperationId,
    finishedLotId: input.finishedLotId,
    workflowBagId: input.workflowBagId,
    status: input.status,
    zohoPurchaseorderId: input.payload.purchaseorder_id,
    zohoPurchaseorderLineItemId: input.payload.purchaseorder_line_item_id,
    zohoWarehouseId: input.payload.warehouse_id,
    zohoCompositeItemId: input.payload.unit_composite_item_id,
    zohoDisplayCompositeItemId: input.payload.display_composite_item_id ?? null,
    zohoCaseCompositeItemId: input.payload.case_composite_item_id ?? null,
    quantityGood: input.payload.quantity_good,
    unitAssemblyQuantity: input.payload.unit_assembly_quantity,
    displayAssemblyQuantity: input.payload.display_assembly_quantity,
    caseAssemblyQuantity: input.payload.case_assembly_quantity,
    quantityDamaged: metricsAreKnown ? input.payload.quantity_damaged : null,
    quantityRipped: metricsAreKnown ? input.payload.quantity_ripped : null,
    quantityLoose: metricsAreKnown ? input.payload.quantity_loose : null,
    quantityBasis: {
      quantity_good: input.payload.quantity_good,
      unit_assembly_quantity: input.payload.unit_assembly_quantity,
      display_assembly_quantity: input.payload.display_assembly_quantity,
      case_assembly_quantity: input.payload.case_assembly_quantity,
      receive_date: input.payload.receive_date,
    },
    metricsState: input.metricsState,
    genealogyState: input.genealogyState,
    requestPayload: input.payload,
    requestHash: input.requestHash,
    previewIdempotencyKey: input.previewIdempotencyKey,
    previewHttpStatus: input.previewHttpStatus,
    previewResponse: input.previewResponse,
    previewedByUserId: wasPreviewed ? input.userId : null,
    previewedAt: wasPreviewed ? now : null,
    selectedByUserId: input.userId,
    selectedAt: now,
    updatedAt: now,
  };
}

export async function upsertZohoProductionOutputPreviewOp(
  input: UpsertZohoProductionOutputPreviewOpInput,
): Promise<ZohoProductionOutputPreviewMetadata> {
  const values = buildZohoProductionOutputPreviewOpValues(input);
  const [existing] = await db
    .select({
      id: zohoProductionOutputOps.id,
      status: zohoProductionOutputOps.status,
    })
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.finishedLotId, input.finishedLotId),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .limit(1);

  if (
    existing &&
    existing.status !== "DRAFT" &&
    existing.status !== "PREVIEWED"
  ) {
    throw new Error(
      "This production-output operation is frozen. Void it before running a new preview.",
    );
  }

  if (existing) {
    const [updated] = await db
      .update(zohoProductionOutputOps)
      .set(values)
      .where(eq(zohoProductionOutputOps.id, existing.id))
      .returning();
    if (!updated)
      throw new Error("Failed to update Zoho production output preview row.");
    return toPreviewMetadata(updated);
  }

  const [inserted] = await db
    .insert(zohoProductionOutputOps)
    .values(values)
    .returning();
  if (!inserted)
    throw new Error("Failed to insert Zoho production output preview row.");
  return toPreviewMetadata(inserted);
}

export async function getActiveZohoProductionOutputOpForLot(
  finishedLotId: string,
): Promise<ZohoProductionOutputPreviewMetadata | null> {
  const [row] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.finishedLotId, finishedLotId),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return withCommitAndQueueState(toPreviewMetadata(row), row);
}

export async function getZohoProductionOutputCommitReadinessForOp(
  opId: string,
): Promise<ZohoProductionOutputCommitReadiness | null> {
  const [row] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);
  if (!row) return null;
  return evaluateCommitReadinessFromDb(row);
}

export async function approveZohoProductionOutputOp(
  opId: string,
  actor: CurrentUser,
): Promise<
  { ok: true; metadata: ZohoProductionOutputPreviewMetadata } | { ok: false; error: string }
> {
  const [row] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);

  if (!row) return { ok: false, error: "Production output operation not found." };

  const evaluation = evaluateZohoProductionOutputApproval({
    status: row.status as ZohoProductionOutputOpStatus,
    voidedAt: row.voidedAt,
    previewResponse: row.previewResponse,
    previewHttpStatus: row.previewHttpStatus,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    requestHash: row.requestHash,
    approvedRequestHash: row.approvedRequestHash,
  });

  if (!evaluation.eligible) {
    return {
      ok: false,
      error: evaluation.reasons[0] ?? "This preview cannot be approved.",
    };
  }

  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      status: "APPROVED",
      approvedAt: now,
      approvedByUserId: actor.id,
      approvedRequestHash: row.requestHash,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "PREVIEWED"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .returning();

  if (!updated) {
    return {
      ok: false,
      error: "Preview changed before approval could be saved. Refresh and try again.",
    };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.approve",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    before: { status: row.status, requestHash: row.requestHash },
    after: {
      status: "APPROVED",
      approvedRequestHash: row.requestHash,
      metricsState: row.metricsState,
      genealogyState: row.genealogyState,
    },
  });

  return { ok: true, metadata: toPreviewMetadata(updated) };
}

export async function voidZohoProductionOutputOp(
  opId: string,
  reason: string,
  actor: CurrentUser,
): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false, error: "Void reason is required." };
  }

  const [row] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);

  if (!row) return { ok: false, error: "Production output operation not found." };

  const canVoid = canVoidZohoProductionOutputOp({
    status: row.status as ZohoProductionOutputOpStatus,
    voidedAt: row.voidedAt,
  });
  if (!canVoid.ok) return canVoid;

  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      status: "VOIDED",
      voidedAt: now,
      voidedByUserId: actor.id,
      voidReason: trimmed,
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
    return { ok: false, error: "This operation was already voided." };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.void",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    before: { status: row.status },
    after: { status: "VOIDED", voidReason: trimmed },
  });

  return { ok: true };
}

export async function queueZohoProductionOutputOpForFutureCommit(
  opId: string,
  actor: CurrentUser,
): Promise<
  | {
      ok: true;
      metadata: ZohoProductionOutputPreviewMetadata;
      queueEligibility: ZohoProductionOutputQueueEligibility;
    }
  | { ok: false; error: string }
> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(zohoProductionOutputOps)
      .where(eq(zohoProductionOutputOps.id, opId))
      .limit(1);

    if (!row) {
      return { ok: false, error: "Production output operation not found." };
    }

    if (row.status === "QUEUED") {
      return {
        ok: false,
        error: "Already queued for future commit.",
      };
    }

    const queueEligibility = await evaluateQueueEligibilityFromDbRow(tx, row);

    if (!queueEligibility.eligible) {
      return {
        ok: false,
        error:
          queueEligibility.blockers[0]?.message ??
          "This operation cannot be queued for future commit.",
      };
    }

    const commitIdempotencyKey =
      queueEligibility.commitIdempotencyKey ??
      buildZohoProductionOutputCommitIdempotencyKey(
        row.lumaOperationId,
        row.approvedRequestHash ?? row.requestHash,
      );

    const now = new Date();
    const [updated] = await tx
      .update(zohoProductionOutputOps)
      .set({
        status: "QUEUED",
        commitRequestedAt: now,
        commitRequestedByUserId: actor.id,
        commitIdempotencyKey,
        updatedAt: now,
      })
      .where(
        and(
          eq(zohoProductionOutputOps.id, opId),
          eq(zohoProductionOutputOps.status, "APPROVED"),
          isNull(zohoProductionOutputOps.voidedAt),
          isNull(zohoProductionOutputOps.commitRequestedAt),
        ),
      )
      .returning();

    if (!updated) {
      const [latest] = await tx
        .select({ status: zohoProductionOutputOps.status })
        .from(zohoProductionOutputOps)
        .where(eq(zohoProductionOutputOps.id, opId))
        .limit(1);
      if (latest?.status === "QUEUED") {
        return {
          ok: false,
          error: "Already queued for future commit.",
        };
      }
      return {
        ok: false,
        error:
          "Queue could not be saved. Refresh and confirm the operation is still approved and ready.",
      };
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "zoho_production_output_op.queue",
      targetType: "ZohoProductionOutputOp",
      targetId: opId,
      before: {
        status: row.status,
        commitRequestedAt: row.commitRequestedAt,
        commitIdempotencyKey: row.commitIdempotencyKey,
      },
      after: {
        status: "QUEUED",
        commitRequestedAt: now.toISOString(),
        commitRequestedByUserId: actor.id,
        commitIdempotencyKey,
        commitAttemptCount: 0,
      },
    });

    const metadata = toPreviewMetadata(updated);
    return {
      ok: true,
      metadata: {
        ...metadata,
        commitRequestedAt: updated.commitRequestedAt,
        commitIdempotencyKey: updated.commitIdempotencyKey,
        queueEligible: false,
        queueBlockers: ["Already queued for future commit."],
      },
      queueEligibility,
    };
  });
}

export async function claimZohoProductionOutputOpForCommit(
  opId: string,
  actor: CurrentUser,
): Promise<
  | { ok: true; op: ZohoProductionOutputOpRow }
  | { ok: false; error: string; eligibility?: ZohoProductionOutputProcessCommitEligibility }
> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(zohoProductionOutputOps)
      .where(eq(zohoProductionOutputOps.id, opId))
      .limit(1);

    if (!row) {
      return { ok: false, error: "Production output operation not found." };
    }

    const eligibility = await evaluateProcessCommitEligibilityFromDbRow(tx, row);

    if (!eligibility.eligible) {
      return {
        ok: false,
        error:
          eligibility.blockers[0]?.message ??
          "This operation cannot be claimed for commit.",
        eligibility,
      };
    }

    const now = new Date();
    const [updated] = await tx
      .update(zohoProductionOutputOps)
      .set({
        status: "COMMITTING",
        commitStartedAt: now,
        lastCommitAttemptAt: now,
        commitAttemptCount: row.commitAttemptCount + 1,
        commitError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(zohoProductionOutputOps.id, opId),
          eq(zohoProductionOutputOps.status, "QUEUED"),
          isNull(zohoProductionOutputOps.voidedAt),
        ),
      )
      .returning();

    if (!updated) {
      const [latest] = await tx
        .select({ status: zohoProductionOutputOps.status })
        .from(zohoProductionOutputOps)
        .where(eq(zohoProductionOutputOps.id, opId))
        .limit(1);
      if (latest?.status === "COMMITTING") {
        return {
          ok: false,
          error: "This operation is already being committed.",
        };
      }
      if (latest?.status === "COMMITTED") {
        return { ok: false, error: "This operation is already committed." };
      }
      return {
        ok: false,
        error:
          "Commit claim could not be saved. Refresh and confirm the operation is still queued.",
      };
    }

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "zoho_production_output_op.commit_started",
        targetType: "ZohoProductionOutputOp",
        targetId: opId,
        before: { status: row.status, commitAttemptCount: row.commitAttemptCount },
        after: {
          status: "COMMITTING",
          commitStartedAt: now.toISOString(),
          commitAttemptCount: updated.commitAttemptCount,
        },
      },
      tx,
    );

    return { ok: true, op: updated };
  });
}

export async function completeZohoProductionOutputCommitSuccess(
  opId: string,
  actor: CurrentUser,
  input: {
    commitResponse: unknown;
    externalReferenceId?: string | null;
    zohoReceiveId?: string | null;
    zohoBundleIds?: string[];
    humanReviewRequired?: boolean;
    partialFailure?: boolean;
  },
): Promise<
  | { ok: true; op: ZohoProductionOutputOpRow }
  | { ok: false; error: string }
> {
  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      status: input.partialFailure ? "FAILED" : "COMMITTED",
      committedAt: input.partialFailure ? null : now,
      commitFinishedAt: now,
      commitResponse: input.commitResponse,
      externalReferenceId: input.externalReferenceId ?? null,
      zohoReceiveId: input.zohoReceiveId ?? null,
      zohoBundleIds: input.zohoBundleIds ?? [],
      humanReviewRequired: input.humanReviewRequired ?? false,
      partialFailure: input.partialFailure ?? false,
      commitStatus: input.partialFailure ? "partial_failure" : "committed",
      commitError: input.partialFailure
        ? "Zoho commit returned partial_failure — human review required."
        : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "COMMITTING"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .returning();

  if (!updated) {
    return {
      ok: false,
      error: "Only COMMITTING operations can be marked committed.",
    };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.commit_succeeded",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    before: { status: "COMMITTING" },
    after: {
      status: "COMMITTED",
      externalReferenceId: updated.externalReferenceId,
      committedAt: now.toISOString(),
    },
  });

  return { ok: true, op: updated };
}

export async function completeZohoProductionOutputCommitAmbiguous(
  opId: string,
  actor: CurrentUser,
  input: {
    commitError: string;
    commitResponse?: unknown;
    code: string;
  },
): Promise<
  | { ok: true; op: ZohoProductionOutputOpRow }
  | { ok: false; error: string }
> {
  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      status: "FAILED",
      commitFinishedAt: now,
      commitError: input.commitError,
      commitResponse: input.commitResponse ?? null,
      commitStatus: "ambiguous_needs_review",
      humanReviewRequired: true,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "COMMITTING"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .returning();

  if (!updated) {
    return {
      ok: false,
      error: "Only COMMITTING operations can be marked ambiguous.",
    };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.commit_ambiguous",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    before: { status: "COMMITTING" },
    after: {
      status: "FAILED",
      commitStatus: "ambiguous_needs_review",
      code: input.code,
    },
  });

  return { ok: true, op: updated };
}

export async function completeZohoProductionOutputCommitFailure(
  opId: string,
  actor: CurrentUser,
  input: {
    commitError: string;
    commitResponse?: unknown;
  },
): Promise<
  | { ok: true; op: ZohoProductionOutputOpRow }
  | { ok: false; error: string }
> {
  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      status: "FAILED",
      commitFinishedAt: now,
      commitError: input.commitError,
      commitResponse: input.commitResponse ?? null,
      commitStatus: "failed",
      humanReviewRequired: false,
      updatedAt: now,
    })
    .where(
      and(
        eq(zohoProductionOutputOps.id, opId),
        eq(zohoProductionOutputOps.status, "COMMITTING"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .returning();

  if (!updated) {
    return {
      ok: false,
      error: "Only COMMITTING operations can be marked failed.",
    };
  }

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "zoho_production_output_op.commit_failed",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    before: { status: "COMMITTING" },
    after: {
      status: "FAILED",
      commitError: input.commitError,
      commitFinishedAt: now.toISOString(),
    },
  });

  return { ok: true, op: updated };
}

export type ProcessQueuedZohoProductionOutputCommitWithMockResult =
  | { ok: true; op: ZohoProductionOutputOpRow; gateway: MockProductionOutputCommitResult }
  | {
      ok: false;
      error: string;
      phase: "claim" | "gateway" | "complete";
      eligibility?: ZohoProductionOutputProcessCommitEligibility;
    };

/**
 * C3a test/future-C3b orchestrator — not wired to UI or workers.
 */
export async function processQueuedZohoProductionOutputCommitWithMockGateway(
  opId: string,
  actor: CurrentUser,
  fixture: MockProductionOutputCommitFixture,
): Promise<ProcessQueuedZohoProductionOutputCommitWithMockResult> {
  const claim = await claimZohoProductionOutputOpForCommit(opId, actor);
  if (!claim.ok) {
    return {
      ok: false,
      error: claim.error,
      phase: "claim",
      ...(claim.eligibility !== undefined
        ? { eligibility: claim.eligibility }
        : {}),
    };
  }

  const requestPayload = claim.op.requestPayload;
  if (requestPayload == null || typeof requestPayload !== "object") {
    await completeZohoProductionOutputCommitFailure(opId, actor, {
      commitError: "Stored request payload is missing.",
    });
    return {
      ok: false,
      error: "Stored request payload is missing.",
      phase: "gateway",
    };
  }

  const idempotencyKey = claim.op.commitIdempotencyKey;
  if (idempotencyKey == null) {
    await completeZohoProductionOutputCommitFailure(opId, actor, {
      commitError: "Commit idempotency key is missing.",
    });
    return {
      ok: false,
      error: "Commit idempotency key is missing.",
      phase: "gateway",
    };
  }

  const gateway = mockCallZohoProductionOutputCommit({
    requestPayload: requestPayload as Record<string, unknown>,
    commitIdempotencyKey: idempotencyKey,
    fixture,
  });

  if (gateway.ok) {
    const done = await completeZohoProductionOutputCommitSuccess(opId, actor, {
      commitResponse: gateway.body,
      externalReferenceId: gateway.externalReferenceId,
    });
    if (!done.ok) {
      return { ok: false, error: done.error, phase: "complete" };
    }
    return { ok: true, op: done.op, gateway };
  }

  const failed = await completeZohoProductionOutputCommitFailure(opId, actor, {
    commitError: gateway.message,
    commitResponse: gateway.body,
  });
  if (!failed.ok) {
    return { ok: false, error: failed.error, phase: "complete" };
  }
  return {
    ok: false,
    error: gateway.message,
    phase: "gateway",
  };
}

function toPreviewMetadata(
  row: typeof zohoProductionOutputOps.$inferSelect,
): ZohoProductionOutputPreviewMetadata {
  const status = row.status as ZohoProductionOutputOpStatus;
  const evaluation = evaluateZohoProductionOutputApproval({
    status,
    voidedAt: row.voidedAt,
    previewResponse: row.previewResponse,
    previewHttpStatus: row.previewHttpStatus,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    requestHash: row.requestHash,
    approvedRequestHash: row.approvedRequestHash,
  });

  return {
    id: row.id,
    status,
    requestHash: row.requestHash,
    approvedRequestHash: row.approvedRequestHash,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    previewedAt: row.previewedAt,
    previewHttpStatus: row.previewHttpStatus,
    hasPreviewResponse: row.previewResponse != null,
    approvedAt: row.approvedAt,
    approvalEligible: evaluation.eligible,
    approvalBlockers: evaluation.reasons,
    zohoPurchaseorderId: row.zohoPurchaseorderId,
    zohoPurchaseorderLineItemId: row.zohoPurchaseorderLineItemId,
    zohoWarehouseId: row.zohoWarehouseId,
    zohoCompositeItemId: row.zohoCompositeItemId,
  };
}

async function withCommitAndQueueState(
  metadata: ZohoProductionOutputPreviewMetadata,
  row: typeof zohoProductionOutputOps.$inferSelect,
): Promise<ZohoProductionOutputPreviewMetadata> {
  const base = {
    ...metadata,
    commitRequestedAt: row.commitRequestedAt,
    commitIdempotencyKey: row.commitIdempotencyKey,
    commitStartedAt: row.commitStartedAt,
    committedAt: row.committedAt,
    commitFinishedAt: row.commitFinishedAt,
    commitAttemptCount: row.commitAttemptCount,
    commitError: row.commitError,
    externalReferenceId: row.externalReferenceId,
  };

  if (row.status === "QUEUED") {
    return {
      ...base,
      queueEligible: false,
      queueBlockers: ["Already queued for future commit."],
    };
  }

  if (row.status !== "APPROVED") return base;

  const commitReadiness = await evaluateCommitReadinessFromDb(row);
  const queueEligibility = await evaluateQueueEligibilityFromDbRow(db, row);
  return {
    ...base,
    commitReadiness,
    queueEligible: queueEligibility.eligible,
    queueBlockers: queueEligibility.blockers.map((b) => b.message),
  };
}

async function loadProductionOutputOpCommitContext(
  executor: Pick<typeof db, "select">,
  row: ZohoProductionOutputOpRow,
) {
  const [
    finishedLotCount,
    committedOpCount,
    legacyAssemblyOpCount,
    legacyZohoPushCount,
  ] = await Promise.all([
    executor
      .select({ value: count() })
      .from(finishedLots)
      .where(eq(finishedLots.id, row.finishedLotId)),
    executor
      .select({ value: count() })
      .from(zohoProductionOutputOps)
      .where(
        and(
          eq(zohoProductionOutputOps.finishedLotId, row.finishedLotId),
          eq(zohoProductionOutputOps.status, "COMMITTED"),
          ne(zohoProductionOutputOps.id, row.id),
        ),
      ),
    executor
      .select({ value: count() })
      .from(zohoAssemblyOps)
      .where(eq(zohoAssemblyOps.finishedLotId, row.finishedLotId)),
    executor
      .select({ value: count() })
      .from(zohoPushes)
      .where(
        and(
          eq(zohoPushes.finishedLotId, row.finishedLotId),
          eq(zohoPushes.status, "SUCCESS"),
        ),
      ),
  ]);

  return {
    finishedLotExists: (finishedLotCount[0]?.value ?? 0) > 0,
    committedOpExists: (committedOpCount[0]?.value ?? 0) > 0,
    legacyAssemblyOpExists: (legacyAssemblyOpCount[0]?.value ?? 0) > 0,
    legacyZohoPushExists: (legacyZohoPushCount[0]?.value ?? 0) > 0,
  };
}

async function evaluateQueueEligibilityFromDbRow(
  executor: Pick<typeof db, "select">,
  row: ZohoProductionOutputOpRow,
): Promise<ZohoProductionOutputQueueEligibility> {
  const context = await loadProductionOutputOpCommitContext(executor, row);

  return evaluateZohoProductionOutputQueueEligibility({
    lumaOperationId: row.lumaOperationId,
    status: row.status as ZohoProductionOutputOpStatus,
    voidedAt: row.voidedAt,
    approvedRequestHash: row.approvedRequestHash,
    requestHash: row.requestHash,
    requestPayload: row.requestPayload,
    previewResponse: row.previewResponse,
    previewHttpStatus: row.previewHttpStatus,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    ...context,
    commitRequestedAt: row.commitRequestedAt,
    commitIdempotencyKey: row.commitIdempotencyKey,
  });
}

async function evaluateProcessCommitEligibilityFromDbRow(
  executor: Pick<typeof db, "select">,
  row: ZohoProductionOutputOpRow,
): Promise<ZohoProductionOutputProcessCommitEligibility> {
  const context = await loadProductionOutputOpCommitContext(executor, row);

  return evaluateZohoProductionOutputProcessCommitEligibility({
    opExists: true,
    status: row.status as ZohoProductionOutputOpStatus,
    voidedAt: row.voidedAt,
    lumaOperationId: row.lumaOperationId,
    approvedRequestHash: row.approvedRequestHash,
    requestHash: row.requestHash,
    requestPayload: row.requestPayload,
    previewResponse: row.previewResponse,
    previewHttpStatus: row.previewHttpStatus,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    ...context,
    commitIdempotencyKey: row.commitIdempotencyKey,
    externalReferenceId: row.externalReferenceId,
  });
}

async function evaluateCommitReadinessFromDb(
  row: ZohoProductionOutputOpRow,
): Promise<ZohoProductionOutputCommitReadiness> {
  const context = await loadProductionOutputOpCommitContext(db, row);

  return evaluateZohoProductionOutputCommitReadiness({
    status: row.status as ZohoProductionOutputOpStatus,
    voidedAt: row.voidedAt,
    approvedRequestHash: row.approvedRequestHash,
    requestHash: row.requestHash,
    requestPayload: row.requestPayload,
    previewResponse: row.previewResponse,
    previewHttpStatus: row.previewHttpStatus,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    ...context,
  });
}
