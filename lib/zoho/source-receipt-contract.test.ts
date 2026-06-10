import { describe, expect, it } from "vitest";
import {
  buildOutboundSourceReceipt,
  buildOutboundSourceReceipts,
  mapDbReceiveStatusToApi,
  mapDbReconciliationToApi,
} from "./source-receipt-contract";
import type { SourceReceiptEvidence } from "./source-receipt-evidence";

const sampleEvidence = (
  overrides?: Partial<SourceReceiptEvidence>,
): SourceReceiptEvidence => ({
  source_bag_id: "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
  internal_receipt_number: "352176",
  zoho_purchase_receive_id: "5254962000001234567",
  received_quantity: 7219,
  purchaseorder_id: "po-zoho-1",
  purchaseorder_line_item_id: "line-zoho-1",
  raw_item_id: "tablet-zoho-1",
  api_receive_status: "received",
  api_reconciliation_status: "received_by_luma",
  received_at: "2026-05-22T12:00:00.000Z",
  has_durable_row: true,
  ...overrides,
});

describe("source-receipt-contract", () => {
  it("maps DB receive lifecycle to API lowercase values", () => {
    expect(mapDbReceiveStatusToApi("PENDING")).toBe("pending");
    expect(mapDbReceiveStatusToApi("PREVIEWED")).toBe("previewed");
    expect(mapDbReceiveStatusToApi("COMMITTED")).toBe("received");
    expect(mapDbReceiveStatusToApi("FAILED")).toBe("failed");
    expect(mapDbReceiveStatusToApi(null)).toBe("unknown");
  });

  it("maps DB reconciliation separately from receive lifecycle", () => {
    expect(mapDbReconciliationToApi("UNCONFIRMED")).toBe("unconfirmed");
    expect(mapDbReconciliationToApi("CONFIRMED_EXISTING")).toBe(
      "confirmed_existing",
    );
    expect(mapDbReconciliationToApi("RECEIVED_BY_LUMA")).toBe(
      "received_by_luma",
    );
    expect(mapDbReconciliationToApi("RECONCILIATION_REQUIRED")).toBe(
      "reconciliation_required",
    );
  });

  it("serializes canonical source_receipts field for Zoho Integration", () => {
    const outbound = buildOutboundSourceReceipt(sampleEvidence());
    expect(outbound).toEqual({
      source_bag_id: "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
      purchaseorder_id: "po-zoho-1",
      purchaseorder_line_item_id: "line-zoho-1",
      raw_item_id: "tablet-zoho-1",
      zoho_purchase_receive_id: "5254962000001234567",
      received_quantity: 7219,
      receive_status: "received",
      reconciliation_status: "received_by_luma",
      received_at: "2026-05-22T12:00:00.000Z",
      receive_idempotency_key:
        "luma-raw-bag-receive:4a02fc5b-27e4-412e-888a-bf24f84b7d38",
    });
  });

  it("buildOutboundSourceReceipts uses source_receipts shape (not source_receipt_evidence)", () => {
    const rows = buildOutboundSourceReceipts([sampleEvidence()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("receive_status", "received");
    expect(rows[0]).not.toHaveProperty("source_receipt_evidence");
  });

  it("legacy bag without durable row maps receive_status unknown", () => {
    const outbound = buildOutboundSourceReceipt(
      sampleEvidence({
        has_durable_row: false,
        api_receive_status: "unknown",
        api_reconciliation_status: "reconciliation_required",
        zoho_purchase_receive_id: null,
        received_quantity: null,
        received_at: null,
      }),
    );
    expect(outbound.receive_status).toBe("unknown");
    expect(outbound.reconciliation_status).toBe("reconciliation_required");
  });
});
