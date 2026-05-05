import { eq, desc, asc, and, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  finishedLotInputs,
  products,
  batches,
  tabletTypes,
  workflowBags,
  workflowEvents,
  inventoryBags,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

export async function listFinishedLots() {
  return db
    .select({
      lot: finishedLots,
      productName: products.name,
      productSku: products.sku,
      inputCount: sql<number>`(
        SELECT COUNT(*)::int FROM finished_lot_inputs
        WHERE finished_lot_id = ${finishedLots.id}
      )`,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .orderBy(desc(finishedLots.producedOn), desc(finishedLots.createdAt));
}

export async function getFinishedLot(id: string) {
  const [row] = await db
    .select({
      lot: finishedLots,
      product: products,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, id));
  if (!row) return null;
  const inputs = await db
    .select({
      input: finishedLotInputs,
      batch: batches,
      tabletName: tabletTypes.name,
    })
    .from(finishedLotInputs)
    .innerJoin(batches, eq(finishedLotInputs.batchId, batches.id))
    .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
    .where(eq(finishedLotInputs.finishedLotId, id))
    .orderBy(asc(batches.kind), asc(batches.batchNumber));
  return { ...row, inputs };
}

/** Bags that are FINALIZED but not yet attached to a finished lot.
 *  These are what an operator picks from when issuing a new lot. */
export async function listFinalizedBagsWithoutLot() {
  return db
    .select({
      bag: workflowBags,
      product: products,
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .where(and(sql`${workflowBags.finalizedAt} IS NOT NULL`, isNull(finishedLots.id)))
    .orderBy(desc(workflowBags.finalizedAt));
}

export type CreateFinishedLotInput = {
  productId: string;
  workflowBagId?: string | null;
  finishedLotNumber: string;
  producedOn: string;
  expiryDate: string;
  unitsProduced: number;
  displaysProduced?: number | null;
  casesProduced?: number | null;
  notes?: string | null;
  /** Explicit batch inputs (id + qty). When omitted, the create flow
   *  derives them from inventory_bags consumed by the workflow_bag. */
  inputs?: { batchId: string; qtyConsumed: number }[];
};

/** Create a finished lot transactionally: insert the lot row, copy
 *  inputs (explicit OR derived from inventory_bags linked to the
 *  workflow_bag's consumption events), and write audit. */
export async function createFinishedLot(
  input: CreateFinishedLotInput,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [lot] = await tx
      .insert(finishedLots)
      .values({
        productId: input.productId,
        workflowBagId: input.workflowBagId ?? null,
        finishedLotNumber: input.finishedLotNumber,
        producedOn: input.producedOn,
        expiryDate: input.expiryDate,
        unitsProduced: input.unitsProduced,
        displaysProduced: input.displaysProduced ?? null,
        casesProduced: input.casesProduced ?? null,
        notes: input.notes ?? null,
        status: "PENDING_QC",
      })
      .returning();
    if (!lot) throw new Error("createFinishedLot: insert empty");

    // Resolve inputs. If explicit, use them. Otherwise infer from
    // inventory_bags pointed at by the workflow_bag's events.
    let inputRows: { batchId: string; qtyConsumed: number; eventId?: string | null }[] = [];
    if (input.inputs && input.inputs.length > 0) {
      inputRows = input.inputs.map((i) => ({ ...i, eventId: null }));
    } else if (input.workflowBagId) {
      // Derive from the workflow_bag's inventory_bag pointer. (Bottle
      // workflows that pull from multiple sources will need explicit
      // inputs — that path is in the create form.) We capture the
      // first BAG_FINALIZED event id so the genealogy points back at
      // the consumption record.
      const [bagRow] = await tx
        .select({
          inventoryBagId: workflowBags.inventoryBagId,
        })
        .from(workflowBags)
        .where(eq(workflowBags.id, input.workflowBagId));
      if (bagRow?.inventoryBagId) {
        const [invBag] = await tx
          .select({
            batchId: inventoryBags.batchId,
            pillCount: inventoryBags.pillCount,
          })
          .from(inventoryBags)
          .where(eq(inventoryBags.id, bagRow.inventoryBagId));
        const [finalizedEv] = await tx
          .select({ id: workflowEvents.id })
          .from(workflowEvents)
          .where(
            and(
              eq(workflowEvents.workflowBagId, input.workflowBagId),
              eq(workflowEvents.eventType, "BAG_FINALIZED"),
            ),
          );
        if (invBag?.batchId) {
          inputRows.push({
            batchId: invBag.batchId,
            qtyConsumed: invBag.pillCount ?? 0,
            eventId: finalizedEv?.id ?? null,
          });
        }
      }
    }

    if (inputRows.length > 0) {
      await tx.insert(finishedLotInputs).values(
        inputRows.map((r) => ({
          finishedLotId: lot.id,
          batchId: r.batchId,
          qtyConsumed: r.qtyConsumed,
          derivedFromEventId: r.eventId ?? null,
        })),
      );
    }

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "finished_lot.create",
        targetType: "FinishedLot",
        targetId: lot.id,
        after: { ...lot, inputs: inputRows },
      },
      tx,
    );
    return { lot, inputs: inputRows };
  });
}

export type FinishedLotStatus =
  | "PENDING_QC"
  | "RELEASED"
  | "ON_HOLD"
  | "SHIPPED"
  | "RECALLED";

export async function setFinishedLotStatus(
  id: string,
  next: FinishedLotStatus,
  actor: CurrentUser,
  reason?: string,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(finishedLots).where(eq(finishedLots.id, id));
    if (!before) throw new Error("setFinishedLotStatus: not found");
    const [row] = await tx
      .update(finishedLots)
      .set({ status: next })
      .where(eq(finishedLots.id, id))
      .returning();
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "finished_lot.status",
        targetType: "FinishedLot",
        targetId: id,
        before,
        after: { ...row, transitionReason: reason ?? null },
      },
      tx,
    );
    return row;
  });
}
