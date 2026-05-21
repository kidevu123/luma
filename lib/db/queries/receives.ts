import { eq, desc, and, sql, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  receives,
  shipments,
  smallBoxes,
  inventoryBags,
  purchaseOrders,
  tabletTypes,
  batches,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";
import {
  buildInternalReceiptNumber,
  buildRawBagQrPayload,
} from "@/lib/production/recall-passport";
import { randomUUID } from "node:crypto";

export async function listReceives() {
  return db
    .select({
      receive: receives,
      poNumber: purchaseOrders.poNumber,
      vendor: purchaseOrders.vendorName,
      bagCount: sql<number>`(
        SELECT COUNT(*)::int FROM inventory_bags ib
        JOIN small_boxes sb ON sb.id = ib.small_box_id
        WHERE sb.receive_id = ${receives.id}
      )`,
    })
    .from(receives)
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .orderBy(desc(receives.receivedAt));
}

export async function getReceive(id: string) {
  const [row] = await db
    .select({
      receive: receives,
      po: purchaseOrders,
      shipment: shipments,
    })
    .from(receives)
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .leftJoin(shipments, eq(receives.shipmentId, shipments.id))
    .where(eq(receives.id, id));
  if (!row) return null;
  const boxes = await db
    .select({
      box: smallBoxes,
      tabletName: tabletTypes.name,
    })
    .from(smallBoxes)
    .leftJoin(tabletTypes, eq(smallBoxes.defaultTabletTypeId, tabletTypes.id))
    .where(eq(smallBoxes.receiveId, id))
    .orderBy(asc(smallBoxes.boxNumber));
  const bagsByBox = await db
    .select()
    .from(inventoryBags)
    .where(
      sql`${inventoryBags.smallBoxId} IN (
        SELECT id FROM small_boxes WHERE receive_id = ${id}
      )`,
    )
    .orderBy(asc(inventoryBags.bagNumber));
  return { ...row, boxes, bags: bagsByBox };
}

/** Single-shot intake. Wraps the entire receive flow in one txn:
 *   - Optionally create PO if no existing one (skipped here; pick from list).
 *   - Create or pick shipment.
 *   - Create receive.
 *   - For each box spec: insert batch (if batch_number is new), insert
 *     small_box, insert N inventory_bags, all linked.
 *   - Audit each insert. */
export async function createReceiveWithBoxes(
  args: {
    poId?: string | null;
    shipmentId?: string | null;
    receiveName: string;
    notes?: string | null;
    boxes: {
      boxNumber: number;
      tabletTypeId: string;
      batchNumber: string;
      vendorLotNumber?: string | null;
      manufacturedAt?: string | null;
      expiryDate?: string | null;
      bagCount: number;
      pillCountPerBag?: number | null;
    }[];
  },
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [receive] = await tx
      .insert(receives)
      .values(
        compact({
          poId: args.poId ?? null,
          shipmentId: args.shipmentId ?? null,
          receiveName: args.receiveName,
          receivedById: actor.id,
          notes: args.notes ?? null,
        }),
      )
      .returning();
    if (!receive) throw new Error("createReceive: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "receive.create",
        targetType: "Receive",
        targetId: receive.id,
        after: receive,
      },
      tx,
    );

    let totalBags = 0;
    for (const b of args.boxes) {
      // Upsert batch by (TABLET, batchNumber). If exists, reuse it; else insert.
      const [existing] = await tx
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.kind, "TABLET"),
            eq(batches.batchNumber, b.batchNumber),
            eq(batches.tabletTypeId, b.tabletTypeId),
          ),
        );
      let batchId: string;
      if (existing) {
        batchId = existing.id;
        // Keep qty in sync — top up qty_received + qty_on_hand.
        await tx
          .update(batches)
          .set({
            qtyReceived: existing.qtyReceived + b.bagCount * (b.pillCountPerBag ?? 0),
            qtyOnHand: existing.qtyOnHand + b.bagCount * (b.pillCountPerBag ?? 0),
          })
          .where(eq(batches.id, batchId));
      } else {
        const [batch] = await tx
          .insert(batches)
          .values(
            compact({
              kind: "TABLET" as const,
              batchNumber: b.batchNumber,
              tabletTypeId: b.tabletTypeId,
              vendorLotNumber: b.vendorLotNumber ?? null,
              manufacturedAt: b.manufacturedAt ?? null,
              expiryDate: b.expiryDate ?? null,
              qtyReceived: b.bagCount * (b.pillCountPerBag ?? 0),
              qtyOnHand: b.bagCount * (b.pillCountPerBag ?? 0),
              status: "QUARANTINE" as const,
              statusChangedById: actor.id,
            }),
          )
          .returning();
        if (!batch) throw new Error("createBatch: insert empty");
        batchId = batch.id;
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "batch.create",
            targetType: "Batch",
            targetId: batch.id,
            after: batch,
          },
          tx,
        );
      }

      const [box] = await tx
        .insert(smallBoxes)
        .values({
          receiveId: receive.id,
          boxNumber: b.boxNumber,
          defaultBatchId: batchId,
          defaultTabletTypeId: b.tabletTypeId,
          totalBags: b.bagCount,
        })
        .returning();
      if (!box) throw new Error("smallBox: insert empty");

      // LOT-1D — stamp raw-bag identity on every newly-issued bag.
      // bag_qr_code = BAG-<uuid> is computed from a pre-allocated id
      // so a single batched INSERT carries every field. internal
      // receipt number = <receive_name>-B<box>-<bag>.
      const bagRows = Array.from({ length: b.bagCount }, (_, i) => {
        const id = randomUUID();
        const bagNumber = i + 1;
        const internalReceiptNumber = buildInternalReceiptNumber({
          receiveName: receive.receiveName,
          boxNumber: b.boxNumber,
          bagNumber,
        });
        const bagQrCode = buildRawBagQrPayload({
          inventoryBagId: id,
          internalReceiptNumber: internalReceiptNumber ?? `RECV-${id}`,
          bagSequence: bagNumber,
        });
        return {
          id,
          smallBoxId: box.id,
          bagNumber,
          tabletTypeId: b.tabletTypeId,
          batchId,
          pillCount: b.pillCountPerBag ?? null,
          declaredPillCount: b.pillCountPerBag ?? null,
          bagQrCode,
          internalReceiptNumber,
          status: "AVAILABLE" as const,
        };
      });
      if (bagRows.length > 0) {
        await tx.insert(inventoryBags).values(bagRows);
        totalBags += bagRows.length;
      }
    }

    return { receive, totalBags };
  });
}
