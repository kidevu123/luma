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
  buildBagFinishReceiveIdempotencyKey,
} from "@/lib/zoho/source-receipt-evidence";
import { previewBagFinishReceive, commitBagFinishReceive } from "@/lib/zoho/bag-finish-receive";
import { validateZohoPurchaseReceiveIdCandidate } from "@/lib/zoho/receipt-id-validation";
import { verifyHistoricalZohoPurchaseReceive } from "@/lib/zoho/purchase-receive-verification";

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

export async function previewRawBagIntakeReceive(
  inventoryBagId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; httpStatus: number; body: unknown }
  | { ok: false; reason: string }
> {
  return previewBagFinishReceive(inventoryBagId, actor);
}

export async function commitRawBagIntakeReceive(
  inventoryBagId: string,
  actor: Pick<CurrentUser, "id"> | null,
): Promise<
  | { ok: true; zohoPurchaseReceiveId: string }
  | { ok: false; reason: string }
> {
  return commitBagFinishReceive(inventoryBagId, actor);
}

export async function verifyRawBagHistoricalZohoReceive(
  inventoryBagId: string,
  candidateZohoPurchaseReceiveId: string,
) {
  const ctx = await loadRawBagReceiveContext(inventoryBagId);
  if (!ctx.ok) return ctx;

  return verifyHistoricalZohoPurchaseReceive({
    candidateZohoPurchaseReceiveId,
    internalReceiptNumber: ctx.buildInput.internalReceiptNumber,
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

/** Persist PENDING rows for new Path B bags — never called for legacy backfill.
 *
 * ZOHO-STAGING-BUFFER-v1.1.0: after inserting the row, we freeze the
 * gateway payload (with accounting notes) into commit_request_payload
 * and stamp auto_commit_eligible_at if auto-commit is enabled. From
 * that moment the row is fully buffered — manual and auto commit will
 * both replay the frozen payload verbatim. */
export async function seedPendingRawBagReceiveRows(
  seeds: readonly PendingRawBagReceiveSeed[],
  actor: Pick<CurrentUser, "id" | "role"> | null,
  options?: { now?: Date; env?: Record<string, string | undefined> },
): Promise<void> {
  if (seeds.length === 0) return;
  const now = options?.now ?? new Date();

  // Import lazily to avoid a circular-import path through the schema
  // when this module is required at boot.
  const { freezeRawBagReceivePayloadAtSeed } = await import(
    "@/lib/zoho/freeze-raw-bag-receive-payload"
  );

  for (const seed of seeds) {
    const idempotencyKey = buildBagFinishReceiveIdempotencyKey(seed.inventoryBagId);
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

    // Freeze the gateway payload (with accounting notes) and stamp
    // auto_commit_eligible_at right after insert. The freeze writes
    // its own audit row so the timeline shows the two steps in order.
    await freezeRawBagReceivePayloadAtSeed(inserted!.id, actor, {
      now,
      ...(options?.env ? { env: options.env } : {}),
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

  const idempotencyKey = buildBagFinishReceiveIdempotencyKey(inventoryBagId);
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
