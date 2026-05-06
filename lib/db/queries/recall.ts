// Recall lookup. Given a batch number (vendor lot or internal),
// returns every finished lot that consumed it. The genealogy stored
// on finished_lot_inputs makes this a single join.

import { eq, ilike, or, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  finishedLotInputs,
  finishedLots,
  products,
  tabletTypes,
} from "@/lib/db/schema";

export async function lookupByBatchSearch(query: string) {
  const q = query.trim();
  if (!q) return [];
  const matchedBatches = await db
    .select({
      id: batches.id,
      kind: batches.kind,
      batchNumber: batches.batchNumber,
      vendorLotNumber: batches.vendorLotNumber,
      tabletName: tabletTypes.name,
      status: batches.status,
      qtyOnHand: batches.qtyOnHand,
    })
    .from(batches)
    .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
    .where(
      or(
        ilike(batches.batchNumber, `%${q}%`),
        ilike(batches.vendorLotNumber, `%${q}%`),
      ),
    )
    .orderBy(desc(batches.createdAt))
    .limit(20);

  if (matchedBatches.length === 0) return [];

  const batchIds = matchedBatches.map((b) => b.id);
  // For each matched batch, list every finished lot that pulled from
  // it and the qty consumed. Drizzle has no `inArray` helper imported
  // here; use sql for the IN-list.
  const inputs = await db
    .select({
      input: finishedLotInputs,
      lot: finishedLots,
      product: products,
    })
    .from(finishedLotInputs)
    .innerJoin(finishedLots, eq(finishedLotInputs.finishedLotId, finishedLots.id))
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(
      or(
        ...batchIds.map((id) => eq(finishedLotInputs.batchId, id)),
      ),
    )
    .orderBy(desc(finishedLots.producedOn));

  // Group lots under each matched batch.
  const lotsByBatch = new Map<string, typeof inputs>();
  for (const row of inputs) {
    const list = lotsByBatch.get(row.input.batchId) ?? [];
    list.push(row);
    lotsByBatch.set(row.input.batchId, list);
  }
  return matchedBatches.map((b) => ({
    batch: b,
    lots: lotsByBatch.get(b.id) ?? [],
  }));
}
