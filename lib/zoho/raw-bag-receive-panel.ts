// ZOHO-RAW-BAG-RECEIVE-UI — panel data for bag-finish Zoho receive workflow.

import { eq, inArray, and, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  receives,
  smallBoxes,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import {
  buildBagFinishReceivePayload,
  loadBagFinishReceiveContext,
} from "@/lib/zoho/bag-finish-receive";
import { RAW_BAG_RECEIPT_GRANULARITY } from "@/lib/zoho/raw-bag-receipt-granularity";
import {
  mapDbReceiveStatusToApi,
  mapDbReconciliationToApi,
} from "@/lib/zoho/source-receipt-contract";
import { deriveLegacyBagReconciliationStatus } from "@/lib/zoho/source-receipt-evidence";

export type IntakeReceiveZohoSummary = {
  receiveId: string;
  receiveName: string | null;
  bagCount: number;
  totalDeclaredQuantity: number;
  zohoTransactionsOnFullCommit: number;
  granularityPolicy: string;
  granularityDescription: string;
  perBagQuantities: Array<{
    inventoryBagId: string;
    lumaReceipt: string | null;
    declaredQuantity: number;
  }>;
};

export type RawBagZohoReceivePanelData = {
  inventoryBagId: string;
  lumaReceipt: string | null;
  internalReceiptNumber: string | null;
  humanLotNumber: string | null;
  declaredQuantity: number;
  finalPillCount: number | null;
  consumedQuantity: number;
  endingBalance: number | null;
  zohoReceiveQuantity: number;
  quantitySource: string;
  siblingBagsOnPoLine: number;
  poNumber: string | null;
  zohoPoId: string | null;
  zohoLineItemId: string | null;
  rawItemId: string | null;
  rawItemName: string | null;
  receiveStatus: string;
  reconciliationStatus: string;
  zohoPurchaseReceiveId: string | null;
  zohoReceiveNumber: string | null;
  zohoReceivedQuantity: number | null;
  receivedAt: string | null;
  lastPreviewError: string | null;
  previewHttpStatus: number | null;
  previewPlannedQuantity: number | null;
  isLiveReceiveCommitted: boolean;
  bagFinishEligible: boolean;
  bagFinishIneligibleReason: string | null;
  canPreview: boolean;
  canCommit: boolean;
  canRetry: boolean;
  canReconcileHistorical: boolean;
  granularityNote: string;
};

export async function loadRawBagZohoReceivePanel(
  inventoryBagId: string,
): Promise<RawBagZohoReceivePanelData | null> {
  const ctx = await loadBagFinishReceiveContext(inventoryBagId);
  if (!ctx.ok) return null;

  const [durable] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId))
    .limit(1);

  const reconciliationDb =
    durable?.reconciliationStatus ??
    deriveLegacyBagReconciliationStatus(durable != null) ??
    "UNCONFIRMED";

  const receiveStatus = durable
    ? mapDbReceiveStatusToApi(durable.zohoReceiveStatus)
    : "pending";

  const isLiveReceiveCommitted =
    durable?.zohoReceiveStatus === "COMMITTED" &&
    !!durable.zohoPurchaseReceiveId?.trim();

  const bagFinishEligible = ctx.eligibility.eligible;
  const bagFinishIneligibleReason = ctx.eligibility.eligible
    ? null
    : ctx.eligibility.reason;

  const previewPayload = buildBagFinishReceivePayload(ctx.buildInput);

  return {
    inventoryBagId: ctx.buildInput.inventoryBagId,
    lumaReceipt: ctx.buildInput.internalReceiptNumber,
    internalReceiptNumber: ctx.buildInput.internalReceiptNumber,
    humanLotNumber: ctx.buildInput.humanLotNumber,
    declaredQuantity: ctx.declaredPillCount ?? ctx.buildInput.receivedQuantity,
    finalPillCount: ctx.pillCount,
    consumedQuantity: ctx.allocation.totalConsumedQty,
    endingBalance: ctx.allocation.lastEndingBalanceQty,
    zohoReceiveQuantity: ctx.buildInput.receivedQuantity,
    quantitySource: ctx.buildInput.quantitySource,
    siblingBagsOnPoLine: ctx.buildInput.siblingBagsOnPoLine,
    poNumber: ctx.poNumber ?? null,
    zohoPoId: ctx.buildInput.zohoPoId,
    zohoLineItemId: ctx.buildInput.zohoLineItemId,
    rawItemId: ctx.buildInput.zohoTabletItemId,
    rawItemName: ctx.rawItemName ?? null,
    receiveStatus,
    reconciliationStatus: mapDbReconciliationToApi(reconciliationDb),
    zohoPurchaseReceiveId: durable?.zohoPurchaseReceiveId ?? null,
    zohoReceiveNumber: durable?.zohoReceiveNumber ?? null,
    zohoReceivedQuantity: durable?.zohoReceivedQuantity ?? null,
    receivedAt: durable?.zohoReceivedAt?.toISOString() ?? null,
    lastPreviewError: durable?.zohoReceiveError ?? null,
    previewHttpStatus: durable?.previewHttpStatus ?? null,
    previewPlannedQuantity: previewPayload.received_quantity,
    isLiveReceiveCommitted,
    bagFinishEligible,
    bagFinishIneligibleReason,
    canPreview: bagFinishEligible && !isLiveReceiveCommitted,
    canCommit:
      bagFinishEligible &&
      !isLiveReceiveCommitted &&
      (receiveStatus === "previewed" || receiveStatus === "failed"),
    canRetry: receiveStatus === "failed",
    canReconcileHistorical:
      !isLiveReceiveCommitted && reconciliationDb !== "RECEIVED_BY_LUMA",
    granularityNote: RAW_BAG_RECEIPT_GRANULARITY.operatorSummary,
  };
}

export async function loadIntakeReceiveZohoSummary(
  receiveId: string,
): Promise<IntakeReceiveZohoSummary | null> {
  const [receiveRow] = await db
    .select({
      id: receives.id,
      receiveName: receives.receiveName,
    })
    .from(receives)
    .where(eq(receives.id, receiveId))
    .limit(1);

  if (!receiveRow) return null;

  const bagRows = await db
    .select({
      id: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
    })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .where(eq(smallBoxes.receiveId, receiveId));

  const perBagQuantities = bagRows.map((bag) => ({
    inventoryBagId: bag.id,
    lumaReceipt: bag.internalReceiptNumber,
    declaredQuantity: bag.declaredPillCount ?? bag.pillCount ?? 0,
  }));

  const totalDeclaredQuantity = perBagQuantities.reduce(
    (sum, row) => sum + row.declaredQuantity,
    0,
  );

  return {
    receiveId: receiveRow.id,
    receiveName: receiveRow.receiveName,
    bagCount: perBagQuantities.length,
    totalDeclaredQuantity,
    zohoTransactionsOnFullCommit: perBagQuantities.length,
    granularityPolicy: RAW_BAG_RECEIPT_GRANULARITY.policy,
    granularityDescription:
      "Each bag will receive into Zoho separately when finished or depleted on the floor.",
    perBagQuantities,
  };
}

export async function loadIntakeReceiveZohoSummaryForBags(
  bagIds: readonly string[],
): Promise<IntakeReceiveZohoSummary | null> {
  if (bagIds.length === 0) return null;
  const [firstBag] = await db
    .select({ receiveId: receives.id })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .where(inArray(inventoryBags.id, [...bagIds]))
    .limit(1);
  if (!firstBag) return null;
  return loadIntakeReceiveZohoSummary(firstBag.receiveId);
}

/** Count other physical bags on the same PO line (same flavor/item). */
export async function countBagsOnPoLine(
  poLineId: string,
  excludeBagId?: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .where(excludeBagId ? and(eq(receives.poLineId, poLineId), ne(inventoryBags.id, excludeBagId)) : eq(receives.poLineId, poLineId));
  return row?.count ?? 0;
}
