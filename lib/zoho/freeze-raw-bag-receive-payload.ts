// ZOHO-STAGING-BUFFER-v1.1.0 — freeze the raw-bag receive payload at
// seed/preview time so the staging buffer represents EXACTLY what
// will commit. Manual + auto commit both replay this frozen payload
// verbatim. If the operator edits the bag, this helper is called
// again to regenerate the payload + idempotency key + reset
// auto_commit_eligible_at.
//
// The freeze is the whole point of the 24h buffer: an operator
// reviewing today's stage at 9am must see THE SAME payload that
// commits at 9am tomorrow. If the underlying bag changes silently in
// between, the buffer loses its purpose. So:
//
//   1. seedPendingRawBagReceiveRows builds the payload + notes here
//      and writes them to zoho_raw_bag_receives.commit_request_payload.
//   2. The edit handler calls regenerateFrozenRawBagReceivePayload
//      (Phase F wires the trigger).
//   3. The commit fn reads the frozen payload first, only falling
//      back to rebuild for legacy rows that pre-date this Phase E.
//
// The frozen payload is the canonical BagFinishReceiveRequest shape
// plus a `notes` field. The notes ride along inside the gateway
// payload so Zoho's accounting view sees them on the receive row.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  poLines,
  purchaseOrders,
  receives,
  smallBoxes,
  tabletTypes,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import type { BagFinishReceiveRequest } from "@/lib/zoho/bag-finish-receive-client";
import {
  buildRawBagCommitIdempotencyKey,
  type CommitSource,
} from "@/lib/zoho/shared-raw-bag-receive-commit";
import { buildRawBagReceiveNotes } from "@/lib/zoho/zoho-commit-notes";
import {
  deriveAutoCommitEligibleAt,
  resolveZohoAutoCommitBufferConfig,
} from "@/lib/zoho/zoho-auto-commit-buffer-config";
import type { CurrentUser } from "@/lib/auth";

export type FrozenRawBagReceivePayload = BagFinishReceiveRequest & {
  notes: string;
};

/** Load every piece of bag context this op needs in a single round
 *  trip. Returns null when the op or bag has been deleted between
 *  intake and freeze (shouldn't happen, but defends the freeze). */
async function loadFreezeContext(opId: string) {
  const [row] = await db
    .select({
      opId: zohoRawBagReceives.id,
      lumaOperationId: zohoRawBagReceives.zohoReceiveIdempotencyKey,
      receivedQuantity: zohoRawBagReceives.zohoReceivedQuantity,
      // Bag fields
      inventoryBagId: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      vendorBarcode: inventoryBags.vendorBarcode,
      // Box fields
      boxNumber: smallBoxes.boxNumber,
      // Receive fields
      lumaReceiveId: receives.id,
      receiveName: receives.receiveName,
      receivedAt: receives.receivedAt,
      // PO fields
      zohoPoId: purchaseOrders.zohoPoId,
      poNumber: purchaseOrders.poNumber,
      zohoLineItemId: poLines.zohoLineItemId,
      poLineNotes: poLines.notes,
      // Tablet type
      tabletName: tabletTypes.name,
      tabletZohoItemId: tabletTypes.zohoItemId,
    })
    .from(zohoRawBagReceives)
    .innerJoin(inventoryBags, eq(inventoryBags.id, zohoRawBagReceives.inventoryBagId))
    .innerJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .innerJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .leftJoin(poLines, eq(poLines.id, receives.poLineId))
    .innerJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .where(eq(zohoRawBagReceives.id, opId))
    .limit(1);

  return row ?? null;
}

export type FreezeRawBagReceivePayloadResult =
  | {
      ok: true;
      opId: string;
      frozenPayload: FrozenRawBagReceivePayload;
      commitIdempotencyKey: string;
      autoCommitEligibleAt: Date | null;
    }
  | { ok: false; opId: string; reason: string };

/** Build the frozen payload (with notes) from current DB truth and
 *  write it to zoho_raw_bag_receives. Called once at seed time, and
 *  again whenever the operator edits the bag and we need to
 *  regenerate. */
async function freezeRawBagReceivePayloadInternal(
  opId: string,
  source: CommitSource,
  actor: Pick<CurrentUser, "id" | "role"> | null,
  options: { now: Date; env: Record<string, string | undefined> },
): Promise<FreezeRawBagReceivePayloadResult> {
  const ctx = await loadFreezeContext(opId);
  if (!ctx) return { ok: false, opId, reason: "Op or bag not found." };

  if (!ctx.zohoPoId || !ctx.zohoLineItemId || !ctx.tabletZohoItemId) {
    // The freeze CAN happen without full Zoho IDs (the payload-builder
    // tolerates missing fields), but committing would fail downstream
    // with NEEDS_MAPPING anyway. We still write the frozen payload so
    // the queue UI shows what WOULD be sent.
  }

  const receiveDate = ctx.receivedAt
    ? ctx.receivedAt.toISOString().slice(0, 10)
    : options.now.toISOString().slice(0, 10);
  const receivedQuantity = ctx.receivedQuantity ?? 0;

  // Idempotency key is derived from (opId + payload-defining fields).
  // Editing the bag → different inputs → different key → gateway sees
  // a fresh operation. That's intentional: the buffer's reset on
  // edit is the contract the operator was promised.
  const commitIdempotencyKey = buildRawBagCommitIdempotencyKey({
    opId,
    zohoPoId: ctx.zohoPoId ?? "",
    zohoLineItemId: ctx.zohoLineItemId ?? "",
    receivedQuantity,
    receiveDate,
  });

  const notes = buildRawBagReceiveNotes({
    lumaOperationId: opId,
    lumaReceiveId: ctx.lumaReceiveId,
    poNumber: ctx.poNumber,
    poLineReference: ctx.poLineNotes,
    receiptNumber: ctx.receiveName,
    // small_boxes.box_number is an integer column; coerce to string
    // for the notes helper (which expects string-or-null).
    boxNumber: ctx.boxNumber != null ? String(ctx.boxNumber) : null,
    bagNumber: ctx.bagNumber,
    internalReceiptNumber: ctx.internalReceiptNumber,
    bagQrCode: ctx.bagQrCode,
    tabletType: ctx.tabletName,
    // inventory_bags carries vendorBarcode, not a separate supplier
    // lot column today — the helper has both slots so older schemas
    // (and the future "true supplier lot" column when it lands) can
    // populate them independently.
    vendorBarcode: ctx.vendorBarcode,
    receivedQuantity,
    receiveDate,
    source,
  });

  const frozenPayload: FrozenRawBagReceivePayload = {
    source_bag_id: ctx.inventoryBagId,
    internal_receipt_number: ctx.internalReceiptNumber,
    purchaseorder_id: ctx.zohoPoId ?? "",
    purchaseorder_line_item_id: ctx.zohoLineItemId ?? "",
    raw_item_id: ctx.tabletZohoItemId ?? "",
    human_lot_number: null,
    received_quantity: receivedQuantity,
    receive_date: receiveDate,
    idempotency_key: commitIdempotencyKey,
    notes,
  };

  const autoCommitEligibleAt = deriveAutoCommitEligibleAt(
    options.now,
    resolveZohoAutoCommitBufferConfig(options.env),
  );

  await db
    .update(zohoRawBagReceives)
    .set({
      commitRequestPayload: frozenPayload,
      commitIdempotencyKey,
      autoCommitEligibleAt,
      // Editing resets the buffer AND clears any prior NEEDS_MAPPING /
      // NEEDS_REVIEW / FAILED state because the operator has changed
      // the payload. The new payload deserves a fresh shot.
      mappingBlockers: null,
      commitError: null,
      updatedAt: options.now,
    })
    .where(eq(zohoRawBagReceives.id, opId));

  await writeAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "zoho_raw_bag_receive.payload_frozen",
    targetType: "ZohoRawBagReceive",
    targetId: opId,
    after: {
      commitIdempotencyKey,
      autoCommitEligibleAt: autoCommitEligibleAt?.toISOString() ?? null,
      receivedQuantity,
      receiveDate,
      source,
    },
  });

  void ctx.lumaOperationId; // (kept selected for future op-id usage)
  return {
    ok: true,
    opId,
    frozenPayload,
    commitIdempotencyKey,
    autoCommitEligibleAt,
  };
}

/** Initial freeze, called at seed time. */
export async function freezeRawBagReceivePayloadAtSeed(
  opId: string,
  actor: Pick<CurrentUser, "id" | "role"> | null,
  options?: { now?: Date; env?: Record<string, string | undefined> },
): Promise<FreezeRawBagReceivePayloadResult> {
  return freezeRawBagReceivePayloadInternal(opId, "auto", actor, {
    now: options?.now ?? new Date(),
    env: options?.env ?? process.env,
  });
}

/** Regenerate after an operator edit. Same logic, just a different
 *  audit-log action name so the timeline shows the regeneration. */
export async function regenerateFrozenRawBagReceivePayload(
  opId: string,
  actor: Pick<CurrentUser, "id" | "role"> | null,
  options?: { now?: Date; env?: Record<string, string | undefined> },
): Promise<FreezeRawBagReceivePayloadResult> {
  return freezeRawBagReceivePayloadInternal(opId, "auto", actor, {
    now: options?.now ?? new Date(),
    env: options?.env ?? process.env,
  });
}
