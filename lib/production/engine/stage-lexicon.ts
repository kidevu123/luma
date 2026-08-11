// Bridge between the two stage vocabularies in Luma.
//
//   read_bag_state.stage   — STARTED | BLISTERED | SEALED | PACKAGED | FINALIZED
//                            (written by STAGE_FOR_EVENT, lib/projector/index.ts)
//   route_operations.stage_key
//                          — *_QUEUE / *_STAGING keys seeded by
//                            drizzle/0013_route_operation_compat.sql
//
// Nothing else in the codebase translates between them. Every engine
// module that needs to cross the boundary goes through here so the
// mapping lives in exactly one place.

/** Bag stage → the queue a bag at that stage is waiting in, per route. */
const QUEUE_FOR_BAG_STAGE: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  CARD_BLISTER: {
    STARTED: "BLISTER_QUEUE",
    BLISTERED: "SEALING_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
  BOTTLE: {
    STARTED: "BOTTLE_FILL_QUEUE",
    // BOTTLE-ORDER-FLEX-1: cap-seal and sticker run in either order.
    // A filled bag is eligible for whichever finishing station is free;
    // the sticker queue is the canonical entry point and
    // resolve-operation.ts treats the two as interchangeable.
    BLISTERED: "BOTTLE_STICKER_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
  STICKER_ONLY: {
    STARTED: "BOTTLE_STICKER_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
};

export function bagStageToQueueStageKey(
  bagStage: string | null | undefined,
  routeCode: string | null | undefined,
): string | null {
  if (!bagStage || !routeCode) return null;
  const table = QUEUE_FOR_BAG_STAGE[routeCode];
  if (!table) return null;
  return table[bagStage] ?? null;
}

/** Queue stage key → the bag stage that puts a bag into it, within a
 *  route.
 *
 *  Route-parameterized because the same queue key means different
 *  things on different routes: BOTTLE_STICKER_QUEUE is entered at
 *  BLISTERED on the BOTTLE route (fill happens first) but at STARTED on
 *  STICKER_ONLY (stickering IS the first operation). Both routes are
 *  seeded in drizzle/0013_route_operation_compat.sql. A flat table
 *  would silently return the wrong stage for one of them.
 *
 *  Derived by inverting QUEUE_FOR_BAG_STAGE so the two directions
 *  cannot drift apart. Staging keys (POST_*_STAGING) appear in no
 *  forward table and correctly return null.
 *
 *  Note the deliberate asymmetry at the end of a route: the forward
 *  table sends a PACKAGED bag to FINISHED_GOODS_QUEUE, and this
 *  function maps that key back to FINALIZED, not PACKAGED. Entering
 *  the finished-goods queue is what finalizes a bag, so the pair is
 *  not a round-trip identity there. */
export function queueStageKeyToBagStage(
  queueStageKey: string | null | undefined,
  routeCode: string | null | undefined,
): string | null {
  if (!queueStageKey || !routeCode) return null;
  if (queueStageKey === "FINISHED_GOODS_QUEUE") return "FINALIZED";
  const table = QUEUE_FOR_BAG_STAGE[routeCode];
  if (!table) return null;
  const match = Object.entries(table).find(([, queue]) => queue === queueStageKey);
  return match?.[0] ?? null;
}
