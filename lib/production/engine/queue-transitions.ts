// P2-QUEUE-1 / P6-TASK-3 — pure queue-row decisions. The read_bag_queue
// row always describes a bag's NEXT destination; this module decides how
// each workflow event mutates it. The projector (lib/projector/bag-queue.ts)
// is the only writer.
//
// Phase 6 Task 3: route knowledge now comes from the data-driven
// RouteGraph (built from route_operations rows via lib/production/engine/
// route-data.ts). The hardcoded per-route switch cases and QUEUE_RANK
// table that used to live in this file are gone; this module is now a
// pure orchestrator over the graph twins.
//
// Purity contract: every exported function is a pure value transform —
// callers pass the RouteGraph in. The projector loads it once via the
// process-lifetime cached loader (loadRouteGraph) and threads the value
// through; deriveQueueTransition never touches the DB or the cache.

import {
  queueAfterWorkAtFromGraph,
  queueRankFromGraph,
  type RouteGraph,
} from "@/lib/production/engine/route-data";

export type QueueDestination = {
  queueStageKey: string;
  eligibleStationKinds: string[];
};

export type QueueTransition =
  | { kind: "WORKING"; destination: QueueDestination; claimedByStationId: string }
  | { kind: "READY"; destination: QueueDestination }
  | { kind: "UNCLAIM" }
  | { kind: "REMOVE" }
  | { kind: "NONE" };

/** Station kinds that begin tracking on CARD_ASSIGNED / BAG_CLAIMED. */
const START_EVENTS = new Set(["CARD_ASSIGNED", "BAG_CLAIMED"]);

/** Stage completions that flip the queue row to READY. */
const COMPLETION_EVENTS = new Set([
  "BLISTER_COMPLETE",
  "HANDPACK_BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
]);

/** Where does a bag being worked at this station go next? Null when the
 *  station finalizes in place (no next queue) or inputs are unknown.
 *
 *  Graph-backed. Bottle-finishing narrowing (self-implication for the
 *  working station and the both-eligible / one-done cases) lives in the
 *  graph twin — see route-data.ts. */
export function queueAfterWorkAt(
  graph: RouteGraph,
  args: {
    routeCode: string;
    stationKind: string;
    priorEventTypes: readonly string[];
  },
): QueueDestination | null {
  return queueAfterWorkAtFromGraph(graph, args);
}

/** Rank of each queue along a route — higher is further downstream.
 *  Used to reject stale upstream echoes: a transition whose computed
 *  destination ranks BELOW the row's current queue is an out-of-order
 *  arrival (overlap scanning) and must not clobber the row. Order-
 *  independent group members share a rank (finishing queues on BOTTLE).
 *
 *  Graph-backed. See queueRankFromGraph in route-data.ts. */
export function queueRank(
  graph: RouteGraph,
  routeCode: string,
  queueStageKey: string,
): number | null {
  return queueRankFromGraph(graph, routeCode, queueStageKey);
}

export function deriveQueueTransition(
  graph: RouteGraph,
  args: {
    eventType: string;
    stationId: string | null;
    stationKind: string | null;
    routeCode: string | null;
    priorEventTypes: readonly string[];
    currentRow: { queueStageKey: string; claimedByStationId: string | null } | null;
  },
): QueueTransition {
  const { eventType } = args;

  if (eventType === "BAG_FINALIZED") return { kind: "REMOVE" };
  if (eventType === "BAG_RELEASED") return { kind: "UNCLAIM" };

  if (START_EVENTS.has(eventType) || eventType === "BAG_PICKED_UP") {
    if (!args.stationId || !args.stationKind || !args.routeCode) return { kind: "NONE" };
    const destination = queueAfterWorkAt(graph, {
      routeCode: args.routeCode,
      stationKind: args.stationKind,
      priorEventTypes: args.priorEventTypes,
    });
    if (!destination) return { kind: "NONE" };
    return { kind: "WORKING", destination, claimedByStationId: args.stationId };
  }

  if (COMPLETION_EVENTS.has(eventType)) {
    if (!args.stationKind || !args.routeCode) return { kind: "NONE" };
    const destination = queueAfterWorkAt(graph, {
      routeCode: args.routeCode,
      stationKind: args.stationKind,
      priorEventTypes: args.priorEventTypes,
    });
    if (!destination) return { kind: "NONE" };
    // Stale-echo guard: with overlap scanning, an upstream completion
    // (BLISTER_COMPLETE) can arrive AFTER a downstream station already
    // picked the bag up. If the computed destination ranks below the
    // row's current queue, this event is out of date for queue purposes
    // — applying it would clobber the downstream claim.
    if (args.currentRow) {
      const currentRank = queueRank(graph, args.routeCode, args.currentRow.queueStageKey);
      const nextRank = queueRank(graph, args.routeCode, destination.queueStageKey);
      if (currentRank != null && nextRank != null && nextRank < currentRank) {
        return { kind: "NONE" };
      }
    }
    return { kind: "READY", destination };
  }

  return { kind: "NONE" };
}
