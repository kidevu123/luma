// Reproject read_bag_metrics after SUBMISSION_CORRECTED lands.
// Only updates existing metrics rows — finalize-time insert is unchanged.

import { eq } from "drizzle-orm";
import {
  inventoryBags,
  products,
  readBagMetrics,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import type { db as Db } from "@/lib/db";
import { computeBagMetricsCountSnapshot } from "@/lib/projector/bag-metrics-snapshot";
import { refreshMaterialReconciliationForBag } from "@/lib/projector/material-reconciliation";
import { refreshSkuDailyForBag } from "@/lib/projector/sku-daily";
import { refreshStationDailyForBag } from "@/lib/projector/station-daily";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function reprojectBagMetricsForWorkflowBag(
  tx: Tx,
  workflowBagId: string,
): Promise<{ updated: boolean }> {
  const [existing] = await tx
    .select({ workflowBagId: readBagMetrics.workflowBagId })
    .from(readBagMetrics)
    .where(eq(readBagMetrics.workflowBagId, workflowBagId));
  if (!existing) return { updated: false };

  const [bag] = await tx
    .select({
      productId: workflowBags.productId,
      inventoryBagId: workflowBags.inventoryBagId,
    })
    .from(workflowBags)
    .where(eq(workflowBags.id, workflowBagId));
  if (!bag) return { updated: false };

  const events = await tx
    .select({
      id: workflowEvents.id,
      eventType: workflowEvents.eventType,
      occurredAt: workflowEvents.occurredAt,
      payload: workflowEvents.payload,
    })
    .from(workflowEvents)
    .where(eq(workflowEvents.workflowBagId, workflowBagId))
    .orderBy(workflowEvents.occurredAt);

  let product: { unitsPerDisplay: number | null; displaysPerCase: number | null } | null =
    null;
  if (bag.productId) {
    const [p] = await tx
      .select({
        unitsPerDisplay: products.unitsPerDisplay,
        displaysPerCase: products.displaysPerCase,
      })
      .from(products)
      .where(eq(products.id, bag.productId));
    product = p ?? null;
  }

  let inputPillCount: number | null = null;
  if (bag.inventoryBagId) {
    const [inv] = await tx
      .select({ pillCount: inventoryBags.pillCount })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, bag.inventoryBagId));
    inputPillCount = inv?.pillCount ?? null;
  }

  const snapshot = computeBagMetricsCountSnapshot({
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      occurredAt: e.occurredAt,
      payload: (e.payload ?? {}) as Record<string, unknown>,
    })),
    product,
    inputPillCount,
  });

  await tx
    .update(readBagMetrics)
    .set({
      masterCases: snapshot.masterCases,
      displaysMade: snapshot.displaysMade,
      looseCards: snapshot.looseCards,
      damagedPackaging: snapshot.damagedPackaging,
      rippedCards: snapshot.rippedCards,
      unitsYielded: snapshot.unitsYielded,
      yieldPct: snapshot.yieldPctText,
    })
    .where(eq(readBagMetrics.workflowBagId, workflowBagId));

  await refreshSkuDailyForBag(tx, workflowBagId);
  await refreshMaterialReconciliationForBag(tx, workflowBagId);
  await refreshStationDailyForBag(tx, workflowBagId);

  return { updated: true };
}
