// ZOHO-RAW-BAG-RECEIVE-1 — Path B intake purchase receive preview/commit.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
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
  buildRawBagReceiveIdempotencyKey,
} from "@/lib/zoho/source-receipt-evidence";
import {
  callZohoAssemblyService,
  type AssemblyServiceCallResult,
} from "@/lib/zoho/assembly-service-client";
import { validateZohoPurchaseReceiveIdCandidate } from "@/lib/zoho/receipt-id-validation";
import { verifyHistoricalZohoPurchaseReceive } from "@/lib/zoho/purchase-receive-verification";

export type RawBagReceiveBuildInput = {
  inventoryBagId: string;
  lumaReceiveId: string;
  internalReceiptNumber: string | null;
  declaredPillCount: number;
  zohoPoId: string;
  zohoLineItemId: string;
  zohoTabletItemId: string;
  receiveDate: string;
  warehouseId?: string | null;
};

export function buildRawBagIntakeReceivePayload(
  input: RawBagReceiveBuildInput,
  opts?: { dryRun?: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    dry_run: opts?.dryRun !== false,
    luma_operation_id: buildRawBagReceiveIdempotencyKey(input.inventoryBagId),
    luma_bag_id: input.inventoryBagId,
    luma_workflow_session_id: input.lumaReceiveId,
    purchaseorder_id: input.zohoPoId,
    date: input.receiveDate,
    line_items: [
      {
        line_item_id: input.zohoLineItemId,
        item_id: input.zohoTabletItemId,
        quantity: input.declaredPillCount,
        unit: "pcs",
      },
    ],
    notes: `Luma raw-bag intake receive for ${input.internalReceiptNumber ?? input.inventoryBagId}`,
  };
  if (input.warehouseId) {
    payload.warehouse_id = input.warehouseId;
  }
  return payload;
}

export function parseZohoPurchaseReceiveId(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const direct = o.receive_id ?? o.purchase_receive_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = o.receive;
  if (nested != null && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).receive_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

async function loadRawBagReceiveContext(inventoryBagId: string) {
  const [row] = await db
    .select({
      bagId: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      receiveId: receives.id,
      receivedAt: receives.receivedAt,
      zohoPoId: purchaseOrders.zohoPoId,
      zohoLineItemId: poLines.zohoLineItemId,
      tabletZohoItemId: tabletTypes.zohoItemId,
    })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .leftJoin(poLines, eq(receives.poLineId, poLines.id))
    .innerJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  if (!row) return { ok: false as const, reason: "Inventory bag not found." };

  const qty = row.declaredPillCount ?? row.pillCount;
  if (qty == null || qty <= 0) {
    return {
      ok: false as const,
      reason: "Bag has no declared physical quantity for Zoho receive.",
    };
  }
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

  return {
    ok: true as const,
    buildInput: {
      inventoryBagId: row.bagId,
      lumaReceiveId: row.receiveId,
      internalReceiptNumber: row.internalReceiptNumber,
      declaredPillCount: qty,
      zohoPoId: row.zohoPoId,
      zohoLineItemId: row.zohoLineItemId,
      zohoTabletItemId: row.tabletZohoItemId,
      receiveDate,
    },
  };
}

async function upsertRawBagReceiveRow(
  buildInput: RawBagReceiveBuildInput,
  actor: Pick<CurrentUser, "id"> | null,
) {
  const idempotencyKey = buildRawBagReceiveIdempotencyKey(buildInput.inventoryBagId);
  const now = new Date();

  const [existing] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, buildInput.inventoryBagId))
    .limit(1);

  if (existing?.zohoReceiveStatus === "COMMITTED" && existing.zohoPurchaseReceiveId) {
    return { ok: false as const, reason: "This bag already has a committed Zoho purchase receive." };
  }

  const values = {
    inventoryBagId: buildInput.inventoryBagId,
    receiveId: buildInput.lumaReceiveId,
    zohoPurchaseorderId: buildInput.zohoPoId,
    zohoPurchaseorderLineItemId: buildInput.zohoLineItemId,
    zohoReceivedQuantity: buildInput.declaredPillCount,
    zohoReceiveIdempotencyKey: idempotencyKey,
    reconciliationStatus: "UNCONFIRMED" as const,
    lastAttemptAt: now,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(zohoRawBagReceives)
      .set(values)
      .where(eq(zohoRawBagReceives.id, existing.id));
    return { ok: true as const, rowId: existing.id };
  }

  const [inserted] = await db
    .insert(zohoRawBagReceives)
    .values(values)
    .returning({ id: zohoRawBagReceives.id });

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: null,
    action: "zoho_raw_bag_receive.created",
    targetType: "ZohoRawBagReceive",
    targetId: inserted!.id,
    after: {
      inventoryBagId: buildInput.inventoryBagId,
      quantity: buildInput.declaredPillCount,
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

export async function previewRawBagIntakeReceive(
  inventoryBagId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; httpStatus: number; body: unknown }
  | { ok: false; reason: string }
> {
  const ctx = await loadRawBagReceiveContext(inventoryBagId);
  if (!ctx.ok) return ctx;

  const upsert = await upsertRawBagReceiveRow(ctx.buildInput, actor);
  if (!upsert.ok) return upsert;

  const payload = buildRawBagIntakeReceivePayload(ctx.buildInput, { dryRun: true });
  const result = await callZohoAssemblyService({
    path: "/zoho/purchase_receives/create",
    payload,
    idempotencyKey: `${buildRawBagReceiveIdempotencyKey(inventoryBagId)}-preview`,
  });

  await persistPreviewResult(inventoryBagId, result);

  if (!result.ok) {
    return { ok: false, reason: result.message };
  }
  return { ok: true, httpStatus: result.httpStatus, body: result.body };
}

export async function commitRawBagIntakeReceive(
  inventoryBagId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; zohoPurchaseReceiveId: string }
  | { ok: false; reason: string }
> {
  const ctx = await loadRawBagReceiveContext(inventoryBagId);
  if (!ctx.ok) return ctx;

  const [existing] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(
      and(
        eq(zohoRawBagReceives.inventoryBagId, inventoryBagId),
        eq(zohoRawBagReceives.zohoReceiveStatus, "COMMITTED"),
      ),
    )
    .limit(1);

  if (existing?.zohoPurchaseReceiveId) {
    return {
      ok: false,
      reason: "Zoho purchase receive already committed for this bag.",
    };
  }

  await upsertRawBagReceiveRow(ctx.buildInput, actor);

  const payload = buildRawBagIntakeReceivePayload(ctx.buildInput, { dryRun: false });
  const idempotencyKey = buildRawBagReceiveIdempotencyKey(inventoryBagId);
  const result = await callZohoAssemblyService({
    path: "/zoho/purchase_receives/create",
    payload,
    idempotencyKey,
  });

  if (!result.ok) {
    await db
      .update(zohoRawBagReceives)
      .set({
        zohoReceiveStatus: "FAILED",
        zohoReceiveError: result.message,
        previewHttpStatus: result.httpStatus,
        previewResponse: result.body as object,
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId));
    return { ok: false, reason: result.message };
  }

  const zohoPurchaseReceiveId = parseZohoPurchaseReceiveId(result.body);
  if (!zohoPurchaseReceiveId) {
    return {
      ok: false,
      reason: "Zoho response did not include purchase_receive_id.",
    };
  }

  const [bagMeta] = await db
    .select({ internalReceiptNumber: inventoryBags.internalReceiptNumber })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);
  const idCheck = validateZohoPurchaseReceiveIdCandidate(
    zohoPurchaseReceiveId,
    bagMeta?.internalReceiptNumber ?? null,
  );
  if (!idCheck.ok) {
    return { ok: false, reason: idCheck.reason };
  }

  const now = new Date();
  await db
    .update(zohoRawBagReceives)
    .set({
      zohoReceiveStatus: "COMMITTED",
      zohoPurchaseReceiveId,
      zohoReceivedQuantity: ctx.buildInput.declaredPillCount,
      zohoReceivedAt: now,
      reconciliationStatus: "RECEIVED_BY_LUMA",
      zohoReceiveError: null,
      previewHttpStatus: result.httpStatus,
      previewResponse: result.body as object,
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
      quantity: ctx.buildInput.declaredPillCount,
    },
  });

  return { ok: true, zohoPurchaseReceiveId };
}

export async function verifyRawBagHistoricalZohoReceive(
  inventoryBagId: string,
  candidateZohoPurchaseReceiveId: string,
) {
  const ctx = await loadRawBagReceiveContext(inventoryBagId);
  if (!ctx.ok) return ctx;

  const [bagMeta] = await db
    .select({ internalReceiptNumber: inventoryBags.internalReceiptNumber })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  return verifyHistoricalZohoPurchaseReceive({
    candidateZohoPurchaseReceiveId,
    internalReceiptNumber: bagMeta?.internalReceiptNumber ?? null,
    lumaDeclaredQuantity: ctx.buildInput.declaredPillCount,
    lumaZohoPoId: ctx.buildInput.zohoPoId,
    lumaZohoLineItemId: ctx.buildInput.zohoLineItemId,
    lumaRawItemId: ctx.buildInput.zohoTabletItemId,
  });
}

export type PendingRawBagReceiveSeed = {
  inventoryBagId: string;
  receiveId: string;
  declaredPillCount: number;
  zohoPoId: string | null;
  zohoLineItemId: string | null;
};

/** Persist PENDING rows for new Path B bags — never called for legacy backfill. */
export async function seedPendingRawBagReceiveRows(
  seeds: readonly PendingRawBagReceiveSeed[],
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<void> {
  if (seeds.length === 0) return;
  const now = new Date();

  for (const seed of seeds) {
    const idempotencyKey = buildRawBagReceiveIdempotencyKey(seed.inventoryBagId);
    const [existing] = await db
      .select({ id: zohoRawBagReceives.id })
      .from(zohoRawBagReceives)
      .where(eq(zohoRawBagReceives.inventoryBagId, seed.inventoryBagId))
      .limit(1);

    if (existing) continue;

    const [inserted] = await db
      .insert(zohoRawBagReceives)
      .values({
        inventoryBagId: seed.inventoryBagId,
        receiveId: seed.receiveId,
        zohoPurchaseorderId: seed.zohoPoId,
        zohoPurchaseorderLineItemId: seed.zohoLineItemId,
        zohoReceivedQuantity: seed.declaredPillCount,
        zohoReceiveIdempotencyKey: idempotencyKey,
        zohoReceiveStatus: "PENDING",
        reconciliationStatus: "UNCONFIRMED",
        lastAttemptAt: now,
        updatedAt: now,
      })
      .returning({ id: zohoRawBagReceives.id });

    await writeAudit({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action: "zoho_raw_bag_receive.pending_seeded",
      targetType: "ZohoRawBagReceive",
      targetId: inserted!.id,
      after: {
        inventoryBagId: seed.inventoryBagId,
        quantity: seed.declaredPillCount,
      },
    });
  }
}

export async function confirmHistoricalZohoReceive(
  inventoryBagId: string,
  input: {
    zohoPurchaseReceiveId: string;
    reconciliationNotes?: string | null;
  },
  actor: Pick<CurrentUser, "id" | "role"> | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verification = await verifyRawBagHistoricalZohoReceive(
    inventoryBagId,
    input.zohoPurchaseReceiveId,
  );
  if (!verification.ok) return verification;
  if (!verification.allMatch) {
    const mismatches = verification.comparisons
      .filter((row) => !row.matches)
      .map((row) => row.field)
      .join(", ");
    return {
      ok: false,
      reason: `Zoho purchase receive does not match this Luma bag (${mismatches}).`,
    };
  }

  const receiveId = verification.verified.zohoPurchaseReceiveId;
  const receivedAt = verification.verified.receivedAt
    ? new Date(verification.verified.receivedAt)
    : null;
  const now = new Date();

  const result = await setRawBagReconciliationStatus(
    inventoryBagId,
    "CONFIRMED_EXISTING",
    actor,
    {
      zohoPurchaseReceiveId: receiveId,
      receivedQuantity: verification.verified.receivedQuantity,
      receivedAt,
      zohoReceiveNumber: verification.verified.zohoReceiveNumber,
      verifiedAt: now,
      reconciledAt: now,
      reconciledBy: actor?.id ?? null,
      reconciliationNotes: input.reconciliationNotes ?? null,
      doNotLiveReceive: true,
    },
  );
  if (!result.ok) return result;

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.historical_confirmed",
    targetType: "InventoryBag",
    targetId: inventoryBagId,
    after: {
      zohoPurchaseReceiveId: receiveId,
      zohoReceiveNumber: verification.verified.zohoReceiveNumber,
      receivedQuantity: verification.verified.receivedQuantity,
      zohoReceivedAt: verification.verified.receivedAt,
      reconciledAt: now.toISOString(),
      reconciledBy: actor?.id ?? null,
      notes: input.reconciliationNotes ?? null,
    },
  });

  return { ok: true };
}

export async function setRawBagReconciliationStatus(
  inventoryBagId: string,
  status: "CONFIRMED_EXISTING" | "RECONCILIATION_REQUIRED" | "UNCONFIRMED",
  actor: Pick<CurrentUser, "id"> | null,
  opts?: {
    zohoPurchaseReceiveId?: string | null;
    receivedQuantity?: number | null;
    receivedAt?: Date | null;
    zohoReceiveNumber?: string | null;
    verifiedAt?: Date | null;
    reconciledAt?: Date | null;
    reconciledBy?: string | null;
    doNotLiveReceive?: boolean;
    reconciliationNotes?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [bag] = await db
    .select({
      id: inventoryBags.id,
      receiveId: receives.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
    })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  if (!bag) return { ok: false, reason: "Bag not found." };

  if (status === "CONFIRMED_EXISTING") {
    const receiveId = opts?.zohoPurchaseReceiveId?.trim();
    if (!receiveId) {
      return {
        ok: false,
        reason:
          "CONFIRMED_EXISTING requires a verified Zoho purchase receive ID — do not guess.",
      };
    }
    const idCheck = validateZohoPurchaseReceiveIdCandidate(
      receiveId,
      bag.internalReceiptNumber,
    );
    if (!idCheck.ok) return idCheck;
  }

  const idempotencyKey = buildRawBagReceiveIdempotencyKey(inventoryBagId);
  const [existing] = await db
    .select({ id: zohoRawBagReceives.id })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId))
    .limit(1);

  const now = new Date();
  const patch = {
    reconciliationStatus: status,
    zohoPurchaseReceiveId: opts?.zohoPurchaseReceiveId?.trim() ?? null,
    zohoReceiveNumber: opts?.zohoReceiveNumber ?? null,
    zohoReceivedQuantity: opts?.receivedQuantity ?? null,
    zohoReceivedAt: opts?.receivedAt ?? null,
    verifiedAt: opts?.verifiedAt ?? null,
    reconciledAt: opts?.reconciledAt ?? null,
    reconciledBy: opts?.reconciledBy ?? null,
    reconciliationNote: opts?.reconciliationNotes ?? null,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(zohoRawBagReceives)
      .set(patch)
      .where(eq(zohoRawBagReceives.id, existing.id));
  } else {
    await db.insert(zohoRawBagReceives).values({
      inventoryBagId,
      receiveId: bag.receiveId,
      zohoReceiveIdempotencyKey: idempotencyKey,
      ...patch,
    });
  }

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: null,
    action: "zoho_raw_bag_receive.reconciliation_updated",
    targetType: "InventoryBag",
    targetId: inventoryBagId,
    after: {
      reconciliationStatus: status,
      zohoPurchaseReceiveId: patch.zohoPurchaseReceiveId,
      notes: opts?.reconciliationNotes ?? null,
      doNotLiveReceive: opts?.doNotLiveReceive ?? false,
    },
  });

  return { ok: true };
}
