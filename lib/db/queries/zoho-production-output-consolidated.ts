// ZOHO-PRODUCTION-OUTPUT-CONSOLIDATED-DB — persist + process consolidated ops.

import { and, count, desc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  finishedLots,
  readBagState,
  zohoAssemblyOps,
  zohoProductionOutputOps,
  zohoPushes,
} from "@/lib/db/schema";
import {
  buildLumaProductionOutputOperationId,
  buildLumaProductionOutputStableCommitIdempotencyKey,
  loadAndBuildLumaProductionOutputPayload,
  type LumaProductionOutputPayload,
} from "@/lib/zoho/luma-production-output-payload";
import {
  evaluateConsolidatedProductionOutputProcessCommitEligibility,
  firstSourceReceiptPoId,
  firstSourceReceiptPoLineId,
} from "@/lib/zoho/production-output-consolidated-eligibility";
import {
  isConsolidatedProductionOutputEnabled,
  validateProductionOutputServiceConfig,
} from "@/lib/zoho/production-output-config";
import {
  callProductionOutputCommit,
} from "@/lib/zoho/production-output-service-client";
import {
  completeZohoProductionOutputCommitFailure,
  completeZohoProductionOutputCommitSuccess,
} from "@/lib/db/queries/zoho-production-output";

type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export type ConsolidatedProductionOutputOpRow =
  typeof zohoProductionOutputOps.$inferSelect;

async function legacyBlockersForLot(
  tx: DbOrTx,
  finishedLotId: string,
): Promise<{ legacyAssemblyOpExists: boolean; legacyZohoPushExists: boolean }> {
  const [assembly] = await tx
    .select({ n: count() })
    .from(zohoAssemblyOps)
    .where(eq(zohoAssemblyOps.finishedLotId, finishedLotId));
  const [push] = await tx
    .select({ n: count() })
    .from(zohoPushes)
    .where(
      and(
        eq(zohoPushes.finishedLotId, finishedLotId),
        eq(zohoPushes.status, "SUCCESS"),
      ),
    );
  return {
    legacyAssemblyOpExists: Number(assembly?.n ?? 0) > 0,
    legacyZohoPushExists: Number(push?.n ?? 0) > 0,
  };
}

function opValuesFromPayload(
  payload: LumaProductionOutputPayload,
  input: {
    finishedLotId: string;
    workflowBagId: string | null;
    status: "READY" | "NEEDS_MAPPING" | "QUEUED";
    requestHash: string;
    metricsState: "HIGH" | "MISSING";
    genealogyState: "HIGH" | "MISSING";
    mappingBlockers?: Array<{ code: string; message: string }>;
    autoQueue: boolean;
    actorId: string | null;
  },
  now = new Date(),
): typeof zohoProductionOutputOps.$inferInsert {
  const metricsKnown = input.metricsState !== "MISSING";
  const idempotencyKey = buildLumaProductionOutputStableCommitIdempotencyKey(
    input.finishedLotId,
  );
  const primaryPo = firstSourceReceiptPoId(payload);
  const primaryLine = firstSourceReceiptPoLineId(payload);

  return {
    lumaOperationId: buildLumaProductionOutputOperationId(input.finishedLotId),
    finishedLotId: input.finishedLotId,
    workflowBagId: input.workflowBagId,
    status: input.status,
    payloadKind: "consolidated",
    zohoPurchaseorderId: primaryPo,
    zohoPurchaseorderLineItemId: primaryLine,
    zohoWarehouseId: payload.warehouse_id ?? null,
    zohoCompositeItemId: payload.product.unit_composite_item_id,
    zohoDisplayCompositeItemId: payload.product.display_composite_item_id,
    zohoCaseCompositeItemId: payload.product.case_composite_item_id,
    quantityGood: payload.output.units_produced,
    unitAssemblyQuantity: payload.output.units_produced,
    displayAssemblyQuantity: payload.output.displays_produced ?? 0,
    caseAssemblyQuantity: payload.output.cases_produced ?? 0,
    quantityDamaged: metricsKnown ? payload.output.damaged_packaging : null,
    quantityRipped: metricsKnown ? payload.output.ripped_cards : null,
    quantityLoose: metricsKnown ? payload.output.loose_cards : null,
    quantityBasis: {
      units_produced: payload.output.units_produced,
      displays_produced: payload.output.displays_produced,
      cases_produced: payload.output.cases_produced,
      produced_on: payload.production_dates.produced_on,
    },
    metricsState: input.metricsState,
    genealogyState: input.genealogyState,
    requestPayload: payload,
    requestHash: input.requestHash,
    mappingBlockers: input.mappingBlockers ?? null,
    commitIdempotencyKey:
      input.status === "QUEUED" ? idempotencyKey : null,
    commitRequestedAt: input.status === "QUEUED" ? now : null,
    commitRequestedByUserId: input.status === "QUEUED" ? input.actorId : null,
    selectedByUserId: input.actorId,
    selectedAt: now,
    updatedAt: now,
  };
}

/** Create or refresh consolidated op after finished lot release. Idempotent per lot. */
export async function upsertConsolidatedProductionOutputOpForLot(
  finishedLotId: string,
  actor: Pick<CurrentUser, "id"> | null,
  opts?: { autoQueue?: boolean; warehouseId?: string | null },
): Promise<
  | { ok: true; opId: string; status: string; queued: boolean }
  | { ok: false; reason: string }
> {
  if (!isConsolidatedProductionOutputEnabled()) {
    return { ok: false, reason: "consolidated production output disabled" };
  }

  const [lotRow] = await db
    .select({
      workflowBagId: finishedLots.workflowBagId,
      excludedFromOutput: readBagState.excludedFromOutput,
    })
    .from(finishedLots)
    .leftJoin(readBagState, eq(readBagState.workflowBagId, finishedLots.workflowBagId))
    .where(eq(finishedLots.id, finishedLotId))
    .limit(1);
  if (lotRow?.excludedFromOutput) {
    return {
      ok: false,
      reason: "workflow excluded from production output after recovery",
    };
  }

  const built = await loadAndBuildLumaProductionOutputPayload(finishedLotId, {
    warehouseId: opts?.warehouseId ?? null,
  });

  const config = validateProductionOutputServiceConfig();
  const autoQueue =
    opts?.autoQueue === true && config.ok && config.autoQueueEnabled;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(zohoProductionOutputOps)
      .where(
        and(
          eq(zohoProductionOutputOps.finishedLotId, finishedLotId),
          isNull(zohoProductionOutputOps.voidedAt),
        ),
      )
      .limit(1);

    if (
      existing &&
      (existing.status === "COMMITTED" ||
        existing.status === "COMMITTING" ||
        existing.status === "QUEUED")
    ) {
      return {
        ok: true,
        opId: existing.id,
        status: existing.status,
        queued: existing.status === "QUEUED" || existing.status === "COMMITTING",
      };
    }

    if (existing && existing.payloadKind === "preview") {
      return {
        ok: false,
        reason:
          "An admin preview production-output op already exists for this lot. Void it before using the consolidated path.",
      };
    }

    const [lot] = await tx
      .select({ workflowBagId: finishedLots.workflowBagId })
      .from(finishedLots)
      .where(eq(finishedLots.id, finishedLotId))
      .limit(1);
    if (!lot) return { ok: false, reason: "finished lot not found" };

    const now = new Date();

    if (!built.ok) {
      const partialValues = {
        lumaOperationId: buildLumaProductionOutputOperationId(finishedLotId),
        finishedLotId,
        workflowBagId: lot.workflowBagId,
        status: "NEEDS_MAPPING" as const,
        payloadKind: "consolidated",
        zohoPurchaseorderId: null,
        zohoPurchaseorderLineItemId: null,
        quantityGood: 0,
        unitAssemblyQuantity: 0,
        displayAssemblyQuantity: 0,
        caseAssemblyQuantity: 0,
        metricsState: "MISSING" as const,
        genealogyState: "MISSING" as const,
        requestPayload: {
          source: "LUMA",
          luma_finished_lot_id: finishedLotId,
          blockers: built.blockers,
        },
        requestHash: `needs-mapping:${finishedLotId}`,
        mappingBlockers: built.blockers,
        selectedByUserId: actor?.id ?? null,
        selectedAt: now,
        updatedAt: now,
      };

      if (existing) {
        const [updated] = await tx
          .update(zohoProductionOutputOps)
          .set(partialValues)
          .where(eq(zohoProductionOutputOps.id, existing.id))
          .returning({ id: zohoProductionOutputOps.id });
        return {
          ok: true,
          opId: updated!.id,
          status: "NEEDS_MAPPING",
          queued: false,
        };
      }

      const [inserted] = await tx
        .insert(zohoProductionOutputOps)
        .values(partialValues)
        .returning({ id: zohoProductionOutputOps.id });
      return {
        ok: true,
        opId: inserted!.id,
        status: "NEEDS_MAPPING",
        queued: false,
      };
    }

    const status = autoQueue ? ("QUEUED" as const) : ("READY" as const);
    const values = opValuesFromPayload(built.payload, {
      finishedLotId,
      workflowBagId: lot.workflowBagId,
      status,
      requestHash: built.requestHash,
      metricsState: built.metricsState,
      genealogyState: built.genealogyState,
      autoQueue,
      actorId: actor?.id ?? null,
    });

    if (existing) {
      const [updated] = await tx
        .update(zohoProductionOutputOps)
        .set(values)
        .where(
          and(
            eq(zohoProductionOutputOps.id, existing.id),
            ne(zohoProductionOutputOps.status, "COMMITTED"),
          ),
        )
        .returning({ id: zohoProductionOutputOps.id, status: zohoProductionOutputOps.status });
      if (!updated) {
        return { ok: false, reason: "could not update consolidated op" };
      }
      return {
        ok: true,
        opId: updated.id,
        status: updated.status,
        queued: updated.status === "QUEUED",
      };
    }

    const [inserted] = await tx
      .insert(zohoProductionOutputOps)
      .values(values)
      .returning({ id: zohoProductionOutputOps.id, status: zohoProductionOutputOps.status });

    await writeAudit(
      {
        actorId: actor?.id ?? null,
        actorRole: null,
        action: "zoho_production_output_op.consolidated_upsert",
        targetType: "ZohoProductionOutputOp",
        targetId: inserted!.id,
        after: { finishedLotId, status: inserted!.status, autoQueue },
      },
      tx,
    );

    return {
      ok: true,
      opId: inserted!.id,
      status: inserted!.status,
      queued: inserted!.status === "QUEUED",
    };
  });
}

export async function listConsolidatedProductionOutputOps(limit = 50) {
  return db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.payloadKind, "consolidated"))
    .orderBy(desc(zohoProductionOutputOps.updatedAt))
    .limit(limit);
}

export async function claimConsolidatedProductionOutputOpForCommit(
  opId: string,
  actor: CurrentUser,
): Promise<
  | { ok: true; op: ConsolidatedProductionOutputOpRow }
  | { ok: false; error: string }
> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(zohoProductionOutputOps)
      .where(eq(zohoProductionOutputOps.id, opId))
      .limit(1);

    if (!row) return { ok: false, error: "Production output operation not found." };

    const [lotExists] = await tx
      .select({ id: finishedLots.id })
      .from(finishedLots)
      .where(eq(finishedLots.id, row.finishedLotId))
      .limit(1);

    const [committedCount] = await tx
      .select({ n: count() })
      .from(zohoProductionOutputOps)
      .where(
        and(
          eq(zohoProductionOutputOps.finishedLotId, row.finishedLotId),
          eq(zohoProductionOutputOps.status, "COMMITTED"),
          ne(zohoProductionOutputOps.id, row.id),
        ),
      );

    const legacy = await legacyBlockersForLot(tx, row.finishedLotId);
    const config = validateProductionOutputServiceConfig();

    const eligibility = evaluateConsolidatedProductionOutputProcessCommitEligibility({
      opExists: true,
      status: row.status as "QUEUED" | "FAILED" | "COMMITTED",
      voidedAt: row.voidedAt,
      payloadKind: row.payloadKind,
      requestPayload: row.requestPayload,
      commitIdempotencyKey: row.commitIdempotencyKey,
      finishedLotExists: lotExists != null,
      committedOpExists: Number(committedCount?.n ?? 0) > 0,
      legacyAssemblyOpExists: legacy.legacyAssemblyOpExists,
      legacyZohoPushExists: legacy.legacyZohoPushExists,
      productionOutputEnabled: config.ok && config.productionOutputEnabled,
    });

    if (!eligibility.eligible) {
      return {
        ok: false,
        error: eligibility.blockers[0]?.message ?? "Cannot process commit.",
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
          isNull(zohoProductionOutputOps.voidedAt),
        ),
      )
      .returning();

    if (!updated) {
      return { ok: false, error: "Could not claim operation for commit." };
    }

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "zoho_production_output_op.commit_started",
        targetType: "ZohoProductionOutputOp",
        targetId: opId,
        after: { status: "COMMITTING", payloadKind: "consolidated" },
      },
      tx,
    );

    return { ok: true, op: updated };
  });
}

export async function processConsolidatedProductionOutputCommit(
  opId: string,
  actor: CurrentUser,
): Promise<
  | { ok: true; op: ConsolidatedProductionOutputOpRow }
  | { ok: false; error: string; phase: "claim" | "gateway" | "complete" }
> {
  const claim = await claimConsolidatedProductionOutputOpForCommit(opId, actor);
  if (!claim.ok) {
    return { ok: false, error: claim.error, phase: "claim" };
  }

  const payload = claim.op.requestPayload as LumaProductionOutputPayload;
  const idempotencyKey =
    claim.op.commitIdempotencyKey ?? payload.idempotency_key;

  const gateway = await callProductionOutputCommit({
    payload,
    idempotencyKey,
  });

  if (gateway.ok) {
    const done = await completeZohoProductionOutputCommitSuccess(opId, actor, {
      commitResponse: gateway.body,
      externalReferenceId: gateway.externalReferenceId,
    });
    if (!done.ok) {
      return { ok: false, error: done.error, phase: "complete" };
    }
    return { ok: true, op: done.op };
  }

  const failed = await completeZohoProductionOutputCommitFailure(opId, actor, {
    commitError: gateway.message,
    commitResponse: gateway.body,
  });
  if (!failed.ok) {
    return { ok: false, error: failed.error, phase: "complete" };
  }

  return { ok: false, error: gateway.message, phase: "gateway" };
}

export async function queueConsolidatedProductionOutputOp(
  opId: string,
  actor: CurrentUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);

  if (!row) return { ok: false, error: "Operation not found." };
  if (row.status !== "READY" && row.status !== "FAILED") {
    return { ok: false, error: "Only READY or FAILED consolidated ops can be queued." };
  }
  if (row.payloadKind !== "consolidated") {
    return { ok: false, error: "Not a consolidated operation." };
  }

  const idempotencyKey = buildLumaProductionOutputStableCommitIdempotencyKey(
    row.finishedLotId,
  );
  const now = new Date();
  const [updated] = await db
    .update(zohoProductionOutputOps)
    .set({
      status: "QUEUED",
      commitIdempotencyKey: idempotencyKey,
      commitRequestedAt: now,
      commitRequestedByUserId: actor.id,
      updatedAt: now,
    })
    .where(eq(zohoProductionOutputOps.id, opId))
    .returning({ id: zohoProductionOutputOps.id });

  if (!updated) return { ok: false, error: "Could not queue operation." };
  return { ok: true };
}

export async function processNextQueuedConsolidatedProductionOutputCommit(
  actor: CurrentUser,
): Promise<
  | { ok: true; opId: string; committed: boolean }
  | { ok: false; reason: string }
> {
  const [next] = await db
    .select({ id: zohoProductionOutputOps.id })
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.payloadKind, "consolidated"),
        eq(zohoProductionOutputOps.status, "QUEUED"),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .orderBy(zohoProductionOutputOps.commitRequestedAt)
    .limit(1);

  if (!next) return { ok: false, reason: "No queued consolidated ops." };

  const result = await processConsolidatedProductionOutputCommit(next.id, actor);
  if (result.ok) {
    return { ok: true, opId: next.id, committed: true };
  }
  return { ok: false, reason: result.error };
}
