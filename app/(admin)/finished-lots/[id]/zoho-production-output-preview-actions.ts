"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  finishedLotRawBags,
  finishedLots,
  products,
  readBagMetrics,
  zohoCredentials,
} from "@/lib/db/schema";
import {
  getActiveZohoProductionOutputOpForLot,
  upsertZohoProductionOutputPreviewOp,
  type ZohoProductionOutputPreviewMetadata,
} from "@/lib/db/queries/zoho-production-output";
import {
  buildProductionOutputPreviewIdempotencyKey,
  buildProductionOutputPreviewPayload,
  buildProductionOutputPreviewRequestHash,
  callProductionOutputPreview,
  classifyProductionOutputGenealogyState,
  classifyProductionOutputMetricsState,
  productionOutputPreviewStatusMessage,
  validateProductionOutputPreviewConfig,
  type ProductionOutputPreviewBlocker,
  type ProductionOutputPreviewPayload,
} from "@/lib/zoho/production-output-preview";
import { buildProductionOutputNotes } from "@/lib/zoho/zoho-commit-notes";
import { resolveProductionOutputWarehouseId } from "@/lib/zoho/warehouse-resolution";
import { fetchWarehouseCapability } from "@/lib/zoho/brand-capabilities-client";
import {
  capabilitySourceLabel,
  decideWarehouseInclusion,
} from "@/lib/zoho/warehouse-decision";
// SNAPSHOT-ATTACH-v1.4.1 — preview must attach a luma_operation_snapshot
// so the gateway can verify the operation is persisted in Luma. Same
// canonical helpers the consolidated commit path uses.
import {
  buildLumaOperationSnapshotFromOpRow,
  attachSnapshotToPayload,
} from "@/lib/zoho/luma-operation-snapshot";
import {
  buildSourceAllocationsForFinishedLot,
  persistSourceAllocationsForOp,
} from "@/lib/zoho/production-output-source-allocations";
import { resolveProductFamily } from "@/lib/zoho/product-family";
// SNAPSHOT-OP-ID-MATCH-v1.4.17 — buildLumaProductionOutputOperationId
// returns "luma-production-output:${id}" (no -preview suffix), which
// did NOT match the envelope's luma_operation_id (built by
// buildProductionOutputOperationId in production-output-preview.ts,
// returning "luma-production-output-preview:${id}"). The mismatch
// triggered the gateway's LUMA_OPERATION_NOT_PERSISTED blocker. The
// snapshot now uses buildResult.payload.luma_operation_id directly,
// so the envelope and snapshot can never drift. The non-preview
// helper is retained for the future commit path that may use it.
import { workflowBags } from "@/lib/db/schema";
// DYNAMIC-BOM-DERIVATION-v1.4.4 — derive normalizedBomQuantities from
// product setup data first; fall back to the existing pilot contracts
// only if no Luma data is configured for the SKU yet. Replaces the
// previous SKU-only dispatch that required a new pilot contract for
// every new product (the v1.4.2 BlueRaz #36 blocker).
import { deriveNormalizedBomQuantitiesForProduct } from "@/lib/zoho/derive-normalized-bom-quantities";
import {
  chocoDriftSourceAllocationBuildOpts,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import {
  fixRelaxSourceAllocationBuildOpts,
  isFixRelaxSku,
} from "@/lib/zoho/v1206-fix-relax-pilot-contract";
import {
  isSweetTripSku,
  sweetTripSourceAllocationBuildOpts,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";

type AllocOpts = {
  resolveBatches: boolean;
  normalizedBomQuantities?: Record<string, number>;
  batchTrackedItemIds?: Set<string>;
};
type AllocOptsResolution =
  | { ok: true; opts: AllocOpts; warnings: Array<{ code: string; field: string; message: string }>; source: "luma" | "pilot" | "default" }
  | { ok: false; blockers: Array<{ code: string; field: string; message: string }> };

/**
 * DYNAMIC-BOM-DERIVATION-v1.4.4
 *
 * Build source-allocation opts using Luma product data first. Falls
 * back to the existing pilot contracts only when the Luma-side data
 * is incomplete AND the SKU still matches a pilot predicate (the
 * transition fallback). Returns specific blockers when neither the
 * Luma derivation succeeds nor a pilot matches.
 *
 * Pilot contracts are deprecated; do NOT add a new pilot to extend
 * this dispatcher. New products should be configured via product
 * setup data (tablets_per_unit + product_allowed_tablets +
 * tablet_types.zoho_item_id) instead.
 */
async function buildAdminPreviewSourceAllocationOpts(
  productId: string,
  sku: string,
): Promise<AllocOptsResolution> {
  // 1. Primary path — derive from Luma product setup data.
  const derived = await deriveNormalizedBomQuantitiesForProduct(productId);
  if (derived.ok) {
    return {
      ok: true,
      source: "luma",
      warnings: derived.warnings,
      opts: {
        resolveBatches:
          process.env.ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE === "true",
        normalizedBomQuantities: derived.normalizedBomQuantities,
        batchTrackedItemIds: derived.batchTrackedItemIds,
      },
    };
  }

  // 2. Transition fallback — existing pilot contracts. NOT extended.
  if (isChocoDriftSku(sku)) {
    return {
      ok: true,
      source: "pilot",
      warnings: [],
      opts: chocoDriftSourceAllocationBuildOpts(),
    };
  }
  if (isFixRelaxSku(sku)) {
    return {
      ok: true,
      source: "pilot",
      warnings: [],
      opts: fixRelaxSourceAllocationBuildOpts(),
    };
  }
  if (isSweetTripSku(sku)) {
    return {
      ok: true,
      source: "pilot",
      warnings: [],
      opts: sweetTripSourceAllocationBuildOpts(),
    };
  }

  // 3. Nothing matched — return the derivation's specific blockers
  //    so the operator sees exactly which Luma field to fix.
  return { ok: false, blockers: derived.blockers };
}

const previewInputSchema = z.object({
  finishedLotId: z.string().uuid(),
  purchaseorderId: z
    .string()
    .trim()
    .min(1, "Enter the Zoho purchase order ID.")
    .max(120),
  purchaseorderLineItemId: z
    .string()
    .trim()
    .min(1, "Enter the Zoho PO line item ID.")
    .max(120),
  warehouseId: z.string().trim().max(120).optional(),
  notes: z
    .string()
    .trim()
    .max(1000, "Notes must be 1000 characters or fewer.")
    .optional(),
});

export type ProductionOutputPreviewActionInput = z.input<
  typeof previewInputSchema
>;

export type ProductionOutputPreviewActionResult =
  | {
      ok: true;
      httpStatus: number;
      body: unknown;
      payload: ProductionOutputPreviewPayload;
      idempotencyKey: string;
      idempotencyReplay: boolean | null;
      persistedPreview: ZohoProductionOutputPreviewMetadata;
    }
  | {
      ok: false;
      kind:
        | "VALIDATION_ERROR"
        | "LOCAL_ERROR"
        | "PAYLOAD_BLOCKED"
        | "SERVICE_ERROR";
      message: string;
      httpStatus?: number | null;
      body?: unknown;
      blockers?: ProductionOutputPreviewBlocker[];
      payload?: ProductionOutputPreviewPayload;
      idempotencyKey?: string;
      idempotencyReplay?: boolean | null;
      persistedPreview?: ZohoProductionOutputPreviewMetadata;
    };

export async function previewZohoProductionOutputAction(
  input: ProductionOutputPreviewActionInput,
): Promise<ProductionOutputPreviewActionResult> {
  const actor = await requireAdmin();

  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "VALIDATION_ERROR",
      message: parsed.error.issues[0]?.message ?? "Invalid preview input.",
    };
  }

  const config = validateProductionOutputPreviewConfig();
  if (!config.ok) {
    return { ok: false, kind: "LOCAL_ERROR", message: config.reason };
  }

  const lot = await loadProductionOutputPreviewLot(parsed.data.finishedLotId);
  if (!lot) {
    return {
      ok: false,
      kind: "LOCAL_ERROR",
      message: "Finished lot was not found.",
    };
  }

  const activeOp = await getActiveZohoProductionOutputOpForLot(
    parsed.data.finishedLotId,
  );
  if (activeOp?.status === "APPROVED" || activeOp?.status === "QUEUED") {
    return {
      ok: false,
      kind: "LOCAL_ERROR",
      message:
        activeOp.status === "QUEUED"
          ? "A queued preview is frozen. Void it before running a new preview."
          : "An approved preview is frozen. Void it before running a new preview.",
    };
  }

  // WAREHOUSE-RESOLUTION-v1.3.0 — operator pick > product default
  // > app-settings default > env > BLOCK. Replaces the prior
  // operator-or-env-only fallback.
  const appSettingsWarehouseId = await loadAppSettingsWarehouseId();
  const warehouseResolution = resolveProductionOutputWarehouseId({
    operatorOverride: parsed.data.warehouseId,
    productWarehouseId: lot.product.zohoDefaultWarehouseId,
    appSettingsWarehouseId,
    envWarehouseId: config.defaultWarehouseId,
  });

  // WAREHOUSE-CAPABILITY-v1.4.0 — read-through capability call on
  // every preview attempt. The combinator decides use/omit/block.
  // UNKNOWN always blocks regardless of resolution.
  const capability = await fetchWarehouseCapability();
  const decision = decideWarehouseInclusion(capability, warehouseResolution);
  const warehouseAudit = {
    warehouseRequired:
      capability.state === "REQUIRED"
        ? true
        : capability.state === "OPTIONAL"
          ? false
          : null,
    warehouseOmitted: decision.kind === "omit",
    capabilitySource: capabilitySourceLabel(capability),
    capabilityGatewayRequestId:
      capability.state === "UNKNOWN" ? null : capability.gatewayRequestId,
  };

  if (decision.kind === "block") {
    return {
      ok: false,
      kind: "PAYLOAD_BLOCKED",
      message: decision.reason,
      blockers: [
        {
          field: "warehouse_id",
          message: decision.reason,
        },
      ],
    };
  }

  // `use` -> populate; `omit` -> empty string + allowWarehouseOmission
  // flag so the payload builder drops the key entirely.
  const warehouseId = decision.kind === "use" ? decision.warehouseId : "";
  const allowWarehouseOmission = decision.kind === "omit";

  // ZOHO-STAGING-BUFFER-v1.1.0 — build accounting notes from the
  // canonical helper and prepend them to any operator-supplied notes.
  // These are FROZEN into the payload so the same string arrives at
  // commit time whether the buffer expires or an operator pushes by
  // hand. Source = "auto" because the staging buffer's default
  // disposition is auto-commit; the Luma audit log captures the
  // actual trigger separately for the rare manual-override case.
  const accountingNotes = buildProductionOutputNotes(
    {
      lumaOperationId: lot.finishedLot.id,
      finishedLotId: lot.finishedLot.id,
      unitsProduced: lot.finishedLot.unitsProduced,
      productionDate: lot.finishedLot.producedOn,
      casesProduced: lot.finishedLot.casesProduced,
      looseDisplaysProduced: lot.finishedLot.displaysProduced,
      looseSinglesProduced: lot.metrics?.looseCards ?? null,
      source: "auto",
    },
    // production-output gateway notes column caps at 1000 per the
    // existing preview validator. The shared helper truncates safely
    // around priority-1 fields.
    { maxLength: 1000 },
  );
  const operatorNotes = (parsed.data.notes ?? "").trim();
  const combinedNotes = operatorNotes
    ? `${accountingNotes}\n\nOperator notes: ${operatorNotes}`
    : accountingNotes;

  const buildResult = buildProductionOutputPreviewPayload({
    finishedLotId: lot.finishedLot.id,
    workflowBagId: lot.finishedLot.workflowBagId,
    producedOn: lot.finishedLot.producedOn,
    unitsProduced: lot.finishedLot.unitsProduced,
    displaysProduced: lot.finishedLot.displaysProduced,
    casesProduced: lot.finishedLot.casesProduced,
    product: lot.product,
    metrics: lot.metrics,
    mapping: {
      purchaseorderId: parsed.data.purchaseorderId,
      purchaseorderLineItemId: parsed.data.purchaseorderLineItemId,
      warehouseId,
      notes: combinedNotes,
    },
    allowWarehouseOmission,
  });

  if (!buildResult.ok) {
    return {
      ok: false,
      kind: "PAYLOAD_BLOCKED",
      message: "Zoho preview payload is missing required mapping data.",
      blockers: buildResult.blockers,
    };
  }

  // SNAPSHOT-ATTACH-v1.4.1 — build source allocations + snapshot and
  // attach to payload. Without this the gateway emits
  // LUMA_OPERATION_NOT_PERSISTED + ONE_SHOT_SCRIPT_BLOCKED.
  const outputFamily = resolveProductFamily({
    persistedFamily: lot.product.productFamily,
    name: lot.product.productName ?? "",
  });
  // DYNAMIC-BOM-DERIVATION-v1.4.4 — derive BOM opts from product
  // setup data first, then call the allocation builder.
  const allocResolution = await buildAdminPreviewSourceAllocationOpts(
    lot.product.id,
    lot.product.productSku ?? "",
  );
  if (!allocResolution.ok) {
    return {
      ok: false,
      kind: "PAYLOAD_BLOCKED",
      message:
        "Product setup is incomplete for production-output preview. Fix the listed fields and retry.",
      blockers: allocResolution.blockers.map((b) => ({
        field: b.field,
        message: b.message,
      })),
    };
  }
  const sourceBuilt = await buildSourceAllocationsForFinishedLot(
    {
      finishedLotId: lot.finishedLot.id,
      workflowBagId: lot.finishedLot.workflowBagId,
      outputProductFamily: outputFamily,
      outputPoLineItemId: parsed.data.purchaseorderLineItemId,
      unitsPerFinishedUnit: lot.finishedLot.unitsProduced,
    },
    allocResolution.opts,
  );
  if (!sourceBuilt.ok) {
    return {
      ok: false,
      kind: "PAYLOAD_BLOCKED",
      message: "Cannot build production-output source allocations for this lot.",
      blockers: sourceBuilt.blockers.map((b) => ({
        field: b.code,
        message: b.message,
      })),
    };
  }
  const snapshotBuilt = buildLumaOperationSnapshotFromOpRow(
    {
      lumaOperationId: buildResult.payload.luma_operation_id,
      finalizedAt: lot.workflowFinalizedAt,
      productId: lot.product.id,
      productFamily: outputFamily,
      finishedSku: lot.product.productSku,
      unitCompositeItemId: lot.product.zohoItemIdUnit,
      workflowBagId: lot.finishedLot.workflowBagId,
      finishedLotId: lot.finishedLot.id,
    },
    sourceBuilt.rows.map((row) => ({
      lumaInventoryBagId: row.lumaInventoryBagId,
      zohoComponentItemId: row.zohoComponentItemId,
      humanLotNumber: row.humanLotNumber,
      quantityAllocated: row.quantityAllocated,
    })),
  );
  if (!snapshotBuilt.ok) {
    return {
      ok: false,
      kind: "PAYLOAD_BLOCKED",
      message:
        "Cannot build the persisted Luma operation snapshot. Resolve the listed blockers before previewing.",
      blockers: snapshotBuilt.blockers.map((b) => ({
        field: b.code,
        message: b.message,
      })),
    };
  }
  const payloadWithSnapshot = attachSnapshotToPayload(
    buildResult.payload,
    snapshotBuilt.snapshot,
  );
  // The gateway uses verification.mode = "snapshot" to enforce the
  // snapshot match; without it the gateway falls back to one-shot
  // semantics and emits the script-only blockers we are fixing.
  payloadWithSnapshot.verification = { mode: "snapshot" };
  const finalPayload =
    payloadWithSnapshot as typeof buildResult.payload;

  const idempotencyKey = buildProductionOutputPreviewIdempotencyKey(
    lot.finishedLot.id,
    finalPayload,
  );
  const requestHash = buildProductionOutputPreviewRequestHash(finalPayload);
  const metricsState = classifyProductionOutputMetricsState({
    workflowBagId: lot.finishedLot.workflowBagId,
    metrics: lot.metrics,
  });
  const genealogyState = classifyProductionOutputGenealogyState({
    workflowBagId: lot.finishedLot.workflowBagId,
    rawBagLinkCount: lot.rawBagLinkCount,
    highConfidenceRawBagLinkCount: lot.highConfidenceRawBagLinkCount,
  });
  const response = await callProductionOutputPreview({
    payload: finalPayload,
    idempotencyKey,
  });

  const snapshotSource = {
    finalizedAt: lot.workflowFinalizedAt,
    productId: lot.product.id,
    productFamily: outputFamily,
    finishedSku: lot.product.productSku,
  };

  if (response.ok) {
    const persistedPreview = await upsertZohoProductionOutputPreviewOp({
      finishedLotId: lot.finishedLot.id,
      workflowBagId: lot.finishedLot.workflowBagId,
      lumaOperationId: finalPayload.luma_operation_id,
      status: "PREVIEWED",
      payload: finalPayload,
      requestHash,
      previewIdempotencyKey: idempotencyKey,
      previewHttpStatus: response.httpStatus,
      previewResponse: response.body,
      metricsState,
      genealogyState,
      userId: actor.id,
      warehouseAudit,
      snapshotSource,
    });
    // SNAPSHOT-ATTACH-v1.4.1 — persist the source allocations so the
    // gateway's snapshot verification on subsequent preview retries
    // and the commit path can both reconstruct the same shape.
    await persistSourceAllocationsForOp(persistedPreview.id, sourceBuilt.rows);
    return {
      ok: true,
      httpStatus: response.httpStatus,
      body: response.body,
      payload: finalPayload,
      idempotencyKey,
      idempotencyReplay: response.idempotencyReplay,
      persistedPreview,
    };
  }

  const persistedPreview =
    response.httpStatus == null
      ? undefined
      : await upsertZohoProductionOutputPreviewOp({
          finishedLotId: lot.finishedLot.id,
          workflowBagId: lot.finishedLot.workflowBagId,
          lumaOperationId: finalPayload.luma_operation_id,
          status: "DRAFT",
          payload: finalPayload,
          requestHash,
          previewIdempotencyKey: idempotencyKey,
          previewHttpStatus: response.httpStatus,
          previewResponse: response.body,
          metricsState,
          genealogyState,
          userId: actor.id,
          warehouseAudit,
          snapshotSource,
        });
  if (persistedPreview) {
    await persistSourceAllocationsForOp(persistedPreview.id, sourceBuilt.rows);
  }

  return {
    ok: false,
    kind: "SERVICE_ERROR",
    message:
      response.httpStatus == null
        ? response.message
        : productionOutputPreviewStatusMessage(response.httpStatus),
    httpStatus: response.httpStatus,
    body: response.body,
    payload: buildResult.payload,
    idempotencyKey,
    idempotencyReplay: response.idempotencyReplay,
    ...(persistedPreview ? { persistedPreview } : {}),
  };
}

async function loadProductionOutputPreviewLot(finishedLotId: string) {
  const [row] = await db
    .select({
      finishedLot: {
        id: finishedLots.id,
        workflowBagId: finishedLots.workflowBagId,
        producedOn: finishedLots.producedOn,
        unitsProduced: finishedLots.unitsProduced,
        displaysProduced: finishedLots.displaysProduced,
        casesProduced: finishedLots.casesProduced,
      },
      product: {
        // SNAPSHOT-ATTACH-v1.4.1 — id / productSku / productFamily /
        // productName needed for snapshot + source allocation build.
        id: products.id,
        productSku: products.sku,
        productName: products.name,
        productFamily: products.productFamily,
        zohoItemIdUnit: products.zohoItemIdUnit,
        zohoItemIdDisplay: products.zohoItemIdDisplay,
        zohoItemIdCase: products.zohoItemIdCase,
        zohoDefaultWarehouseId: products.zohoDefaultWarehouseId,
      },
      metrics: {
        damagedPackaging: readBagMetrics.damagedPackaging,
        rippedCards: readBagMetrics.rippedCards,
        looseCards: readBagMetrics.looseCards,
      },
      // SNAPSHOT-ATTACH-v1.4.1 — finalized_at lives on workflow_bags
      // and the gateway snapshot requires it to be a valid ISO timestamp.
      workflowFinalizedAt: workflowBags.finalizedAt,
    })
    .from(finishedLots)
    .innerJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(
      readBagMetrics,
      eq(readBagMetrics.workflowBagId, finishedLots.workflowBagId),
    )
    .leftJoin(
      workflowBags,
      eq(workflowBags.id, finishedLots.workflowBagId),
    )
    .where(eq(finishedLots.id, finishedLotId))
    .limit(1);

  if (!row) return null;

  const rawBagLinks = await db
    .select({ confidence: finishedLotRawBags.confidence })
    .from(finishedLotRawBags)
    .where(eq(finishedLotRawBags.finishedLotId, finishedLotId));

  return {
    ...row,
    rawBagLinkCount: rawBagLinks.length,
    highConfidenceRawBagLinkCount: rawBagLinks.filter(
      (link) => link.confidence === "HIGH",
    ).length,
  };
}

/**
 * WAREHOUSE-RESOLUTION-v1.3.0 — Read the app-wide default warehouse
 * from zoho_credentials. Returns null when the row doesn't exist or
 * the column is empty. Pure read; no writes.
 */
async function loadAppSettingsWarehouseId(): Promise<string | null> {
  const [row] = await db
    .select({ warehouseId: zohoCredentials.warehouseId })
    .from(zohoCredentials)
    .limit(1);
  return row?.warehouseId ?? null;
}
