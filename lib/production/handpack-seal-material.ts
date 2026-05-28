/** SEALING-FLOW-CLARITY-2 — BLISTER_CARD consumption when hand-pack bags seal. */

import { eq, and, asc, sql } from "drizzle-orm";
import { db as Db } from "@/lib/db";
import {
  packagingLots,
  packagingMaterials,
  workflowEvents,
} from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import type { resolveStationAccountability } from "@/lib/production/station-operator-session";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type Accountability = Awaited<
  ReturnType<typeof resolveStationAccountability>
>;

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

export async function findOldestAvailableBlisterCardLot() {
  const [lot] = await Db
    .select({ id: packagingLots.id, qtyOnHand: packagingLots.qtyOnHand })
    .from(packagingLots)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, packagingLots.packagingMaterialId),
    )
    .where(
      and(
        eq(packagingLots.status, "AVAILABLE"),
        eq(packagingMaterials.kind, "BLISTER_CARD"),
        eq(packagingMaterials.category, "MATERIAL"),
      ),
    )
    .orderBy(asc(packagingLots.receivedAt))
    .limit(1);
  return lot ?? null;
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
