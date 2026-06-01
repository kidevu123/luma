import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import type {
  ProductionOutputDataQualityState,
  ProductionOutputPreviewPayload,
} from "@/lib/zoho/production-output-preview";
import {
  canVoidZohoProductionOutputOp,
  evaluateZohoProductionOutputApproval,
  type ZohoProductionOutputOpStatus,
} from "@/lib/zoho/production-output-approval";

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
  zohoPurchaseorderId: string;
  zohoPurchaseorderLineItemId: string;
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

  if (existing?.status === "APPROVED") {
    throw new Error(
      "An approved preview is frozen. Void it before running a new preview.",
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
  return row ? toPreviewMetadata(row) : null;
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
