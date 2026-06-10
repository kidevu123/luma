// ZOHO-PURCHASE-RECEIVE-VERIFY — read-only historical receive verification (v1.20.8).

import { getInventoryPurchaseReceive } from "@/lib/zoho/inventory-service-client";
import { validateZohoPurchaseReceiveIdCandidate } from "@/lib/zoho/receipt-id-validation";

export type VerifiedZohoPurchaseReceive = {
  zohoPurchaseReceiveId: string;
  zohoReceiveNumber: string | null;
  receivedAt: string | null;
  purchaseorderId: string | null;
  purchaseorderLineItemId: string | null;
  rawItemId: string | null;
  receivedQuantity: number | null;
};

export type PurchaseReceiveVerificationComparison = {
  field: string;
  lumaValue: string | number | null;
  zohoValue: string | number | null;
  matches: boolean;
};

export type PurchaseReceiveVerificationResult =
  | {
      ok: true;
      verified: VerifiedZohoPurchaseReceive;
      comparisons: PurchaseReceiveVerificationComparison[];
      allMatch: boolean;
    }
  | { ok: false; reason: string };

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize Zoho Integration GET /zoho/purchase_receives/get/:id response. */
export function normalizeVerifiedZohoPurchaseReceive(
  purchaseReceiveId: string,
  body: unknown,
): VerifiedZohoPurchaseReceive | null {
  if (body == null || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;

  const lineItems = Array.isArray(data.line_items)
    ? (data.line_items as Record<string, unknown>[])
    : [];
  const firstLine = lineItems[0] ?? null;

  const receivedQuantity =
    asNumber(firstLine?.quantity) ??
    asNumber(data.total_quantity) ??
    asNumber(data.quantity);

  return {
    zohoPurchaseReceiveId:
      asString(data.purchase_receive_id) ??
      asString(data.receive_id) ??
      purchaseReceiveId,
    zohoReceiveNumber:
      asString(data.purchase_receive_number) ??
      asString(data.receive_number) ??
      null,
    receivedAt: asString(data.date) ?? asString(data.received_date) ?? null,
    purchaseorderId: asString(data.purchaseorder_id) ?? null,
    purchaseorderLineItemId:
      asString(firstLine?.line_item_id) ?? asString(data.line_item_id) ?? null,
    rawItemId: asString(firstLine?.item_id) ?? asString(data.item_id) ?? null,
    receivedQuantity,
  };
}

export function compareVerifiedPurchaseReceiveToLuma(input: {
  verified: VerifiedZohoPurchaseReceive;
  lumaDeclaredQuantity: number;
  lumaZohoPoId: string | null;
  lumaZohoLineItemId: string | null;
  lumaRawItemId: string | null;
}): PurchaseReceiveVerificationComparison[] {
  const comparisons: PurchaseReceiveVerificationComparison[] = [
    {
      field: "received_quantity",
      lumaValue: input.lumaDeclaredQuantity,
      zohoValue: input.verified.receivedQuantity,
      matches:
        input.verified.receivedQuantity != null &&
        input.verified.receivedQuantity === input.lumaDeclaredQuantity,
    },
    {
      field: "purchaseorder_id",
      lumaValue: input.lumaZohoPoId,
      zohoValue: input.verified.purchaseorderId,
      matches:
        !input.lumaZohoPoId ||
        input.verified.purchaseorderId === input.lumaZohoPoId,
    },
    {
      field: "purchaseorder_line_item_id",
      lumaValue: input.lumaZohoLineItemId,
      zohoValue: input.verified.purchaseorderLineItemId,
      matches:
        !input.lumaZohoLineItemId ||
        input.verified.purchaseorderLineItemId === input.lumaZohoLineItemId,
    },
    {
      field: "raw_item_id",
      lumaValue: input.lumaRawItemId,
      zohoValue: input.verified.rawItemId,
      matches:
        !input.lumaRawItemId ||
        input.verified.rawItemId === input.lumaRawItemId,
    },
  ];

  return comparisons;
}

export async function verifyHistoricalZohoPurchaseReceive(input: {
  candidateZohoPurchaseReceiveId: string;
  internalReceiptNumber: string | null;
  lumaDeclaredQuantity: number;
  lumaZohoPoId: string | null;
  lumaZohoLineItemId: string | null;
  lumaRawItemId: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<PurchaseReceiveVerificationResult> {
  const idCheck = validateZohoPurchaseReceiveIdCandidate(
    input.candidateZohoPurchaseReceiveId,
    input.internalReceiptNumber,
  );
  if (!idCheck.ok) return idCheck;

  const fetchOpts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  } = {};
  if (input.env) fetchOpts.env = input.env;
  if (input.fetchImpl) fetchOpts.fetchImpl = input.fetchImpl;

  const fetchResult = await getInventoryPurchaseReceive(
    idCheck.zohoPurchaseReceiveId,
    fetchOpts,
  );

  if (!fetchResult.ok) {
    return {
      ok: false,
      reason: `Zoho verification failed: ${fetchResult.message}`,
    };
  }

  const verified = normalizeVerifiedZohoPurchaseReceive(
    idCheck.zohoPurchaseReceiveId,
    fetchResult.data,
  );

  if (!verified) {
    return {
      ok: false,
      reason: "Zoho response did not include a recognizable purchase receive.",
    };
  }

  const comparisons = compareVerifiedPurchaseReceiveToLuma({
    verified,
    lumaDeclaredQuantity: input.lumaDeclaredQuantity,
    lumaZohoPoId: input.lumaZohoPoId,
    lumaZohoLineItemId: input.lumaZohoLineItemId,
    lumaRawItemId: input.lumaRawItemId,
  });

  const allMatch = comparisons.every((row) => row.matches);

  return { ok: true, verified, comparisons, allMatch };
}
