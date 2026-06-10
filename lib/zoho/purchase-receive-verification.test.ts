import { describe, expect, it, vi } from "vitest";
import {
  compareVerifiedPurchaseReceiveToLuma,
  normalizeVerifiedZohoPurchaseReceive,
  verifyHistoricalZohoPurchaseReceive,
} from "./purchase-receive-verification";

const ZOHO_ENTITY_ID = "5254962000001234567";

describe("normalizeVerifiedZohoPurchaseReceive", () => {
  it("extracts Zoho receive number separately from entity ID", () => {
    const verified = normalizeVerifiedZohoPurchaseReceive(ZOHO_ENTITY_ID, {
      data: {
        purchase_receive_id: ZOHO_ENTITY_ID,
        purchase_receive_number: "PR-00482",
        date: "2026-05-22",
        purchaseorder_id: "po-1",
        line_items: [
          {
            line_item_id: "line-1",
            item_id: "raw-1",
            quantity: 7219,
          },
        ],
      },
    });
    expect(verified?.zohoPurchaseReceiveId).toBe(ZOHO_ENTITY_ID);
    expect(verified?.zohoReceiveNumber).toBe("PR-00482");
    expect(verified?.receivedQuantity).toBe(7219);
  });
});

describe("verifyHistoricalZohoPurchaseReceive", () => {
  it("rejects Luma receipt number as candidate Zoho ID", async () => {
    const result = await verifyHistoricalZohoPurchaseReceive({
      candidateZohoPurchaseReceiveId: "352176",
      internalReceiptNumber: "352176",
      lumaDeclaredQuantity: 7219,
      lumaZohoPoId: "po-1",
      lumaZohoLineItemId: "line-1",
      lumaRawItemId: "raw-1",
    });
    expect(result.ok).toBe(false);
  });

  it("calls Zoho read endpoint and compares quantity to declared bag qty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        data: {
          purchase_receive_id: ZOHO_ENTITY_ID,
          purchase_receive_number: "PR-00482",
          date: "2026-05-22",
          purchaseorder_id: "po-1",
          line_items: [
            {
              line_item_id: "line-1",
              item_id: "raw-1",
              quantity: 7219,
            },
          ],
        },
        meta: { request_id: "r1", brand: "haute_brands", service: "inv", action: "get" },
      }),
    });

    const result = await verifyHistoricalZohoPurchaseReceive({
      candidateZohoPurchaseReceiveId: ZOHO_ENTITY_ID,
      internalReceiptNumber: "352176",
      lumaDeclaredQuantity: 7219,
      lumaZohoPoId: "po-1",
      lumaZohoLineItemId: "line-1",
      lumaRawItemId: "raw-1",
      env: {
        ZOHO_SERVICE_BASE_URL: "http://zoho.test",
        ZOHO_SERVICE_BEARER_SECRET: "secret",
        ZOHO_BRAND: "haute_brands",
      },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allMatch).toBe(true);
      expect(result.verified.zohoReceiveNumber).toBe("PR-00482");
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/zoho/purchase_receives/get/${ZOHO_ENTITY_ID}`),
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("compareVerifiedPurchaseReceiveToLuma", () => {
  it("flags quantity mismatch", () => {
    const comparisons = compareVerifiedPurchaseReceiveToLuma({
      verified: {
        zohoPurchaseReceiveId: ZOHO_ENTITY_ID,
        zohoReceiveNumber: "PR-1",
        receivedAt: "2026-05-22",
        purchaseorderId: "po-1",
        purchaseorderLineItemId: "line-1",
        rawItemId: "raw-1",
        receivedQuantity: 10,
      },
      lumaDeclaredQuantity: 7219,
      lumaZohoPoId: "po-1",
      lumaZohoLineItemId: "line-1",
      lumaRawItemId: "raw-1",
    });
    expect(comparisons.find((r) => r.field === "received_quantity")?.matches).toBe(
      false,
    );
  });
});
