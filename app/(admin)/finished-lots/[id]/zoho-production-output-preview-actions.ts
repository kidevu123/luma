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

  const warehouseId =
    parsed.data.warehouseId || config.defaultWarehouseId || "";
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
      notes: parsed.data.notes ?? null,
    },
  });

  if (!buildResult.ok) {
    return {
      ok: false,
      kind: "PAYLOAD_BLOCKED",
      message: "Zoho preview payload is missing required mapping data.",
      blockers: buildResult.blockers,
    };
  }

  const idempotencyKey = buildProductionOutputPreviewIdempotencyKey(
    lot.finishedLot.id,
    buildResult.payload,
  );
  const requestHash = buildProductionOutputPreviewRequestHash(
    buildResult.payload,
  );
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
    payload: buildResult.payload,
    idempotencyKey,
  });

  if (response.ok) {
    const persistedPreview = await upsertZohoProductionOutputPreviewOp({
      finishedLotId: lot.finishedLot.id,
      workflowBagId: lot.finishedLot.workflowBagId,
      lumaOperationId: buildResult.payload.luma_operation_id,
      status: "PREVIEWED",
      payload: buildResult.payload,
      requestHash,
      previewIdempotencyKey: idempotencyKey,
      previewHttpStatus: response.httpStatus,
      previewResponse: response.body,
      metricsState,
      genealogyState,
      userId: actor.id,
    });
    return {
      ok: true,
      httpStatus: response.httpStatus,
      body: response.body,
      payload: buildResult.payload,
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
          lumaOperationId: buildResult.payload.luma_operation_id,
          status: "DRAFT",
          payload: buildResult.payload,
          requestHash,
          previewIdempotencyKey: idempotencyKey,
          previewHttpStatus: response.httpStatus,
          previewResponse: response.body,
          metricsState,
          genealogyState,
          userId: actor.id,
        });

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
        zohoItemIdUnit: products.zohoItemIdUnit,
        zohoItemIdDisplay: products.zohoItemIdDisplay,
        zohoItemIdCase: products.zohoItemIdCase,
      },
      metrics: {
        damagedPackaging: readBagMetrics.damagedPackaging,
        rippedCards: readBagMetrics.rippedCards,
        looseCards: readBagMetrics.looseCards,
      },
    })
    .from(finishedLots)
    .innerJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(
      readBagMetrics,
      eq(readBagMetrics.workflowBagId, finishedLots.workflowBagId),
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
