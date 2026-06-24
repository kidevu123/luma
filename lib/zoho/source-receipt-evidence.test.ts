import { describe, expect, it } from "vitest";
import {
  deriveLegacyBagReconciliationStatus,
  evaluateSourceReceiptEvidenceForProductionOutput,
  isSourceReceiptConfirmedForAssembly,
  buildBagFinishReceiveIdempotencyKey,
  type SourceReceiptEvidence,
} from "./source-receipt-evidence";

describe("deriveLegacyBagReconciliationStatus", () => {
  it("marks legacy bags without durable row as reconciliation-required", () => {
    expect(deriveLegacyBagReconciliationStatus(false)).toBe(
      "RECONCILIATION_REQUIRED",
    );
    expect(deriveLegacyBagReconciliationStatus(true)).toBeNull();
  });
});

describe("isSourceReceiptConfirmedForAssembly", () => {
  const base = (
    overrides?: Partial<SourceReceiptEvidence>,
  ): SourceReceiptEvidence => ({
    source_bag_id: "bag-1",
    internal_receipt_number: "352176",
    zoho_purchase_receive_id: "5254962000001234567",
    received_quantity: 7219,
    purchaseorder_id: "po-1",
    purchaseorder_line_item_id: "line-1",
    raw_item_id: "raw-1",
    api_receive_status: "received",
    api_reconciliation_status: "received_by_luma",
    received_at: null,
    has_durable_row: true,
    ...overrides,
  });

  it("allows received lifecycle with Zoho receive ID", () => {
    expect(isSourceReceiptConfirmedForAssembly(base())).toBe(true);
  });

  it("allows confirmed_existing with real receive ID", () => {
    expect(
      isSourceReceiptConfirmedForAssembly(
        base({
          api_receive_status: "unknown",
          api_reconciliation_status: "confirmed_existing",
        }),
      ),
    ).toBe(true);
  });

  it("rejects confirmed_existing without receive ID", () => {
    expect(
      isSourceReceiptConfirmedForAssembly(
        base({
          zoho_purchase_receive_id: null,
          api_reconciliation_status: "confirmed_existing",
        }),
      ),
    ).toBe(false);
  });

  it("rejects reconciliation_required legacy state", () => {
    expect(
      isSourceReceiptConfirmedForAssembly(
        base({
          zoho_purchase_receive_id: null,
          api_receive_status: "unknown",
          api_reconciliation_status: "reconciliation_required",
          has_durable_row: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("evaluateSourceReceiptEvidenceForProductionOutput", () => {
  const receivedBag = (
    overrides?: Partial<SourceReceiptEvidence>,
  ): SourceReceiptEvidence => ({
    source_bag_id: "bag-1",
    internal_receipt_number: "352176",
    zoho_purchase_receive_id: "5254962000001234567",
    received_quantity: 7219,
    purchaseorder_id: "po-1",
    purchaseorder_line_item_id: "line-1",
    raw_item_id: "raw-1",
    api_receive_status: "received",
    api_reconciliation_status: "received_by_luma",
    received_at: null,
    has_durable_row: true,
    ...overrides,
  });

  it("allows assembly-only when all source bags are received", () => {
    const result = evaluateSourceReceiptEvidenceForProductionOutput([
      receivedBag(),
    ]);
    expect(result).toEqual({ ok: true, assemblyOnly: true });
  });

  it("blocks production output when receipt is reconciliation-required", () => {
    const result = evaluateSourceReceiptEvidenceForProductionOutput([
      receivedBag({
        zoho_purchase_receive_id: null,
        api_receive_status: "unknown",
        api_reconciliation_status: "reconciliation_required",
        has_durable_row: false,
      }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers[0]?.code).toBe(
        "SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED",
      );
    }
  });

  it("uses stable bag-level idempotency key", () => {
    expect(
      buildBagFinishReceiveIdempotencyKey(
        "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
      ),
    ).toBe(
      "luma-bag-finish-receive:4a02fc5b-27e4-412e-888a-bf24f84b7d38",
    );
  });
});
