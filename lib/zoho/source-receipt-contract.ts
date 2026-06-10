// ZOHO-SOURCE-RECEIPT-CONTRACT — canonical outbound field for Zoho Integration v1.20.8+.

import type { SourceReceiptEvidence } from "@/lib/zoho/source-receipt-evidence";
import { buildRawBagReceiveIdempotencyKey } from "@/lib/zoho/source-receipt-evidence";

/** Zoho Integration purchase-receive lifecycle (API lowercase). */
export type ZohoApiReceiveStatus =
  | "pending"
  | "previewed"
  | "received"
  | "failed"
  | "unknown";

/** Historical reconciliation state (API lowercase, separate from receive lifecycle). */
export type ZohoApiReconciliationStatus =
  | "unconfirmed"
  | "confirmed_existing"
  | "received_by_luma"
  | "reconciliation_required";

/** Canonical entry serialized as `source_receipts` on Zoho Integration requests. */
export type ZohoOutboundSourceReceipt = {
  source_bag_id: string;
  purchaseorder_id: string | null;
  purchaseorder_line_item_id: string | null;
  raw_item_id: string | null;
  zoho_purchase_receive_id: string | null;
  received_quantity: number | null;
  receive_status: ZohoApiReceiveStatus;
  reconciliation_status: ZohoApiReconciliationStatus;
  received_at: string | null;
  receive_idempotency_key: string;
};

export function mapDbReceiveStatusToApi(
  dbStatus: string | null | undefined,
): ZohoApiReceiveStatus {
  switch (dbStatus) {
    case "PENDING":
      return "pending";
    case "PREVIEWED":
      return "previewed";
    case "COMMITTED":
      return "received";
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

export function mapDbReconciliationToApi(
  dbStatus: string | null | undefined,
): ZohoApiReconciliationStatus {
  switch (dbStatus) {
    case "UNCONFIRMED":
      return "unconfirmed";
    case "CONFIRMED_EXISTING":
      return "confirmed_existing";
    case "RECEIVED_BY_LUMA":
      return "received_by_luma";
    case "RECONCILIATION_REQUIRED":
      return "reconciliation_required";
    default:
      return "reconciliation_required";
  }
}

export function buildOutboundSourceReceipt(
  evidence: SourceReceiptEvidence,
): ZohoOutboundSourceReceipt {
  return {
    source_bag_id: evidence.source_bag_id,
    purchaseorder_id: evidence.purchaseorder_id,
    purchaseorder_line_item_id: evidence.purchaseorder_line_item_id,
    raw_item_id: evidence.raw_item_id,
    zoho_purchase_receive_id: evidence.zoho_purchase_receive_id,
    received_quantity: evidence.received_quantity,
    receive_status: evidence.api_receive_status,
    reconciliation_status: evidence.api_reconciliation_status,
    received_at: evidence.received_at,
    receive_idempotency_key: buildRawBagReceiveIdempotencyKey(
      evidence.source_bag_id,
    ),
  };
}

export function buildOutboundSourceReceipts(
  evidence: readonly SourceReceiptEvidence[],
): ZohoOutboundSourceReceipt[] {
  return evidence.map(buildOutboundSourceReceipt);
}
