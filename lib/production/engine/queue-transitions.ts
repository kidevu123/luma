// P2-QUEUE-1 — pure queue-row decisions. The read_bag_queue row always
// describes a bag's NEXT destination; this module decides how each
// workflow event mutates it. The projector (lib/projector/bag-queue.ts)
// is the only writer.
//
// Route knowledge is a hardcoded table for the three seeded routes,
// mirroring drizzle/0013 + 0071. Phase 6 replaces it with a
// route_operations lookup once the data-driven path is universal.

import { bothBottleFinishingDone } from "@/lib/production/stage-progression";

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

const BOTTLE_FINISHING_KINDS = ["BOTTLE_STICKER", "BOTTLE_CAP_SEAL"] as const;

/** Rank of each queue along a route — higher is further downstream.
 *  Used to reject stale upstream echoes: a transition whose computed
 *  destination ranks BELOW the row's current queue is an out-of-order
 *  arrival (overlap scanning) and must not clobber the row. The two
 *  bottle finishing queues share a rank because the steps are
 *  order-independent (P2-BOTTLE-FLEX-1). */
const QUEUE_RANK: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  CARD_BLISTER: { SEALING_QUEUE: 1, PACKAGING_QUEUE: 2, FINISHED_GOODS_QUEUE: 3 },
  BOTTLE: {
    BOTTLE_STICKER_QUEUE: 1,
    BOTTLE_INDUCTION_QUEUE: 1,
    PACKAGING_QUEUE: 2,
    FINISHED_GOODS_QUEUE: 3,
  },
  STICKER_ONLY: { PACKAGING_QUEUE: 1, FINISHED_GOODS_QUEUE: 2 },
};

export function queueRank(routeCode: string, queueStageKey: string): number | null {
  return QUEUE_RANK[routeCode]?.[queueStageKey] ?? null;
}

const FINISHING_COMPLETION_FOR_KIND: Readonly<Record<string, string>> = {
  BOTTLE_STICKER: "BOTTLE_STICKER_COMPLETE",
  BOTTLE_CAP_SEAL: "BOTTLE_CAP_SEAL_COMPLETE",
};

function bottleFinishingDestination(
  priorEventTypes: readonly string[],
): QueueDestination {
  const stickerDone = priorEventTypes.includes("BOTTLE_STICKER_COMPLETE");
  const capSealDone = priorEventTypes.includes("BOTTLE_CAP_SEAL_COMPLETE");
  if (bothBottleFinishingDone(priorEventTypes)) {
    return { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] };
  }
  if (capSealDone) {
    return { queueStageKey: "BOTTLE_STICKER_QUEUE", eligibleStationKinds: ["BOTTLE_STICKER"] };
  }
  if (stickerDone) {
    return { queueStageKey: "BOTTLE_INDUCTION_QUEUE", eligibleStationKinds: ["BOTTLE_CAP_SEAL"] };
  }
  return {
    queueStageKey: "BOTTLE_STICKER_QUEUE",
    eligibleStationKinds: [...BOTTLE_FINISHING_KINDS],
  };
}

/** Where does a bag being worked at this station go next? Null when the
 *  station finalizes in place (no next queue) or inputs are unknown. */
export function queueAfterWorkAt(args: {
  routeCode: string;
  stationKind: string;
  priorEventTypes: readonly string[];
}): QueueDestination | null {
  const { routeCode, stationKind } = args;
  if (routeCode === "CARD_BLISTER") {
    if (stationKind === "BLISTER" || stationKind === "HANDPACK_BLISTER") {
      return { queueStageKey: "SEALING_QUEUE", eligibleStationKinds: ["SEALING"] };
    }
    if (stationKind === "SEALING") {
      return { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] };
    }
    if (stationKind === "PACKAGING") {
      return { queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] };
    }
    // COMBINED finalizes in place — no next queue.
    return null;
  }
  if (routeCode === "BOTTLE") {
    if (stationKind === "BOTTLE_HANDPACK") {
      return bottleFinishingDestination(args.priorEventTypes);
    }
    if (stationKind === "BOTTLE_STICKER" || stationKind === "BOTTLE_CAP_SEAL") {
      // The destination is where the bag goes AFTER this station's own
      // step — so treat that step as done even when computing at pickup
      // time (before its completion event exists). Keeps the row from
      // listing the working station as eligible for its own output, and
      // makes pickup-time and completion-time destinations agree.
      const implied = FINISHING_COMPLETION_FOR_KIND[stationKind];
      const effective =
        implied && !args.priorEventTypes.includes(implied)
          ? [...args.priorEventTypes, implied]
          : args.priorEventTypes;
      return bottleFinishingDestination(effective);
    }
    if (stationKind === "PACKAGING") {
      return { queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] };
    }
    return null;
  }
  if (routeCode === "STICKER_ONLY") {
    if (stationKind === "BOTTLE_STICKER") {
      return { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] };
    }
    if (stationKind === "PACKAGING") {
      return { queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] };
    }
    return null;
  }
  return null;
}

export function deriveQueueTransition(args: {
  eventType: string;
  stationId: string | null;
  stationKind: string | null;
  routeCode: string | null;
  priorEventTypes: readonly string[];
  currentRow: { queueStageKey: string; claimedByStationId: string | null } | null;
}): QueueTransition {
  const { eventType } = args;

  if (eventType === "BAG_FINALIZED") return { kind: "REMOVE" };
  if (eventType === "BAG_RELEASED") return { kind: "UNCLAIM" };

  if (START_EVENTS.has(eventType) || eventType === "BAG_PICKED_UP") {
    if (!args.stationId || !args.stationKind || !args.routeCode) return { kind: "NONE" };
    const destination = queueAfterWorkAt({
      routeCode: args.routeCode,
      stationKind: args.stationKind,
      priorEventTypes: args.priorEventTypes,
    });
    if (!destination) return { kind: "NONE" };
    return { kind: "WORKING", destination, claimedByStationId: args.stationId };
  }

  if (COMPLETION_EVENTS.has(eventType)) {
    if (!args.stationKind || !args.routeCode) return { kind: "NONE" };
    const destination = queueAfterWorkAt({
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
      const currentRank = queueRank(args.routeCode, args.currentRow.queueStageKey);
      const nextRank = queueRank(args.routeCode, destination.queueStageKey);
      if (currentRank != null && nextRank != null && nextRank < currentRank) {
        return { kind: "NONE" };
      }
    }
    return { kind: "READY", destination };
  }

  return { kind: "NONE" };
}
