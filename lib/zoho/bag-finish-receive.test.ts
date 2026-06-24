import { describe, expect, it, vi } from "vitest";
import {
  assertNotProductionOutputReceiveQuantity,
  resolveBagFinishReceiveQuantity,
} from "./bag-finish-receive-quantity";
import { assessBagFinishReceiveEligibility } from "./bag-finish-receive-eligibility";
import { buildBagFinishReceivePayload } from "./bag-finish-receive";
import { buildBagFinishReceiveIdempotencyKey } from "./source-receipt-evidence";
import { validateZohoPurchaseReceiveIdCandidate } from "./receipt-id-validation";
import { buildOutboundSourceReceipts } from "./source-receipt-contract";
import type { SourceReceiptEvidence } from "./source-receipt-evidence";
import { evaluateSourceReceiptEvidenceForProductionOutput } from "./source-receipt-evidence";
import { mapProductionOutputPreviewQuantities } from "./production-output-preview-quantities";

const BAG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BAG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("bag-finish receive quantity", () => {
  it("uses declared pill count for full-bag receive (Choco regression)", () => {
    const r = resolveBagFinishReceiveQuantity({
      declaredPillCount: 7219,
      pillCount: 0,
      finalClosedPillCount: 7219,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quantity).toBe(7219);
      expect(r.source).toBe("final_closed_pill_count");
    }
  });

  it("never uses quantity_good or consumed allocation as receive qty", () => {
    const r = resolveBagFinishReceiveQuantity({
      declaredPillCount: 7219,
      pillCount: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const guard = assertNotProductionOutputReceiveQuantity(r.quantity, {
        quantityGood: 10,
        unitAssemblyQuantity: 10,
        looseCards: 10,
        consumedAllocationQty: 40,
      });
      expect(guard.ok).toBe(true);
      expect(r.quantity).not.toBe(10);
      expect(r.quantity).not.toBe(40);
    }
  });

  it("blocks receive quantity that equals partial consumed allocation only", () => {
    const guard = assertNotProductionOutputReceiveQuantity(40, {
      consumedAllocationQty: 40,
      declaredPhysicalQty: 7219,
    });
    expect(guard.ok).toBe(false);
  });

  it("allows full-bag deplete when consumed allocation matches declared physical qty", () => {
    const guard = assertNotProductionOutputReceiveQuantity(7884, {
      consumedAllocationQty: 7884,
      declaredPhysicalQty: 7884,
    });
    expect(guard.ok).toBe(true);
  });
});

describe("bag-finish eligibility", () => {
  it("blocks fresh unused bag at intake", () => {
    const r = assessBagFinishReceiveEligibility({
      bagStatus: "AVAILABLE",
      isLiveReceiveCommitted: false,
      allocation: {
        hasOpenSession: false,
        hasClosedOrDepletedSession: false,
        lastSessionStatus: null,
        totalConsumedQty: 0,
        lastEndingBalanceQty: null,
      },
    });
    expect(r.eligible).toBe(false);
  });

  it("allows depleted bag after floor closeout", () => {
    const r = assessBagFinishReceiveEligibility({
      bagStatus: "EMPTIED",
      isLiveReceiveCommitted: false,
      allocation: {
        hasOpenSession: false,
        hasClosedOrDepletedSession: true,
        lastSessionStatus: "DEPLETED",
        totalConsumedQty: 40,
        lastEndingBalanceQty: 0,
      },
    });
    expect(r.eligible).toBe(true);
  });

  it("allows multiple bags on same PO line independently", () => {
    const keyA = buildBagFinishReceiveIdempotencyKey(BAG_A);
    const keyB = buildBagFinishReceiveIdempotencyKey(BAG_B);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe(`luma-bag-finish-receive:${BAG_A}`);
  });
});

describe("bag-finish payload", () => {
  it("builds canonical preview request with per-bag idempotency", () => {
    const payload = buildBagFinishReceivePayload({
      inventoryBagId: BAG_A,
      lumaReceiveId: "recv-1",
      internalReceiptNumber: "352176",
      humanLotNumber: "152-000166",
      receivedQuantity: 7219,
      quantitySource: "declared_pill_count",
      zohoPoId: "po-1",
      zohoLineItemId: "line-1",
      zohoTabletItemId: "raw-1",
      receiveDate: "2026-06-09",
      siblingBagsOnPoLine: 2,
    });
    expect(payload.received_quantity).toBe(7219);
    expect(payload.idempotency_key).toBe(`luma-bag-finish-receive:${BAG_A}`);
    expect(payload.human_lot_number).toBe("152-000166");
  });
});

describe("receipt ID validation", () => {
  it("rejects Luma receipt number 352176", () => {
    const r = validateZohoPurchaseReceiveIdCandidate("352176", "352176");
    expect(r.ok).toBe(false);
  });

  it("rejects Zoho receive number PR-xxxxx", () => {
    const r = validateZohoPurchaseReceiveIdCandidate("PR-00482", "352176");
    expect(r.ok).toBe(false);
  });
});

describe("production-output assembly-only gate", () => {
  const baseEvidence: SourceReceiptEvidence = {
    source_bag_id: BAG_A,
    internal_receipt_number: "352176",
    purchaseorder_id: "po-1",
    purchaseorder_line_item_id: "line-1",
    raw_item_id: "raw-1",
    zoho_purchase_receive_id: null,
    received_quantity: null,
    received_at: null,
    api_receive_status: "unknown",
    api_reconciliation_status: "reconciliation_required",
    has_durable_row: false,
  };

  it("blocks Choco operation when source bag receipt pending", () => {
    const gate = evaluateSourceReceiptEvidenceForProductionOutput([baseEvidence]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(
        gate.blockers.some((b) => b.code === "SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED"),
      ).toBe(true);
    }
  });

  it("clears blocker when bag has confirmed receive", () => {
    const confirmed: SourceReceiptEvidence = {
      ...baseEvidence,
      zoho_purchase_receive_id: "5254962000001234567",
      api_receive_status: "received",
      api_reconciliation_status: "received_by_luma",
      has_durable_row: true,
    };
    const gate = evaluateSourceReceiptEvidenceForProductionOutput([confirmed]);
    expect(gate.ok).toBe(true);
  });

  it("all-loose CARD run sends quantity_loose=0", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 10,
      displaysProduced: null,
      casesProduced: null,
      looseCards: 10,
    });
    expect(mapped.quantity_good).toBe(10);
    expect(mapped.quantity_loose).toBe(0);
  });
});

describe("bag-finish preview client", () => {
  it("preview path does not require live write gate on commit guard", async () => {
    const { callBagFinishReceivePreview } = await import("./bag-finish-receive-client");
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        data: { receipt_granularity_policy: "per_bag", transaction_count: 1 },
        meta: { capability: "luma.raw_intake.preview" },
      }),
    });
    const result = await callBagFinishReceivePreview(
      {
        source_bag_id: BAG_A,
        internal_receipt_number: "352176",
        purchaseorder_id: "po-1",
        purchaseorder_line_item_id: "line-1",
        raw_item_id: "raw-1",
        human_lot_number: "152-000166",
        received_quantity: 7219,
        receive_date: "2026-06-09",
        idempotency_key: buildBagFinishReceiveIdempotencyKey(BAG_A),
      },
      {
        env: {
          ZOHO_SERVICE_BASE_URL: "http://zoho.test",
          ZOHO_SERVICE_BEARER_SECRET: "secret",
          ZOHO_BRAND: "haute_brands",
        },
        fetchImpl,
      },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://zoho.test/zoho/luma/bag-receive/preview",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("commit is blocked without PM authorization gate", async () => {
    const { callBagFinishReceiveCommit } = await import("./bag-finish-receive-client");
    const result = await callBagFinishReceiveCommit(
      {
        source_bag_id: BAG_A,
        internal_receipt_number: "352176",
        purchaseorder_id: "po-1",
        purchaseorder_line_item_id: "line-1",
        raw_item_id: "raw-1",
        human_lot_number: null,
        received_quantity: 7219,
        receive_date: "2026-06-09",
        idempotency_key: buildBagFinishReceiveIdempotencyKey(BAG_A),
      },
      {
        env: {
          ZOHO_SERVICE_BASE_URL: "http://zoho.test",
          ZOHO_SERVICE_BEARER_SECRET: "secret",
          ZOHO_DRY_RUN_WRITES_ENABLED: "true",
          ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED: "false",
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.guardBlocked).toBe(true);
    }
  });

  it("commit reaches gateway when PM commit gate is enabled", async () => {
    const { callBagFinishReceiveCommit } = await import("./bag-finish-receive-client");
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ data: { purchase_receive_id: "pr-test" } }),
    });
    const result = await callBagFinishReceiveCommit(
      {
        source_bag_id: BAG_A,
        internal_receipt_number: "352177",
        purchaseorder_id: "po-1",
        purchaseorder_line_item_id: "line-1",
        raw_item_id: "raw-1",
        human_lot_number: "152-000161",
        received_quantity: 7884,
        receive_date: "2026-05-22",
        idempotency_key: buildBagFinishReceiveIdempotencyKey(BAG_A),
      },
      {
        env: {
          ZOHO_SERVICE_BASE_URL: "http://zoho.test",
          ZOHO_SERVICE_BEARER_SECRET: "secret",
          ZOHO_DRY_RUN_WRITES_ENABLED: "true",
          ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED: "true",
        },
        fetchImpl,
      },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://zoho.test/zoho/luma/bag-receive/commit",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("outbound source_receipts", () => {
  it("serializes reconciliation_required for unreceived Choco bag", () => {
    const outbound = buildOutboundSourceReceipts([
      {
        source_bag_id: "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
        internal_receipt_number: "352176",
        purchaseorder_id: "po-1",
        purchaseorder_line_item_id: "line-1",
        raw_item_id: "raw-1",
        zoho_purchase_receive_id: null,
        received_quantity: null,
        received_at: null,
        api_receive_status: "unknown",
        api_reconciliation_status: "reconciliation_required",
        has_durable_row: false,
      },
    ]);
    expect(outbound[0]?.reconciliation_status).toBe("reconciliation_required");
    expect(outbound[0]?.receive_idempotency_key).toContain("luma-bag-finish-receive:");
  });
});
