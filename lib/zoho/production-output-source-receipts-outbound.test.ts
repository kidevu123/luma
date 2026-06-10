import { describe, expect, it } from "vitest";
import { buildOutboundSourceReceipts } from "./source-receipt-contract";
import type { SourceReceiptEvidence } from "./source-receipt-evidence";

describe("production output outbound source_receipts", () => {
  it("uses canonical source_receipts field name for Zoho Integration", () => {
    const evidence: SourceReceiptEvidence[] = [
      {
        source_bag_id: "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
        internal_receipt_number: "352176",
        zoho_purchase_receive_id: null,
        received_quantity: null,
        purchaseorder_id: "po-1",
        purchaseorder_line_item_id: "line-1",
        raw_item_id: "raw-1",
        api_receive_status: "unknown",
        api_reconciliation_status: "reconciliation_required",
        received_at: null,
        has_durable_row: false,
      },
    ];

    const source_receipts = buildOutboundSourceReceipts(evidence);
    const previewPayload = {
      quantity_good: 10,
      quantity_loose: 0,
      assembly_only: false,
      source_receipts,
    };

    expect(previewPayload).toHaveProperty("source_receipts");
    expect(previewPayload).not.toHaveProperty("source_receipt_evidence");
    expect(previewPayload.source_receipts[0]?.receive_status).toBe("unknown");
    expect(previewPayload.source_receipts[0]?.reconciliation_status).toBe(
      "reconciliation_required",
    );
    expect(previewPayload.source_receipts[0]?.receive_idempotency_key).toBe(
      "luma-bag-finish-receive:4a02fc5b-27e4-412e-888a-bf24f84b7d38",
    );
  });

  it("assembly-only confirmed receipt omits receive lifecycle ambiguity", () => {
    const source_receipts = buildOutboundSourceReceipts([
      {
        source_bag_id: "bag-1",
        internal_receipt_number: "1001",
        zoho_purchase_receive_id: "5254962000001234567",
        received_quantity: 7219,
        purchaseorder_id: "po-1",
        purchaseorder_line_item_id: "line-1",
        raw_item_id: "raw-1",
        api_receive_status: "received",
        api_reconciliation_status: "received_by_luma",
        received_at: "2026-05-22T00:00:00.000Z",
        has_durable_row: true,
      },
    ]);

    expect(source_receipts[0]?.receive_status).toBe("received");
    expect(source_receipts[0]?.reconciliation_status).toBe("received_by_luma");
  });
});
