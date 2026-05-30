import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import type {
  ProductionOutputDataQualityState,
  ProductionOutputPreviewPayload,
} from "@/lib/zoho/production-output-preview";

export type ZohoProductionOutputPreviewStatus = "DRAFT" | "PREVIEWED";

export type ZohoProductionOutputPreviewMetadata = {
  id: string;
  status: ZohoProductionOutputPreviewStatus;
  requestHash: string;
  metricsState: ProductionOutputDataQualityState;
  genealogyState: ProductionOutputDataQualityState;
  previewedAt: Date | null;
  previewHttpStatus: number | null;
  zohoPurchaseorderId: string;
  zohoPurchaseorderLineItemId: string;
  zohoWarehouseId: string | null;
  zohoCompositeItemId: string | null;
};

export type UpsertZohoProductionOutputPreviewOpInput = {
  finishedLotId: string;
  workflowBagId: string | null;
  lumaOperationId: string;
  status: ZohoProductionOutputPreviewStatus;
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
    .select({ id: zohoProductionOutputOps.id })
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.finishedLotId, input.finishedLotId),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .limit(1);

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
  return row ? toPreviewMetadata(row) : null;
}

function toPreviewMetadata(
  row: typeof zohoProductionOutputOps.$inferSelect,
): ZohoProductionOutputPreviewMetadata {
  return {
    id: row.id,
    status: row.status as ZohoProductionOutputPreviewStatus,
    requestHash: row.requestHash,
    metricsState: row.metricsState as ProductionOutputDataQualityState,
    genealogyState: row.genealogyState as ProductionOutputDataQualityState,
    previewedAt: row.previewedAt,
    previewHttpStatus: row.previewHttpStatus,
    zohoPurchaseorderId: row.zohoPurchaseorderId,
    zohoPurchaseorderLineItemId: row.zohoPurchaseorderLineItemId,
    zohoWarehouseId: row.zohoWarehouseId,
    zohoCompositeItemId: row.zohoCompositeItemId,
  };
}
