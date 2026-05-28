/** SEALING-FLOW-CLARITY-2 / SEALING-MATERIAL-NONBLOCKING-1 — optional
 *  BLISTER_CARD consumption when hand-pack bags seal. Never blocks
 *  SEALING_COMPLETE; only product-BOM-matched lots may be decremented. */

import { eq, and, asc, sql, inArray, gt } from "drizzle-orm";
import { db as Db } from "@/lib/db";
import {
  packagingLots,
  packagingMaterials,
  workflowEvents,
  workflowBags,
  productPackagingSpecs,
} from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import type { resolveStationAccountability } from "@/lib/production/station-operator-session";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type DbOrTx = typeof Db | Tx;
type Accountability = Awaited<
  ReturnType<typeof resolveStationAccountability>
>;

export type HandpackBlisterMaterialSkipReason =
  | "no_product_id"
  | "no_bom_blister_card"
  | "no_available_lot";

export type HandpackBlisterLotLookupResult =
  | { status: "found"; lot: { id: string; qtyOnHand: number } }
  | { status: "skipped"; reason: HandpackBlisterMaterialSkipReason };

export async function workflowBagHasHandpackBlisterComplete(
  workflowBagId: string,
): Promise<boolean> {
  const [row] = await Db
    .select({ id: workflowEvents.id })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        sql`event_type = 'HANDPACK_BLISTER_COMPLETE'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Oldest AVAILABLE lot for a BLISTER_CARD on the bag's product BOM only. */
export async function lookupProductMatchedBlisterCardLot(
  workflowBagId: string,
  dbOrTx: DbOrTx = Db,
): Promise<HandpackBlisterLotLookupResult> {
  const [bag] = await dbOrTx
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, workflowBagId))
    .limit(1);

  if (!bag?.productId) {
    return { status: "skipped", reason: "no_product_id" };
  }

  const bomRows = await dbOrTx
    .select({
      packagingMaterialId: productPackagingSpecs.packagingMaterialId,
    })
    .from(productPackagingSpecs)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, productPackagingSpecs.packagingMaterialId),
    )
    .where(
      and(
        eq(productPackagingSpecs.productId, bag.productId),
        eq(packagingMaterials.kind, "BLISTER_CARD"),
        eq(packagingMaterials.category, "MATERIAL"),
      ),
    );

  const materialIds = bomRows.map((r) => r.packagingMaterialId);
  if (materialIds.length === 0) {
    return { status: "skipped", reason: "no_bom_blister_card" };
  }

  const [lot] = await dbOrTx
    .select({ id: packagingLots.id, qtyOnHand: packagingLots.qtyOnHand })
    .from(packagingLots)
    .where(
      and(
        eq(packagingLots.status, "AVAILABLE"),
        inArray(packagingLots.packagingMaterialId, materialIds),
        gt(packagingLots.qtyOnHand, 0),
      ),
    )
    .orderBy(asc(packagingLots.receivedAt))
    .limit(1);

  if (!lot) {
    return { status: "skipped", reason: "no_available_lot" };
  }

  return { status: "found", lot };
}

/** Emit PACKAGING_MATERIAL_ISSUED and decrement lot for hand-pack seal path. */
export async function issueHandpackBlisterCardMaterial(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    sealedCardCount: number;
    blisterLot: { id: string; qtyOnHand: number };
    accountability: Accountability;
  },
): Promise<void> {
  const consume = Math.min(args.sealedCardCount, args.blisterLot.qtyOnHand);
  if (consume <= 0) return;

  await projectEvent(tx, {
    eventType: "PACKAGING_MATERIAL_ISSUED",
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    payload: {
      packaging_lot_id: args.blisterLot.id,
      qty_issued: consume,
      reason: "handpack_seal",
    },
    enteredByUserId: args.accountability.enteredByUserId,
    accountableEmployeeId: args.accountability.accountableEmployeeId,
    accountabilitySource: args.accountability.accountabilitySource,
    accountableEmployeeNameSnapshot:
      args.accountability.accountableEmployeeNameSnapshot,
  });

  await tx
    .update(packagingLots)
    .set({ qtyOnHand: sql`qty_on_hand - ${consume}` })
    .where(eq(packagingLots.id, args.blisterLot.id));
}
