// P2-QUEUE-1 — read_bag_queue maintenance. The ONLY writer of the
// table. Decision logic is pure (lib/production/engine/queue-transitions);
// this module fetches the inputs and applies the mutation.

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  inventoryBags,
  products,
  purchaseOrders,
  qrCards,
  readBagQueue,
  receives,
  smallBoxes,
  stations,
  tabletTypes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { deriveQueueTransition } from "@/lib/production/engine/queue-transitions";
import { legacyProductKindToRoute } from "@/lib/production/routes";
import { buildCurrentBagDisplayLabel } from "@/lib/production/current-bag-display-label";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Bottle-ish station kinds imply the BOTTLE route when the bag has no
 *  product yet (handpack picks the product later in some flows). */
const BOTTLE_STATION_KINDS = new Set([
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
]);

/** Only these event types can move a queue row. deriveQueueTransition
 *  re-checks; this just avoids the queries for the common case. */
const FLOW_EVENTS = new Set([
  "CARD_ASSIGNED", "BAG_CLAIMED", "BAG_PICKED_UP", "BAG_RELEASED",
  "BAG_FINALIZED", "BLISTER_COMPLETE", "HANDPACK_BLISTER_COMPLETE",
  "SEALING_COMPLETE", "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE", "BOTTLE_STICKER_COMPLETE",
]);

export function resolveRouteCodeForQueue(args: {
  productKind: string | null;
  stationKind: string | null;
}): string | null {
  const fromProduct = legacyProductKindToRoute(args.productKind);
  if (fromProduct) return fromProduct;
  if (args.stationKind && BOTTLE_STATION_KINDS.has(args.stationKind)) return "BOTTLE";
  if (args.stationKind) return "CARD_BLISTER";
  return null;
}

export async function applyBagQueueTransition(
  tx: Tx,
  ev: {
    workflowBagId: string;
    stationId?: string | null;
    eventType: string;
  },
  occurredAt: Date,
): Promise<void> {
  // Cheap pre-filter: only flow events matter. deriveQueueTransition
  // re-checks; this just avoids the queries for the common case.
  if (!FLOW_EVENTS.has(ev.eventType)) return;

  const stationKind = ev.stationId
    ? (
        await tx
          .select({ kind: stations.kind })
          .from(stations)
          .where(eq(stations.id, ev.stationId))
      )[0]?.kind ?? null
    : null;

  const [bagRow] = await tx
    .select({
      productId: workflowBags.productId,
      productKind: products.kind,
      productName: products.name,
      bagNumber: workflowBags.bagNumber,
      cardLabel: qrCards.label,
      inventoryBagNumber: inventoryBags.bagNumber,
      tabletTypeName: tabletTypes.name,
      poNumber: purchaseOrders.poNumber,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .where(eq(workflowBags.id, ev.workflowBagId));
  if (!bagRow) return;

  // Bounded to events at or before THIS event so replay sees exactly
  // what live saw: during rebuild the table is already fully populated,
  // and an unbounded query would leak future events into past
  // decisions, silently diverging replay from live. (Same-timestamp
  // siblings are included either way — a legacy-import tie; the replay
  // ordering below makes that deterministic even if not historical.)
  const priorEventTypes = (
    await tx
      .select({ eventType: workflowEvents.eventType })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.workflowBagId, ev.workflowBagId),
          lte(workflowEvents.occurredAt, occurredAt),
        ),
      )
  ).map((r) => r.eventType);

  // The existing row is an input to the decision — the stale-echo guard
  // (overlap scanning) needs to know how far downstream the bag already is.
  const [currentRow] = await tx
    .select({
      queueStageKey: readBagQueue.queueStageKey,
      claimedByStationId: readBagQueue.claimedByStationId,
    })
    .from(readBagQueue)
    .where(eq(readBagQueue.workflowBagId, ev.workflowBagId));

  const transition = deriveQueueTransition({
    eventType: ev.eventType,
    stationId: ev.stationId ?? null,
    stationKind,
    routeCode: resolveRouteCodeForQueue({
      productKind: bagRow.productKind ?? null,
      stationKind,
    }),
    priorEventTypes,
    currentRow: currentRow ?? null,
  });

  if (transition.kind === "NONE") return;
  if (transition.kind === "REMOVE") {
    await tx.delete(readBagQueue).where(eq(readBagQueue.workflowBagId, ev.workflowBagId));
    return;
  }
  if (transition.kind === "UNCLAIM") {
    await tx
      .update(readBagQueue)
      .set({ claimedByStationId: null, updatedAt: occurredAt })
      .where(eq(readBagQueue.workflowBagId, ev.workflowBagId));
    return;
  }

  const label = buildCurrentBagDisplayLabel({
    cardLabel: bagRow.cardLabel ?? null,
    poNumber: bagRow.poNumber ?? null,
    tabletTypeName: bagRow.tabletTypeName ?? null,
    productName: bagRow.productName ?? null,
    inventoryBagNumber: bagRow.inventoryBagNumber ?? null,
    workflowBagNumber: bagRow.bagNumber ?? null,
  });

  const common = {
    queueStageKey: transition.destination.queueStageKey,
    eligibleStationKinds: transition.destination.eligibleStationKinds,
    productId: bagRow.productId ?? null,
    productName: bagRow.productName ?? null,
    bagLabel: label.primary,
    updatedAt: occurredAt,
  };

  if (transition.kind === "WORKING") {
    await tx
      .insert(readBagQueue)
      .values({
        workflowBagId: ev.workflowBagId,
        ...common,
        readyState: "UPSTREAM_RUNNING",
        claimedByStationId: transition.claimedByStationId,
        readyAt: null,
        upstreamStartedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: readBagQueue.workflowBagId,
        set: {
          ...common,
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: transition.claimedByStationId,
          readyAt: null,
          upstreamStartedAt: occurredAt,
        },
      });
    return;
  }

  // READY
  await tx
    .insert(readBagQueue)
    .values({
      workflowBagId: ev.workflowBagId,
      ...common,
      readyState: "READY",
      claimedByStationId: null,
      readyAt: occurredAt,
      upstreamStartedAt: null,
    })
    .onConflictDoUpdate({
      target: readBagQueue.workflowBagId,
      set: {
        ...common,
        readyState: "READY",
        readyAt: occurredAt,
        // Completion does not unclaim — release does. Keep claimed_by.
        // Keep upstream_started_at for cycle-time math.
      },
    });
}

/** Full rebuild: wipe, then replay the workflow_events of every
 *  IN-FLIGHT bag in order through the same transition logic. Secondary
 *  sort on id: occurred_at ties exist in legacy imports and queue
 *  transitions are order-sensitive, so replay must at least be
 *  deterministic across runs.
 *
 *  Scoped to workflow_bags.finalized_at IS NULL. This is equivalent to
 *  replaying everything, not an approximation: a finalized bag's replay
 *  ends in BAG_FINALIZED, whose transition is REMOVE, so its row is
 *  deleted again before the rebuild returns — replaying it costs a
 *  per-event round trip to produce nothing. Void-repaired bags have
 *  finalized_at nulled by the repair, so they are correctly INCLUDED
 *  and re-queued. Every year of finished history used to be replayed
 *  row by row here; the filter keeps the runtime proportional to work
 *  actually on the floor. */
export async function rebuildBagQueue(tx: Tx): Promise<{ rows: number }> {
  await tx.execute(sql`DELETE FROM read_bag_queue;`);
  const events = await tx
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      stationId: workflowEvents.stationId,
      eventType: workflowEvents.eventType,
      occurredAt: workflowEvents.occurredAt,
    })
    .from(workflowEvents)
    .innerJoin(workflowBags, eq(workflowBags.id, workflowEvents.workflowBagId))
    .where(isNull(workflowBags.finalizedAt))
    .orderBy(workflowEvents.occurredAt, workflowEvents.id);
  for (const ev of events) {
    await applyBagQueueTransition(tx, ev, ev.occurredAt);
  }
  const [count] = (await tx.execute(
    sql`SELECT count(*)::int AS n FROM read_bag_queue;`,
  )) as unknown as { n: number }[];
  return { rows: count?.n ?? 0 };
}
