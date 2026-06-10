// ZOHO-RAW-BAG-RECEIVE-1 — source bag Zoho receive evidence for production output.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  poLines,
  purchaseOrders,
  receives,
  smallBoxes,
  tabletTypes,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import {
  mapDbReceiveStatusToApi,
  mapDbReconciliationToApi,
  type ZohoApiReceiveStatus,
  type ZohoApiReconciliationStatus,
} from "@/lib/zoho/source-receipt-contract";

export type SourceReceiptEvidenceBlocker = {
  code: string;
  message: string;
  source_bag_id: string;
};

/** Internal evidence row — map to canonical `source_receipts` at serialization. */
export type SourceReceiptEvidence = {
  source_bag_id: string;
  internal_receipt_number: string | null;
  zoho_purchase_receive_id: string | null;
  received_quantity: number | null;
  purchaseorder_id: string | null;
  purchaseorder_line_item_id: string | null;
  raw_item_id: string | null;
  /** Zoho receive lifecycle (API lowercase). */
  api_receive_status: ZohoApiReceiveStatus;
  /** Historical reconciliation (API lowercase). */
  api_reconciliation_status: ZohoApiReconciliationStatus;
  received_at: string | null;
  has_durable_row: boolean;
};

/** Derive reconciliation for bags with no durable row (legacy Path B intake). */
export function deriveLegacyBagReconciliationStatus(
  hasDurableRow: boolean,
): "RECONCILIATION_REQUIRED" | null {
  if (!hasDurableRow) return "RECONCILIATION_REQUIRED";
  return null;
}

export function isSourceReceiptConfirmedForAssembly(
  row: SourceReceiptEvidence,
): boolean {
  const receiveId = row.zoho_purchase_receive_id?.trim();
  if (!receiveId) return false;
  return (
    row.api_receive_status === "received" ||
    row.api_reconciliation_status === "confirmed_existing"
  );
}

export async function loadSourceReceiptEvidenceForBags(
  inventoryBagIds: readonly string[],
): Promise<Map<string, SourceReceiptEvidence>> {
  const out = new Map<string, SourceReceiptEvidence>();
  if (inventoryBagIds.length === 0) return out;

  const bagRows = await db
    .select({
      id: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      tabletZohoItemId: tabletTypes.zohoItemId,
      receiveId: receives.id,
      zohoPoId: purchaseOrders.zohoPoId,
      zohoLineItemId: poLines.zohoLineItemId,
    })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .innerJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .leftJoin(poLines, eq(receives.poLineId, poLines.id))
    .where(inArray(inventoryBags.id, [...inventoryBagIds]));

  const durableRows = await db
    .select()
    .from(zohoRawBagReceives)
    .where(inArray(zohoRawBagReceives.inventoryBagId, [...inventoryBagIds]));

  const durableByBag = new Map(durableRows.map((r) => [r.inventoryBagId, r]));

  for (const bag of bagRows) {
    const durable = durableByBag.get(bag.id);
    const hasDurableRow = durable != null;
    const reconciliationDb =
      durable?.reconciliationStatus ??
      deriveLegacyBagReconciliationStatus(hasDurableRow) ??
      "RECONCILIATION_REQUIRED";

    const apiReceiveStatus = hasDurableRow
      ? mapDbReceiveStatusToApi(durable!.zohoReceiveStatus)
      : "unknown";

    out.set(bag.id, {
      source_bag_id: bag.id,
      internal_receipt_number: bag.internalReceiptNumber,
      zoho_purchase_receive_id: durable?.zohoPurchaseReceiveId ?? null,
      received_quantity: durable?.zohoReceivedQuantity ?? null,
      purchaseorder_id:
        durable?.zohoPurchaseorderId ?? bag.zohoPoId ?? null,
      purchaseorder_line_item_id:
        durable?.zohoPurchaseorderLineItemId ?? bag.zohoLineItemId ?? null,
      raw_item_id: bag.tabletZohoItemId ?? null,
      api_receive_status: apiReceiveStatus,
      api_reconciliation_status: mapDbReconciliationToApi(reconciliationDb),
      received_at: durable?.zohoReceivedAt?.toISOString() ?? null,
      has_durable_row: hasDurableRow,
    });
  }

  return out;
}

export function evaluateSourceReceiptEvidenceForProductionOutput(
  evidence: readonly SourceReceiptEvidence[],
): { ok: true; assemblyOnly: boolean } | { ok: false; blockers: SourceReceiptEvidenceBlocker[] } {
  const blockers: SourceReceiptEvidenceBlocker[] = [];

  for (const row of evidence) {
    if (!isSourceReceiptConfirmedForAssembly(row)) {
      blockers.push({
        code: "SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED",
        message: `Source bag ${row.internal_receipt_number ?? row.source_bag_id.slice(0, 8)} has no confirmed Zoho purchase receive. Complete bag-finish receive before production output.`,
        source_bag_id: row.source_bag_id,
      });
    }
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  return { ok: true, assemblyOnly: true };
}

/** @deprecated Use buildBagFinishReceiveIdempotencyKey — bag-finish policy v1.21. */
export function buildRawBagReceiveIdempotencyKey(inventoryBagId: string): string {
  return buildBagFinishReceiveIdempotencyKey(inventoryBagId);
}

/** One Zoho purchase receive per physical bag; idempotency scoped to inventory_bag_id. */
export function buildBagFinishReceiveIdempotencyKey(inventoryBagId: string): string {
  return `luma-bag-finish-receive:${inventoryBagId}`;
}
