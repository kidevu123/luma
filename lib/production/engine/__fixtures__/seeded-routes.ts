// P6 Task 3 — shared seeded-routes fixture.
//
// Single source of truth for the three seeded routes (CARD_BLISTER,
// BOTTLE, STICKER_ONLY) transcribed from the seed migrations:
//   - drizzle/0013_route_operation_compat.sql (initial seed, lines 168-215)
//   - drizzle/0071_read_bag_queue_and_bottle_flex.sql (BOTTLE_FINISHING group)
//   - drizzle/0074_handpack_route_operation.sql (HANDPACK_BLISTER op)
//
// Consumers:
//   - route-data.test.ts        — retargeted parity harness (graph vs
//                                 expected behaviors transcribed from the
//                                 subsumed hardcoded tables).
//   - station-event-mapping.test.ts — pins station-kind → workflow-event
//                                 mapping and operation ordering.
//   - queue-transitions.test.ts / floor-event-relevance.test.ts — the
//                                 consumer twins that used to pin the
//                                 hardcoded tables now build their graph
//                                 from this fixture.
//
// The migration-text guards live in the CONSUMER test files (their
// substring checks assert every op code in this fixture appears in the
// referenced migration file); duplicating the guards here would
// double-report a single drift, so this module stays pure data.
//
// Limitation (same as station-event-mapping.test.ts): the substring
// guards catch a renamed or dropped op code; they do NOT catch a
// changed sequence, stage key, or allowed station kind. Any migration
// touching those fields must update this fixture by hand.

import type { RouteOperationView } from "@/lib/production/routes";
import { buildRouteGraph, type RouteGraph } from "@/lib/production/engine/route-data";

/** Minimal seed shape — the fields the twins actually consume. */
export type SeededRouteOp = {
  routeCode: string;
  sequence: number;
  operationCode: string;
  stageKey: string;
  nextStageKey: string | null;
  allowedStationKind: string | null;
  orderIndependentGroup: string | null;
};

/** Flat list of the three seeded routes' operations, in migration order. */
export const SEEDED_ROUTE_OPS: readonly SeededRouteOp[] = [
  // CARD_BLISTER (0013 lines 173-179)
  { routeCode: "CARD_BLISTER", sequence: 1, operationCode: "RECEIVING",            stageKey: "RECEIVING_QUEUE",       nextStageKey: "BLISTER_QUEUE",         allowedStationKind: null,                orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 2, operationCode: "BLISTER",              stageKey: "BLISTER_QUEUE",         nextStageKey: "POST_BLISTER_STAGING",  allowedStationKind: "BLISTER",           orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 3, operationCode: "POST_BLISTER_STAGING", stageKey: "POST_BLISTER_STAGING",  nextStageKey: "SEALING_QUEUE",         allowedStationKind: null,                orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 4, operationCode: "HEAT_SEAL",            stageKey: "SEALING_QUEUE",         nextStageKey: "POST_SEAL_STAGING",     allowedStationKind: "SEALING",           orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 5, operationCode: "POST_SEAL_STAGING",    stageKey: "POST_SEAL_STAGING",     nextStageKey: "PACKAGING_QUEUE",       allowedStationKind: null,                orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 6, operationCode: "PACKAGING",            stageKey: "PACKAGING_QUEUE",       nextStageKey: "FINISHED_GOODS_QUEUE",  allowedStationKind: "PACKAGING",         orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 7, operationCode: "FINISHED_GOODS",       stageKey: "FINISHED_GOODS_QUEUE",  nextStageKey: null,                    allowedStationKind: null,                orderIndependentGroup: null },
  // 0074: HANDPACK_BLISTER row on CARD_BLISTER (seq 8), same stage/next
  // as BLISTER. Entry ops are rank-equivalent via stage keys; the
  // sequence value here is post-BLISTER only because sequence must be
  // unique per (route_id, sequence).
  { routeCode: "CARD_BLISTER", sequence: 8, operationCode: "HANDPACK_BLISTER",     stageKey: "BLISTER_QUEUE",         nextStageKey: "POST_BLISTER_STAGING",  allowedStationKind: "HANDPACK_BLISTER",  orderIndependentGroup: null },

  // BOTTLE (0013 lines 191-196)
  { routeCode: "BOTTLE", sequence: 1, operationCode: "RECEIVING",      stageKey: "RECEIVING_QUEUE",       nextStageKey: "BOTTLE_FILL_QUEUE",      allowedStationKind: null,               orderIndependentGroup: null },
  { routeCode: "BOTTLE", sequence: 2, operationCode: "BOTTLE_FILL",    stageKey: "BOTTLE_FILL_QUEUE",     nextStageKey: "BOTTLE_STICKER_QUEUE",   allowedStationKind: "BOTTLE_HANDPACK",  orderIndependentGroup: null },
  // 0071: STICKERING + INDUCTION_SEAL get order_independent_group='BOTTLE_FINISHING'.
  { routeCode: "BOTTLE", sequence: 3, operationCode: "STICKERING",     stageKey: "BOTTLE_STICKER_QUEUE",  nextStageKey: "BOTTLE_INDUCTION_QUEUE", allowedStationKind: "BOTTLE_STICKER",   orderIndependentGroup: "BOTTLE_FINISHING" },
  { routeCode: "BOTTLE", sequence: 4, operationCode: "INDUCTION_SEAL", stageKey: "BOTTLE_INDUCTION_QUEUE",nextStageKey: "PACKAGING_QUEUE",        allowedStationKind: "BOTTLE_CAP_SEAL",  orderIndependentGroup: "BOTTLE_FINISHING" },
  { routeCode: "BOTTLE", sequence: 5, operationCode: "PACKAGING",      stageKey: "PACKAGING_QUEUE",       nextStageKey: "FINISHED_GOODS_QUEUE",   allowedStationKind: "PACKAGING",        orderIndependentGroup: null },
  { routeCode: "BOTTLE", sequence: 6, operationCode: "FINISHED_GOODS", stageKey: "FINISHED_GOODS_QUEUE",  nextStageKey: null,                     allowedStationKind: null,               orderIndependentGroup: null },

  // STICKER_ONLY (0013 lines 208-211)
  { routeCode: "STICKER_ONLY", sequence: 1, operationCode: "RECEIVING",      stageKey: "RECEIVING_QUEUE",       nextStageKey: "BOTTLE_STICKER_QUEUE", allowedStationKind: null,             orderIndependentGroup: null },
  { routeCode: "STICKER_ONLY", sequence: 2, operationCode: "STICKERING",     stageKey: "BOTTLE_STICKER_QUEUE",  nextStageKey: "PACKAGING_QUEUE",      allowedStationKind: "BOTTLE_STICKER", orderIndependentGroup: null },
  { routeCode: "STICKER_ONLY", sequence: 3, operationCode: "PACKAGING",      stageKey: "PACKAGING_QUEUE",       nextStageKey: "FINISHED_GOODS_QUEUE", allowedStationKind: "PACKAGING",      orderIndependentGroup: null },
  { routeCode: "STICKER_ONLY", sequence: 4, operationCode: "FINISHED_GOODS", stageKey: "FINISHED_GOODS_QUEUE",  nextStageKey: null,                   allowedStationKind: null,             orderIndependentGroup: null },
];

/** Grouped by route — the shape station-event-mapping.test.ts wants. */
export const SEEDED_ROUTES_BY_CODE: Readonly<Record<string, RouteOperationView[]>> = (() => {
  const grouped: Record<string, RouteOperationView[]> = {};
  for (const seed of SEEDED_ROUTE_OPS) {
    const bucket = grouped[seed.routeCode] ?? [];
    bucket.push(toRouteOperationView(seed));
    grouped[seed.routeCode] = bucket;
  }
  return grouped;
})();

/** Build a RouteGraph from the shared fixture. Same shape a production
 *  loader would return, used by every consumer test. */
export function makeSeededRouteGraph(): RouteGraph {
  return buildRouteGraph(Object.values(SEEDED_ROUTES_BY_CODE));
}

/** Widen a SeededRouteOp to the loader-return shape. Sequence and code
 *  fields are the only ones the graph actually reads; the rest are
 *  padded with defaults matching drizzle/0013's DEFAULTs. */
export function toRouteOperationView(s: SeededRouteOp): RouteOperationView {
  return {
    routeCode: s.routeCode,
    routeName: s.routeCode,
    sequence: s.sequence,
    operationCode: s.operationCode,
    operationName: s.operationCode,
    stageKey: s.stageKey,
    nextStageKey: s.nextStageKey,
    reworkStageKey: null,
    allowedStationKind: s.allowedStationKind,
    allowedMachineKind: s.allowedStationKind,
    requiresScan: false,
    requiresCounter: false,
    requiresTimer: false,
    outputUnit: null,
    orderIndependentGroup: s.orderIndependentGroup,
  };
}
