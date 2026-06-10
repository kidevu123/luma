// ZOHO-RAW-BAG-RECEIVE-UI — panel data for Path B Zoho receive workflow.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  inventoryBags,
  poLines,
  purchaseOrders,
  receives,
  smallBoxes,
  tabletTypes,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import { RAW_BAG_RECEIPT_GRANULARITY } from "@/lib/zoho/raw-bag-receipt-granularity";
import {
  mapDbReceiveStatusToApi,
  mapDbReconciliationToApi,
} from "@/lib/zoho/source-receipt-contract";
import { deriveLegacyBagReconciliationStatus } from "@/lib/zoho/source-receipt-evidence";
import { buildRawBagIntakeReceivePayload } from "@/lib/zoho/raw-bag-intake-receive";

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
  /** Luma operator receipt number — not a Zoho entity ID. */
  lumaReceipt: string | null;
  internalReceiptNumber: string | null;
  humanLotNumber: string | null;
  declaredQuantity: number;
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
  canPreview: boolean;
  canCommit: boolean;
  canRetry: boolean;
  canReconcileHistorical: boolean;
};

export async function loadRawBagZohoReceivePanel(
  inventoryBagId: string,
): Promise<RawBagZohoReceivePanelData | null> {
  const [row] = await db
    .select({
      bagId: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      batchNumber: batches.batchNumber,
      poNumber: purchaseOrders.poNumber,
      zohoPoId: purchaseOrders.zohoPoId,
      zohoLineItemId: poLines.zohoLineItemId,
      tabletName: tabletTypes.name,
      tabletZohoItemId: tabletTypes.zohoItemId,
      receiveId: receives.id,
      receivedAt: receives.receivedAt,
    })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .leftJoin(poLines, eq(receives.poLineId, poLines.id))
    .innerJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  if (!row) return null;

  const declaredQuantity = row.declaredPillCount ?? row.pillCount ?? 0;

  const [durable] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId))
    .limit(1);

  const reconciliationDb =
    durable?.reconciliationStatus ??
    deriveLegacyBagReconciliationStatus(durable != null) ??
    "RECONCILIATION_REQUIRED";

  const receiveStatus = durable
    ? mapDbReceiveStatusToApi(durable.zohoReceiveStatus)
    : "unknown";

  const isLiveReceiveCommitted =
    durable?.zohoReceiveStatus === "COMMITTED" &&
    !!durable.zohoPurchaseReceiveId?.trim();

  const hasZohoMapping =
    !!row.zohoPoId?.trim() &&
    !!row.zohoLineItemId?.trim() &&
    !!row.tabletZohoItemId?.trim();

  let previewPlannedQuantity: number | null = null;
  if (hasZohoMapping && declaredQuantity > 0) {
    const payload = buildRawBagIntakeReceivePayload(
      {
        inventoryBagId: row.bagId,
        lumaReceiveId: row.receiveId,
        internalReceiptNumber: row.internalReceiptNumber,
        declaredPillCount: declaredQuantity,
        zohoPoId: row.zohoPoId!,
        zohoLineItemId: row.zohoLineItemId!,
        zohoTabletItemId: row.tabletZohoItemId!,
        receiveDate: row.receivedAt
          ? row.receivedAt.toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
      },
      { dryRun: true },
    );
    const lineItems = payload.line_items as Array<{ quantity: number }> | undefined;
    previewPlannedQuantity = lineItems?.[0]?.quantity ?? null;
  }

  return {
    inventoryBagId: row.bagId,
    lumaReceipt: row.internalReceiptNumber,
    internalReceiptNumber: row.internalReceiptNumber,
    humanLotNumber: row.batchNumber ?? null,
    declaredQuantity,
    poNumber: row.poNumber ?? null,
    zohoPoId: row.zohoPoId ?? null,
    zohoLineItemId: row.zohoLineItemId ?? null,
    rawItemId: row.tabletZohoItemId ?? null,
    rawItemName: row.tabletName ?? null,
    receiveStatus,
    reconciliationStatus: mapDbReconciliationToApi(reconciliationDb),
    zohoPurchaseReceiveId: durable?.zohoPurchaseReceiveId ?? null,
    zohoReceiveNumber: durable?.zohoReceiveNumber ?? null,
    zohoReceivedQuantity: durable?.zohoReceivedQuantity ?? null,
    receivedAt: durable?.zohoReceivedAt?.toISOString() ?? null,
    lastPreviewError: durable?.zohoReceiveError ?? null,
    previewHttpStatus: durable?.previewHttpStatus ?? null,
    previewPlannedQuantity,
    isLiveReceiveCommitted,
    canPreview: hasZohoMapping && !isLiveReceiveCommitted && declaredQuantity > 0,
    canCommit:
      hasZohoMapping &&
      !isLiveReceiveCommitted &&
      declaredQuantity > 0 &&
      (receiveStatus === "previewed" || receiveStatus === "failed"),
    canRetry: receiveStatus === "failed",
    canReconcileHistorical:
      !isLiveReceiveCommitted &&
      reconciliationDb !== "RECEIVED_BY_LUMA",
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
      smallBoxId: inventoryBags.smallBoxId,
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
    granularityDescription: RAW_BAG_RECEIPT_GRANULARITY.operatorSummary,
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
