// ZOHO-PRODUCTION-OUTPUT-CONSOLIDATED-DB — persist + process consolidated ops.

import { and, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  buildSourceAllocationsForFinishedLot,
  parseZohoCommitResponseIds,
  persistSourceAllocationsForOp,
} from "@/lib/zoho/production-output-source-allocations";
import {
  derivePreviewStatus,
  evaluateV1206ProductionOutputCommitReadiness,
} from "@/lib/zoho/production-output-v1206-readiness";
import { resolveProductFamily } from "@/lib/zoho/product-family";
import {
  chocoDriftSourceAllocationBuildOpts,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import {
  buildProductionOutputPreviewIdempotencyKey,
  callProductionOutputPreview,
} from "@/lib/zoho/production-output-preview";
import {
  attachSnapshotToPayload,
  buildLumaOperationSnapshotFromOpRow,
  parsePreviewWritesAllowed,
  verifySnapshotMatchesPersistedOperation,
} from "@/lib/zoho/luma-operation-snapshot";
import {
  finishedLots,
  products,
  readBagState,
  workflowBags,
  zohoAssemblyOps,
  zohoProductionOutputOps,
  zohoProductionOutputSourceAllocations,
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
  isProductionOutputCommitEnabled,
  isProductionOutputPersistEnabled,
  isProductionOutputPreviewEnabled,
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
    productId: string | null;
    productFamily: string | null;
    finishedSku: string | null;
    varietyRunId: string | null;
    finalizedAt: Date | null;
    status: "READY" | "NEEDS_MAPPING" | "QUEUED";
    requestHash: string;
    metricsState: "HIGH" | "MISSING";
    genealogyState: "HIGH" | "MISSING";
    mappingBlockers?: Array<{ code: string; message: string }> | undefined;
    previewHttpStatus: number | null;
    previewResponse: unknown;
    previewStatus: string | null;
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
    previewHttpStatus: input.previewHttpStatus,
    previewResponse: input.previewResponse,
    previewStatus: input.previewStatus,
    previewedAt: input.previewHttpStatus != null ? now : null,
    previewedByUserId: input.previewHttpStatus != null ? input.actorId : null,
    productId: input.productId,
    productFamily: input.productFamily,
    finishedSku: input.finishedSku,
    varietyRunId: input.varietyRunId,
    finalizedAt: input.finalizedAt,
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
  opts?: {
    autoQueue?: boolean;
    warehouseId?: string | null;
    /** Re-run Zoho preview with a fresh idempotency key (same op row). */
    previewRetry?: boolean;
  },
): Promise<
  | { ok: true; opId: string; status: string; queued: boolean }
  | { ok: false; reason: string }
> {
  if (!isProductionOutputPersistEnabled()) {
    return { ok: false, reason: "consolidated production output persistence disabled" };
  }

  const [lotRow] = await db
    .select({
      workflowBagId: finishedLots.workflowBagId,
      excludedFromOutput: readBagState.excludedFromOutput,
      producedOn: finishedLots.producedOn,
      unitsProduced: finishedLots.unitsProduced,
      productId: finishedLots.productId,
      productName: products.name,
      productSku: products.sku,
      productFamily: products.productFamily,
      zohoItemIdUnit: products.zohoItemIdUnit,
      workflowFinalizedAt: workflowBags.finalizedAt,
    })
    .from(finishedLots)
    .leftJoin(readBagState, eq(readBagState.workflowBagId, finishedLots.workflowBagId))
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(workflowBags, eq(workflowBags.id, finishedLots.workflowBagId))
    .where(eq(finishedLots.id, finishedLotId))
    .limit(1);
  if (lotRow?.excludedFromOutput) {
    return {
      ok: false,
      reason: "workflow excluded from production output after recovery",
    };
  }

  const outputFamily = resolveProductFamily({
    persistedFamily: lotRow?.productFamily,
    name: lotRow?.productName ?? "",
  });

  const sourceBuilt = await buildSourceAllocationsForFinishedLot(
    {
      finishedLotId,
      workflowBagId: lotRow?.workflowBagId ?? null,
      outputProductFamily: outputFamily,
      outputPoLineItemId: null,
      unitsPerFinishedUnit: lotRow?.unitsProduced ?? 0,
    },
    isChocoDriftSku(lotRow?.productSku ?? "")
      ? chocoDriftSourceAllocationBuildOpts()
      : { resolveBatches: process.env.ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE === "true" },
  );

  const built = await loadAndBuildLumaProductionOutputPayload(finishedLotId, {
    warehouseId: opts?.warehouseId ?? null,
    componentBatches: sourceBuilt.ok ? sourceBuilt.componentBatches : [],
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
      const blockers = [
        ...built.blockers,
        ...(sourceBuilt.ok ? [] : sourceBuilt.blockers),
      ];
      const partialValues = {
        lumaOperationId: buildLumaProductionOutputOperationId(finishedLotId),
        finishedLotId,
        workflowBagId: lot.workflowBagId,
        status: "NEEDS_MAPPING" as const,
        payloadKind: "consolidated",
        productId: lotRow?.productId ?? null,
        productFamily: outputFamily,
        finishedSku: lotRow?.productSku ?? null,
        finalizedAt: lotRow?.workflowFinalizedAt ?? null,
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
          blockers,
        },
        requestHash: `needs-mapping:${finishedLotId}`,
        mappingBlockers: blockers,
        previewStatus: "blocked",
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

    const primaryPo = firstSourceReceiptPoLineId(built.payload);
    const sourceWithPo = await buildSourceAllocationsForFinishedLot(
      {
        finishedLotId,
        workflowBagId: lot.workflowBagId,
        outputProductFamily: outputFamily,
        outputPoLineItemId: primaryPo,
        unitsPerFinishedUnit: built.payload.output.units_produced,
      },
      isChocoDriftSku(lotRow?.productSku ?? "")
        ? chocoDriftSourceAllocationBuildOpts()
        : { resolveBatches: process.env.ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE === "true" },
    );

    if (!sourceWithPo.ok) {
      const blockers = sourceWithPo.blockers;
      const partialValues = {
        lumaOperationId: buildLumaProductionOutputOperationId(finishedLotId),
        finishedLotId,
        workflowBagId: lot.workflowBagId,
        status: "NEEDS_MAPPING" as const,
        payloadKind: "consolidated",
        productId: lotRow?.productId ?? null,
        productFamily: outputFamily,
        finishedSku: lotRow?.productSku ?? null,
        finalizedAt: lotRow?.workflowFinalizedAt ?? null,
        zohoPurchaseorderId: firstSourceReceiptPoId(built.payload),
        zohoPurchaseorderLineItemId: primaryPo,
        quantityGood: built.payload.output.units_produced,
        unitAssemblyQuantity: built.payload.output.units_produced,
        displayAssemblyQuantity: built.payload.output.displays_produced ?? 0,
        caseAssemblyQuantity: built.payload.output.cases_produced ?? 0,
        metricsState: built.metricsState,
        genealogyState: built.genealogyState,
        requestPayload: { ...built.payload, component_batches: [] },
        requestHash: built.requestHash,
        mappingBlockers: blockers,
        previewStatus: "blocked",
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

    const payloadWithBatches: LumaProductionOutputPayload = {
      ...built.payload,
      component_batches: sourceWithPo.componentBatches,
    };

    const statusDraft =
      autoQueue ? ("QUEUED" as const) : ("READY" as const);

    const draftValues = opValuesFromPayload(payloadWithBatches, {
      finishedLotId,
      workflowBagId: lot.workflowBagId,
      productId: lotRow?.productId ?? null,
      productFamily: outputFamily,
      finishedSku: lotRow?.productSku ?? null,
      varietyRunId: null,
      finalizedAt: lotRow?.workflowFinalizedAt ?? null,
      status: statusDraft,
      requestHash: built.requestHash,
      metricsState: built.metricsState,
      genealogyState: built.genealogyState,
      previewHttpStatus: null,
      previewResponse: null,
      previewStatus: "pending",
      autoQueue: false,
      actorId: actor?.id ?? null,
    });

    let opId: string;
    if (existing) {
      const [updated] = await tx
        .update(zohoProductionOutputOps)
        .set({ ...draftValues, status: "READY" })
        .where(
          and(
            eq(zohoProductionOutputOps.id, existing.id),
            ne(zohoProductionOutputOps.status, "COMMITTED"),
          ),
        )
        .returning({ id: zohoProductionOutputOps.id });
      if (!updated) {
        return { ok: false, reason: "could not update consolidated op" };
      }
      opId = updated.id;
    } else {
      const [inserted] = await tx
        .insert(zohoProductionOutputOps)
        .values({ ...draftValues, status: "READY" })
        .returning({ id: zohoProductionOutputOps.id });
      opId = inserted!.id;
      await writeAudit(
        {
          actorId: actor?.id ?? null,
          actorRole: null,
          action: "zoho_production_output_op.consolidated_upsert",
          targetType: "ZohoProductionOutputOp",
          targetId: opId,
          after: { finishedLotId, status: "READY" },
        },
        tx,
      );
    }

    await persistSourceAllocationsForOp(opId, sourceWithPo.rows, tx);

    if (!isProductionOutputPreviewEnabled()) {
      await tx
        .update(zohoProductionOutputOps)
        .set({
          requestPayload: payloadWithBatches,
          previewStatus: "pending",
          previewHttpStatus: null,
          previewResponse: null,
          mappingBlockers: null,
          status: "READY",
          updatedAt: now,
        })
        .where(eq(zohoProductionOutputOps.id, opId));
      return {
        ok: true,
        opId,
        status: "READY",
        queued: false,
      };
    }

    const snapshotBuilt = buildLumaOperationSnapshotFromOpRow(
      {
        lumaOperationId: buildLumaProductionOutputOperationId(finishedLotId),
        finalizedAt: lotRow?.workflowFinalizedAt ?? null,
        productId: lotRow?.productId ?? null,
        productFamily: outputFamily,
        finishedSku: lotRow?.productSku ?? null,
        unitCompositeItemId: lotRow?.zohoItemIdUnit ?? null,
        workflowBagId: lot.workflowBagId,
        finishedLotId,
      },
      sourceWithPo.rows.map((row) => ({
        lumaInventoryBagId: row.lumaInventoryBagId,
        zohoComponentItemId: row.zohoComponentItemId,
        humanLotNumber: row.humanLotNumber,
        quantityAllocated: row.quantityAllocated,
      })),
    );
    if (!snapshotBuilt.ok) {
      await tx
        .update(zohoProductionOutputOps)
        .set({
          status: "NEEDS_MAPPING",
          mappingBlockers: snapshotBuilt.blockers,
          previewStatus: "blocked",
          updatedAt: now,
        })
        .where(eq(zohoProductionOutputOps.id, opId));
      return {
        ok: true,
        opId,
        status: "NEEDS_MAPPING",
        queued: false,
      };
    }

    const payloadWithSnapshot = attachSnapshotToPayload(
      payloadWithBatches,
      snapshotBuilt.snapshot,
    );
    const verify = verifySnapshotMatchesPersistedOperation(
      snapshotBuilt.snapshot,
      payloadWithSnapshot.luma_operation_snapshot,
    );
    if (!verify.ok) {
      await tx
        .update(zohoProductionOutputOps)
        .set({
          status: "NEEDS_MAPPING",
          mappingBlockers: [{ code: verify.code, message: verify.message }],
          previewStatus: "blocked",
          updatedAt: now,
        })
        .where(eq(zohoProductionOutputOps.id, opId));
      return {
        ok: true,
        opId,
        status: "NEEDS_MAPPING",
        queued: false,
      };
    }

    const previewPayload: Parameters<typeof callProductionOutputPreview>[0]["payload"] = {
      purchaseorder_id: firstSourceReceiptPoId(built.payload) ?? "",
      purchaseorder_line_item_id: primaryPo ?? "",
      quantity_good: built.payload.output.units_produced,
      receive_date: built.payload.production_dates.receive_date,
      warehouse_id: built.payload.warehouse_id ?? "",
      unit_composite_item_id: built.payload.product.unit_composite_item_id ?? "",
      unit_assembly_quantity: built.payload.output.units_produced,
      luma_operation_id: buildLumaProductionOutputOperationId(finishedLotId),
      quantity_damaged: built.payload.output.damaged_packaging ?? 0,
      quantity_ripped: built.payload.output.ripped_cards ?? 0,
      quantity_loose: built.payload.output.loose_cards ?? 0,
      display_assembly_quantity: built.payload.output.displays_produced ?? 0,
      case_assembly_quantity: built.payload.output.cases_produced ?? 0,
      notes: "Luma consolidated production-output preview",
      component_batches: sourceWithPo.componentBatches,
      luma_operation_snapshot: snapshotBuilt.snapshot,
      verification: { mode: "snapshot" },
    };
    if (built.payload.product.display_composite_item_id) {
      previewPayload.display_composite_item_id = built.payload.product.display_composite_item_id;
    }
    if (built.payload.product.case_composite_item_id) {
      previewPayload.case_composite_item_id = built.payload.product.case_composite_item_id;
    }
    if (built.payload.luma_workflow_bag_id) {
      previewPayload.luma_bag_id = built.payload.luma_workflow_bag_id;
    }

    const preview = await callProductionOutputPreview({
      payload: previewPayload,
      idempotencyKey: opts?.previewRetry
        ? `${buildProductionOutputPreviewIdempotencyKey(finishedLotId, previewPayload)}-retry-${now.getTime()}`
        : buildProductionOutputPreviewIdempotencyKey(finishedLotId, previewPayload),
    });

    const previewBlockers: Array<{ code: string; message: string }> = [];
    if (!preview.ok) {
      previewBlockers.push({
        code: "PREVIEW_FAILED",
        message: preview.message,
      });
    }
    if (!parsePreviewWritesAllowed(preview.body)) {
      previewBlockers.push({
        code: "PREVIEW_WRITES_NOT_ALLOWED",
        message: "Zoho preview did not return writes_allowed=true.",
      });
    }

    const previewStatus = derivePreviewStatus({
      previewHttpStatus: preview.httpStatus,
      previewResponse: preview.body,
      blockers: previewBlockers,
    });

    const finalStatus =
      autoQueue && preview.ok && previewBlockers.length === 0
        ? ("QUEUED" as const)
        : preview.ok && previewBlockers.length === 0
          ? ("READY" as const)
          : ("NEEDS_MAPPING" as const);

    const finalValues = opValuesFromPayload(payloadWithSnapshot, {
      finishedLotId,
      workflowBagId: lot.workflowBagId,
      productId: lotRow?.productId ?? null,
      productFamily: outputFamily,
      finishedSku: lotRow?.productSku ?? null,
      varietyRunId: null,
      finalizedAt: lotRow?.workflowFinalizedAt ?? null,
      status: finalStatus === "NEEDS_MAPPING" ? "NEEDS_MAPPING" : finalStatus,
      requestHash: built.requestHash,
      metricsState: built.metricsState,
      genealogyState: built.genealogyState,
      mappingBlockers: previewBlockers.length > 0 ? previewBlockers : undefined,
      previewHttpStatus: preview.httpStatus,
      previewResponse: preview.body,
      previewStatus,
      autoQueue: finalStatus === "QUEUED",
      actorId: actor?.id ?? null,
    });

    await tx
      .update(zohoProductionOutputOps)
      .set({
        ...finalValues,
        requestPayload: payloadWithSnapshot,
      })
      .where(eq(zohoProductionOutputOps.id, opId));

    return {
      ok: true,
      opId,
      status: finalStatus,
      queued: finalStatus === "QUEUED",
    };
  });
}

/** Re-run Zoho preview for an existing consolidated op (same op id, fresh preview key). */
export async function retryConsolidatedProductionOutputPreview(
  opId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; opId: string; status: string; queued: boolean }
  | { ok: false; reason: string }
> {
  if (!isProductionOutputPreviewEnabled()) {
    return {
      ok: false,
      reason: "ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED is false — preview retry is disabled.",
    };
  }

  const [op] = await db
    .select({
      id: zohoProductionOutputOps.id,
      finishedLotId: zohoProductionOutputOps.finishedLotId,
      status: zohoProductionOutputOps.status,
      voidedAt: zohoProductionOutputOps.voidedAt,
      payloadKind: zohoProductionOutputOps.payloadKind,
    })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);

  if (!op) {
    return { ok: false, reason: "Production output operation not found." };
  }
  if (op.voidedAt) {
    return { ok: false, reason: "Operation is voided; preview retry is not allowed." };
  }
  if (op.payloadKind !== "consolidated") {
    return {
      ok: false,
      reason: "Only consolidated production-output ops support preview retry.",
    };
  }
  if (
    op.status === "COMMITTED" ||
    op.status === "COMMITTING" ||
    op.status === "QUEUED"
  ) {
    return {
      ok: false,
      reason: `Operation status is ${op.status}; preview retry is not allowed.`,
    };
  }

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: null,
    action: "zoho_production_output_op.preview_retry",
    targetType: "ZohoProductionOutputOp",
    targetId: opId,
    after: { finishedLotId: op.finishedLotId },
  });

  return upsertConsolidatedProductionOutputOpForLot(op.finishedLotId, actor, {
    previewRetry: true,
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
  if (!isProductionOutputCommitEnabled()) {
    return {
      ok: false,
      error:
        "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED is false — live commit is disabled.",
    };
  }

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

    const [sourceStats] = await tx
      .select({
        total: count(),
        unresolved: sql<number>`count(*) filter (where ${zohoProductionOutputSourceAllocations.batchResolutionStatus} in ('UNRESOLVED','MISSING'))`,
        ambiguous: sql<number>`count(*) filter (where ${zohoProductionOutputSourceAllocations.batchResolutionStatus} = 'AMBIGUOUS')`,
      })
      .from(zohoProductionOutputSourceAllocations)
      .where(eq(zohoProductionOutputSourceAllocations.zohoProductionOutputOpId, opId));

    const legacy = await legacyBlockersForLot(tx, row.finishedLotId);
    const config = validateProductionOutputServiceConfig();

    const v1206 = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: row.status as "QUEUED" | "FAILED" | "COMMITTED",
      voidedAt: row.voidedAt,
      payloadKind: row.payloadKind,
      requestPayload: row.requestPayload,
      previewHttpStatus: row.previewHttpStatus,
      previewResponse: row.previewResponse,
      previewStatus: row.previewStatus,
      previewWritesAllowed: parsePreviewWritesAllowed(row.previewResponse),
      commitIdempotencyKey: row.commitIdempotencyKey,
      finishedLotExists: lotExists != null,
      workflowBagId: row.workflowBagId,
      sourceAllocationCount: Number(sourceStats?.total ?? 0),
      unresolvedBatchCount: Number(sourceStats?.unresolved ?? 0),
      ambiguousBatchCount: Number(sourceStats?.ambiguous ?? 0),
      humanReviewRequired: row.humanReviewRequired,
      partialFailure: row.partialFailure,
      productionOutputEnabled: config.ok && isProductionOutputCommitEnabled(),
    });

    const legacyEligibility = evaluateConsolidatedProductionOutputProcessCommitEligibility({
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
      productionOutputEnabled: config.ok && isProductionOutputCommitEnabled(),
    });

    const blockers = [...v1206.blockers, ...legacyEligibility.blockers];
    if (blockers.length > 0) {
      return {
        ok: false,
        error: blockers[0]?.message ?? "Cannot process commit.",
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
    const parsed = parseZohoCommitResponseIds(gateway.body);
    const done = await completeZohoProductionOutputCommitSuccess(opId, actor, {
      commitResponse: gateway.body,
      externalReferenceId: gateway.externalReferenceId,
      zohoReceiveId: parsed.receiveId,
      zohoBundleIds: parsed.bundleIds,
      humanReviewRequired: parsed.humanReviewRequired,
      partialFailure: parsed.partialFailure,
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
