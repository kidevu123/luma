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

/** Queue stage key → the bag stage that puts a bag into it. Staging
 *  keys (POST_*_STAGING) have no bag-stage equivalent and return null. */
const BAG_STAGE_FOR_QUEUE: Readonly<Record<string, string>> = {
  RECEIVING_QUEUE: "STARTED",
  BLISTER_QUEUE: "STARTED",
  SEALING_QUEUE: "BLISTERED",
  BOTTLE_FILL_QUEUE: "STARTED",
  BOTTLE_STICKER_QUEUE: "BLISTERED",
  BOTTLE_INDUCTION_QUEUE: "BLISTERED",
  PACKAGING_QUEUE: "SEALED",
  FINISHED_GOODS_QUEUE: "FINALIZED",
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

export function queueStageKeyToBagStage(
  queueStageKey: string | null | undefined,
): string | null {
  if (!queueStageKey) return null;
  return BAG_STAGE_FOR_QUEUE[queueStageKey] ?? null;
}
