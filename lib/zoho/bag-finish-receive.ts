// ZOHO-BAG-FINISH-RECEIVE — preview/commit at bag closeout (not intake).

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  batches,
  inventoryBags,
  poLines,
  purchaseOrders,
  rawBagAllocationSessions,
  receives,
  smallBoxes,
  tabletTypes,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import { assessBagFinishReceiveEligibility } from "@/lib/zoho/bag-finish-receive-eligibility";
import {
  assertNotProductionOutputReceiveQuantity,
  resolveBagFinishReceiveQuantity,
} from "@/lib/zoho/bag-finish-receive-quantity";
import {
  callBagFinishReceiveCommit,
  callBagFinishReceivePreview,
  type BagFinishReceiveRequest,
} from "@/lib/zoho/bag-finish-receive-client";
import { parseZohoPurchaseReceiveId } from "@/lib/zoho/zoho-purchase-receive-id";
import { buildBagFinishReceiveIdempotencyKey } from "@/lib/zoho/source-receipt-evidence";
import type { AssemblyServiceCallResult } from "@/lib/zoho/assembly-service-client";

export type BagFinishReceiveBuildInput = {
  inventoryBagId: string;
  lumaReceiveId: string;
  internalReceiptNumber: string | null;
  humanLotNumber: string | null;
  receivedQuantity: number;
  quantitySource: string;
  zohoPoId: string;
  zohoLineItemId: string;
  zohoTabletItemId: string;
  receiveDate: string;
  siblingBagsOnPoLine: number;
};

export function buildBagFinishReceivePayload(
  input: BagFinishReceiveBuildInput,
): BagFinishReceiveRequest {
  return {
    source_bag_id: input.inventoryBagId,
    internal_receipt_number: input.internalReceiptNumber,
    purchaseorder_id: input.zohoPoId,
    purchaseorder_line_item_id: input.zohoLineItemId,
    raw_item_id: input.zohoTabletItemId,
    human_lot_number: input.humanLotNumber,
    received_quantity: input.receivedQuantity,
    receive_date: input.receiveDate,
    idempotency_key: buildBagFinishReceiveIdempotencyKey(input.inventoryBagId),
  };
}

function parseZohoReceiveNumber(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const num =
    data.receive_number ??
    data.purchase_receive_number ??
    data.zoho_receive_number;
  return typeof num === "string" && num.trim() ? num.trim() : null;
}

async function loadAllocationSnapshot(inventoryBagId: string) {
  const sessions = await db
    .select({
      status: rawBagAllocationSessions.allocationStatus,
      consumedQty: rawBagAllocationSessions.consumedQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId))
    .orderBy(desc(rawBagAllocationSessions.closedAt));

  const hasOpenSession = sessions.some((s) => s.status === "OPEN");
  const closed = sessions.filter(
    (s) => s.status === "CLOSED" || s.status === "DEPLETED",
  );
  const totalConsumedQty = closed.reduce(
    (sum, s) => sum + (s.consumedQty ?? 0),
    0,
  );
  const last = closed[0];

  return {
    hasOpenSession,
    hasClosedOrDepletedSession: closed.length > 0,
    lastSessionStatus: last?.status ?? null,
    totalConsumedQty,
    lastEndingBalanceQty: last?.endingBalanceQty ?? null,
  };
}

async function countSiblingBagsOnPoLine(
  poLineId: string | null,
  excludeBagId: string,
): Promise<number> {
  if (!poLineId) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .where(and(eq(receives.poLineId, poLineId), ne(inventoryBags.id, excludeBagId)));
  return row?.count ?? 0;
}

export async function loadBagFinishReceiveContext(inventoryBagId: string) {
  const [row] = await db
    .select({
      bagId: inventoryBags.id,
      bagStatus: inventoryBags.status,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      batchNumber: batches.batchNumber,
      receiveId: receives.id,
      receivedAt: receives.receivedAt,
      poLineId: receives.poLineId,
      poNumber: purchaseOrders.poNumber,
      zohoPoId: purchaseOrders.zohoPoId,
      zohoLineItemId: poLines.zohoLineItemId,
      tabletName: tabletTypes.name,
      tabletZohoItemId: tabletTypes.zohoItemId,
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

  if (!row) return { ok: false as const, reason: "Inventory bag not found." };

  const allocation = await loadAllocationSnapshot(inventoryBagId);

  const [durable] = await db
    .select({
      zohoReceiveStatus: zohoRawBagReceives.zohoReceiveStatus,
      zohoPurchaseReceiveId: zohoRawBagReceives.zohoPurchaseReceiveId,
    })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId))
    .limit(1);

  const isLiveReceiveCommitted =
    durable?.zohoReceiveStatus === "COMMITTED" &&
    !!durable.zohoPurchaseReceiveId?.trim();

  const eligibility = assessBagFinishReceiveEligibility({
    bagStatus: row.bagStatus,
    isLiveReceiveCommitted,
    allocation,
  });

  const qty = resolveBagFinishReceiveQuantity({
    declaredPillCount: row.declaredPillCount,
    pillCount: row.pillCount,
    finalClosedPillCount:
      row.bagStatus === "EMPTIED" && row.declaredPillCount != null
        ? row.declaredPillCount
        : null,
  });

  if (!qty.ok) return qty;

  const qtyGuard = assertNotProductionOutputReceiveQuantity(qty.quantity, {
    consumedAllocationQty: allocation.totalConsumedQty,
    declaredPhysicalQty: row.declaredPillCount ?? row.pillCount,
  });
  if (!qtyGuard.ok) return qtyGuard;

  if (!row.zohoPoId) {
    return { ok: false as const, reason: "Receive is missing Zoho PO mapping." };
  }
  if (!row.zohoLineItemId) {
    return { ok: false as const, reason: "Receive is missing Zoho PO line item mapping." };
  }
  if (!row.tabletZohoItemId) {
    return { ok: false as const, reason: "Tablet type is missing Zoho item ID." };
  }

  const receiveDate = row.receivedAt
    ? row.receivedAt.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const siblingBagsOnPoLine = await countSiblingBagsOnPoLine(
    row.poLineId,
    inventoryBagId,
  );

  return {
    ok: true as const,
    eligibility,
    allocation,
    buildInput: {
      inventoryBagId: row.bagId,
      lumaReceiveId: row.receiveId,
      internalReceiptNumber: row.internalReceiptNumber,
      humanLotNumber: row.batchNumber ?? null,
      receivedQuantity: qty.quantity,
      quantitySource: qty.source,
      zohoPoId: row.zohoPoId,
      zohoLineItemId: row.zohoLineItemId,
      zohoTabletItemId: row.tabletZohoItemId,
      receiveDate,
      siblingBagsOnPoLine,
    },
    poNumber: row.poNumber,
    rawItemName: row.tabletName,
    declaredPillCount: row.declaredPillCount,
    pillCount: row.pillCount,
  };
}

async function upsertRawBagReceiveRow(
  buildInput: BagFinishReceiveBuildInput,
  actor: Pick<CurrentUser, "id"> | null,
) {
  const idempotencyKey = buildBagFinishReceiveIdempotencyKey(buildInput.inventoryBagId);
  const now = new Date();

  const [existing] = await db
    .select({ id: zohoRawBagReceives.id })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, buildInput.inventoryBagId))
    .limit(1);

  if (existing) {
    await db
      .update(zohoRawBagReceives)
      .set({
        zohoPurchaseorderId: buildInput.zohoPoId,
        zohoPurchaseorderLineItemId: buildInput.zohoLineItemId,
        zohoReceivedQuantity: buildInput.receivedQuantity,
        zohoReceiveIdempotencyKey: idempotencyKey,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(eq(zohoRawBagReceives.id, existing.id));
    return { ok: true as const, rowId: existing.id };
  }

  const [inserted] = await db
    .insert(zohoRawBagReceives)
    .values({
      inventoryBagId: buildInput.inventoryBagId,
      receiveId: buildInput.lumaReceiveId,
      zohoPurchaseorderId: buildInput.zohoPoId,
      zohoPurchaseorderLineItemId: buildInput.zohoLineItemId,
      zohoReceivedQuantity: buildInput.receivedQuantity,
      zohoReceiveIdempotencyKey: idempotencyKey,
      zohoReceiveStatus: "PENDING",
      reconciliationStatus: "UNCONFIRMED",
      lastAttemptAt: now,
      updatedAt: now,
    })
    .returning({ id: zohoRawBagReceives.id });

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: null,
    action: "zoho_raw_bag_receive.pending_seeded",
    targetType: "ZohoRawBagReceive",
    targetId: inserted!.id,
    after: {
      inventoryBagId: buildInput.inventoryBagId,
      quantity: buildInput.receivedQuantity,
      policy: "bag_finish",
    },
  });

  return { ok: true as const, rowId: inserted!.id };
}

async function persistPreviewResult(
  inventoryBagId: string,
  result: AssemblyServiceCallResult,
) {
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: result.ok ? "PREVIEWED" : "FAILED",
      zohoReceiveError: result.ok ? null : result.message,
      previewHttpStatus: result.httpStatus,
      previewResponse: result.body as object,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId));
}

export async function previewBagFinishReceive(
  inventoryBagId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; httpStatus: number; body: unknown }
  | { ok: false; reason: string }
> {
  const ctx = await loadBagFinishReceiveContext(inventoryBagId);
  if (!ctx.ok) return ctx;

  if (!ctx.eligibility.eligible) {
    return { ok: false, reason: ctx.eligibility.reason };
  }

  await upsertRawBagReceiveRow(ctx.buildInput, actor);

  const payload = buildBagFinishReceivePayload(ctx.buildInput);
  const result = await callBagFinishReceivePreview(payload);
  await persistPreviewResult(inventoryBagId, result);

  if (!result.ok) {
    return { ok: false, reason: result.message };
  }
  return { ok: true, httpStatus: result.httpStatus, body: result.body };
}

export async function commitBagFinishReceive(
  inventoryBagId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; zohoPurchaseReceiveId: string }
  | { ok: false; reason: string }
> {
  const ctx = await loadBagFinishReceiveContext(inventoryBagId);
  if (!ctx.ok) return ctx;

  if (!ctx.eligibility.eligible) {
    return { ok: false, reason: ctx.eligibility.reason };
  }

  const [durable] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId))
    .limit(1);

  if (durable?.zohoReceiveStatus === "COMMITTED") {
    return {
      ok: false,
      reason: "Duplicate receive blocked — this bag already has a committed Zoho purchase receive.",
    };
  }

  if (durable?.zohoReceiveStatus !== "PREVIEWED") {
    return {
      ok: false,
      reason: "Preview bag-finish receive before commit.",
    };
  }

  const payload = buildBagFinishReceivePayload(ctx.buildInput);
  const result = await callBagFinishReceiveCommit(payload);

  if (!result.ok) {
    await persistPreviewResult(inventoryBagId, result);
    return { ok: false, reason: result.message };
  }

  const zohoPurchaseReceiveId = parseZohoPurchaseReceiveId(result.body);
  if (!zohoPurchaseReceiveId) {
    return {
      ok: false,
      reason: "Zoho response did not include purchase_receive_id.",
    };
  }

  const zohoReceiveNumber = parseZohoReceiveNumber(result.body);
  const now = new Date();

  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "COMMITTED",
      zohoPurchaseReceiveId,
      zohoReceiveNumber,
      zohoReceivedQuantity: ctx.buildInput.receivedQuantity,
      zohoReceivedAt: now,
      reconciliationStatus: "RECEIVED_BY_LUMA",
      reconciledAt: now,
      reconciledBy: actor?.id ?? null,
      zohoReceiveError: null,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: null,
    action: "zoho_raw_bag_receive.committed",
    targetType: "ZohoRawBagReceive",
    targetId: inventoryBagId,
    after: {
      zohoPurchaseReceiveId,
      quantity: ctx.buildInput.receivedQuantity,
      policy: "bag_finish",
    },
  });

  return { ok: true, zohoPurchaseReceiveId };
}
