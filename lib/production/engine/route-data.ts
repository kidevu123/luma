// P6 Task 2 — data-driven route graph + pure twins of the hardcoded
// route tables in queue-transitions.ts and floor-event-relevance.ts.
//
// This module is the DATA side of the Phase 6 parity swap: it holds a
// RouteGraph value built from route_operations rows, plus pure
// derivations of the three hardcoded tables (queueAfterWorkAt's route
// map, QUEUE_RANK, queueKeysForStationKind). The twins are parity-pinned
// against the hardcoded versions before any consumer switches (Task 3).
//
// Cache lifetime mirrors station-kind-cache.ts: route_operations rows
// change only via a deliberate migration (0013, 0071, 0074, ...), which
// implies a deploy, which is a fresh process and a fresh cache. So we
// memoize per process with no invalidation path — the same trade the
// station-kind cache accepts, for the same reason.
//
// The loader is loader-injectable for tests, again mirroring
// station-kind-cache.ts's shape.

import {
  bothBottleFinishingDone,
  STATION_PICKUP_FROM_STAGE,
} from "@/lib/production/stage-progression";
import { bagStageToQueueStageKey } from "@/lib/production/engine/stage-lexicon";
import type { QueueDestination } from "@/lib/production/engine/queue-transitions";
import type { RouteOperationView } from "@/lib/production/routes";
import { db } from "@/lib/db";
import { productionRoutes, routeOperations, operationTypes } from "@/lib/db/schema";
import { and, asc, eq } from "drizzle-orm";

// ─── RouteGraph type ────────────────────────────────────────────────

/** A route-scoped snapshot of the fields the twins actually consume. */
export type RouteGraphOp = {
  routeCode: string;
  sequence: number;
  operationCode: string;
  stageKey: string;
  nextStageKey: string | null;
  allowedStationKind: string | null;
  orderIndependentGroup: string | null;
};

/** Pure data. routes[routeCode] is the ordered (by sequence) list of
 *  operations for that route. Order-independent groups are represented
 *  by op.orderIndependentGroup — sequence tie-breakers ignore them. */
export type RouteGraph = {
  routes: Readonly<Record<string, readonly RouteGraphOp[]>>;
};

// ─── Build the graph ────────────────────────────────────────────────

/** Pure: fold RouteOperationView[] per route into a RouteGraph.
 *  Accepts an array of per-route op arrays (mirrors how loadRouteGraph
 *  reads: one query per route or one grouped query). Order of ops
 *  inside each route is stabilized on `sequence` asc. */
export function buildRouteGraph(ops: RouteOperationView[][]): RouteGraph {
  const routes: Record<string, RouteGraphOp[]> = {};
  for (const routeOps of ops) {
    for (const op of routeOps) {
      const bucket = routes[op.routeCode] ?? [];
      bucket.push({
        routeCode: op.routeCode,
        sequence: op.sequence,
        operationCode: op.operationCode,
        stageKey: op.stageKey,
        nextStageKey: op.nextStageKey,
        allowedStationKind: op.allowedStationKind,
        orderIndependentGroup: op.orderIndependentGroup,
      });
      routes[op.routeCode] = bucket;
    }
  }
  for (const code of Object.keys(routes)) {
    const arr = routes[code];
    if (arr) arr.sort((a, b) => a.sequence - b.sequence);
  }
  return { routes };
}

// ─── Cached loader ──────────────────────────────────────────────────

/** Injectable for tests; production callers omit it and get the
 *  DB-backed default below. Returns per-route arrays, one per route. */
export type RouteGraphLoader = () => Promise<RouteOperationView[][]>;

const defaultLoader: RouteGraphLoader = async () => {
  const rows = await db
    .select({
      routeCode: productionRoutes.code,
      routeName: productionRoutes.name,
      sequence: routeOperations.sequence,
      operationCode: operationTypes.code,
      operationName: operationTypes.name,
      stageKey: routeOperations.stageKey,
      nextStageKey: routeOperations.nextStageKey,
      reworkStageKey: routeOperations.reworkStageKey,
      allowedStationKind: routeOperations.allowedStationKind,
      allowedMachineKind: routeOperations.allowedMachineKind,
      requiresScan: routeOperations.requiresScan,
      requiresCounter: routeOperations.requiresCounter,
      requiresTimer: routeOperations.requiresTimer,
      outputUnit: routeOperations.outputUnit,
      orderIndependentGroup: routeOperations.orderIndependentGroup,
    })
    .from(routeOperations)
    .innerJoin(productionRoutes, eq(productionRoutes.id, routeOperations.routeId))
    .innerJoin(operationTypes, eq(operationTypes.id, routeOperations.operationTypeId))
    .where(and(eq(routeOperations.isActive, true)))
    .orderBy(asc(productionRoutes.code), asc(routeOperations.sequence));

  const perRoute = new Map<string, RouteOperationView[]>();
  for (const row of rows) {
    const bucket = perRoute.get(row.routeCode) ?? [];
    bucket.push(row);
    perRoute.set(row.routeCode, bucket);
  }
  return Array.from(perRoute.values());
};

let cachedGraph: RouteGraph | null = null;

/** Load-once graph. Reset for tests via __resetRouteGraphCacheForTests. */
export async function loadRouteGraph(
  loader: RouteGraphLoader = defaultLoader,
): Promise<RouteGraph> {
  if (cachedGraph) return cachedGraph;
  const raw = await loader();
  cachedGraph = buildRouteGraph(raw);
  return cachedGraph;
}

/** Test hook. Not used by production callers. */
export function __resetRouteGraphCacheForTests(): void {
  cachedGraph = null;
}

// ─── Twins ──────────────────────────────────────────────────────────

const BOTTLE_FINISHING_KINDS = ["BOTTLE_STICKER", "BOTTLE_CAP_SEAL"] as const;

const FINISHING_COMPLETION_FOR_KIND: Readonly<Record<string, string>> = {
  BOTTLE_STICKER: "BOTTLE_STICKER_COMPLETE",
  BOTTLE_CAP_SEAL: "BOTTLE_CAP_SEAL_COMPLETE",
};

/** Ops in the route indexed by stage_key. */
function opsByStageKey(
  ops: readonly RouteGraphOp[],
): Map<string, RouteGraphOp> {
  const m = new Map<string, RouteGraphOp>();
  for (const op of ops) m.set(op.stageKey, op);
  return m;
}

/** Ops matching a station kind in a route. Sorted by sequence. */
function opsForKindInRoute(
  ops: readonly RouteGraphOp[],
  stationKind: string,
): RouteGraphOp[] {
  return ops
    .filter((o) => o.allowedStationKind === stationKind)
    .sort((a, b) => a.sequence - b.sequence);
}

/** Walk downstream from `startStage` along the sequential nextStageKey
 *  chain, skipping non-stationed staging ops, until we hit either an op
 *  with a non-null allowedStationKind (a real machine op) or a terminal
 *  stage (nextStageKey null / no matching op).
 *
 *  Returns the queue key the bag will park in AFTER `startStage`'s op
 *  finishes: mirrors the hardcoded queueAfterWorkAt behavior that jumps
 *  past POST_BLISTER_STAGING / POST_SEAL_STAGING to the next machine
 *  queue. */
function walkToNextStationedQueue(
  ops: readonly RouteGraphOp[],
  startStage: string,
): string | null {
  const byStage = opsByStageKey(ops);
  const startOp = byStage.get(startStage);
  if (!startOp) return null;
  let current = startOp.nextStageKey;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return null; // safety against cycles
    seen.add(current);
    const nextOp = byStage.get(current);
    if (!nextOp) return current; // dangling next; treat as terminal
    if (nextOp.allowedStationKind !== null) return current; // stationed → stop
    if (nextOp.nextStageKey === null) return current; // terminal staging op
    current = nextOp.nextStageKey;
  }
  return null;
}

/** Kinds eligible to claim a bag from the given queue in this route.
 *  Order-independent group: when the queue is one of the group members'
 *  stage keys, return ALL peer kinds (both-eligible parking). */
function eligibleKindsForQueue(
  ops: readonly RouteGraphOp[],
  queueStageKey: string,
): string[] {
  const opsAtQueue = ops.filter(
    (o) => o.stageKey === queueStageKey && o.allowedStationKind !== null,
  );
  if (opsAtQueue.length === 0) return [];
  const groups = new Set(
    opsAtQueue
      .map((o) => o.orderIndependentGroup)
      .filter((g): g is string => g !== null),
  );
  if (groups.size > 0) {
    const kinds = new Set<string>();
    for (const o of opsAtQueue) {
      if (o.allowedStationKind !== null) kinds.add(o.allowedStationKind);
    }
    for (const g of groups) {
      for (const peer of ops) {
        if (
          peer.orderIndependentGroup === g &&
          peer.allowedStationKind !== null
        ) {
          kinds.add(peer.allowedStationKind);
        }
      }
    }
    return [...kinds];
  }
  const kinds = new Set<string>();
  for (const o of opsAtQueue) {
    if (o.allowedStationKind !== null) kinds.add(o.allowedStationKind);
  }
  return [...kinds];
}

/** Bottle-finishing destination narrowing, graph edition. Mirrors
 *  bottleFinishingDestination in queue-transitions.ts. */
function bottleFinishingDestinationFromGraph(
  routeOps: readonly RouteGraphOp[],
  priorEventTypes: readonly string[],
): QueueDestination {
  const stickerDone = priorEventTypes.includes("BOTTLE_STICKER_COMPLETE");
  const capSealDone = priorEventTypes.includes("BOTTLE_CAP_SEAL_COMPLETE");

  if (bothBottleFinishingDone(priorEventTypes)) {
    // Both finishing steps done → the queue AFTER the whole group.
    // Walk from the LAST-sequenced peer's stage_key so we skip past the
    // other peer (which is itself stationed) to the group's downstream.
    const groupPeers = routeOps
      .filter((o) => o.orderIndependentGroup === "BOTTLE_FINISHING")
      .sort((a, b) => a.sequence - b.sequence);
    const lastPeer = groupPeers[groupPeers.length - 1];
    const next = lastPeer
      ? walkToNextStationedQueue(routeOps, lastPeer.stageKey)
      : null;
    return {
      queueStageKey: next ?? "PACKAGING_QUEUE",
      eligibleStationKinds: next
        ? eligibleKindsForQueue(routeOps, next)
        : ["PACKAGING"],
    };
  }
  if (capSealDone) {
    // Sticker still to run — park under sticker queue key, only sticker eligible.
    const stickerOp = routeOps.find(
      (o) => o.allowedStationKind === "BOTTLE_STICKER",
    );
    return {
      queueStageKey: stickerOp?.stageKey ?? "BOTTLE_STICKER_QUEUE",
      eligibleStationKinds: ["BOTTLE_STICKER"],
    };
  }
  if (stickerDone) {
    // Cap-seal still to run. Hardcoded parks under BOTTLE_INDUCTION_QUEUE
    // (cap-seal's own stage_key), only cap-seal eligible.
    const capSealOp = routeOps.find(
      (o) => o.allowedStationKind === "BOTTLE_CAP_SEAL",
    );
    return {
      queueStageKey: capSealOp?.stageKey ?? "BOTTLE_INDUCTION_QUEUE",
      eligibleStationKinds: ["BOTTLE_CAP_SEAL"],
    };
  }
  // Neither done — park under sticker key, both eligible.
  const stickerOp = routeOps.find(
    (o) => o.allowedStationKind === "BOTTLE_STICKER",
  );
  return {
    queueStageKey: stickerOp?.stageKey ?? "BOTTLE_STICKER_QUEUE",
    eligibleStationKinds: [...BOTTLE_FINISHING_KINDS],
  };
}

/** Graph twin of queueAfterWorkAt. */
export function queueAfterWorkAtFromGraph(
  graph: RouteGraph,
  args: {
    routeCode: string;
    stationKind: string;
    priorEventTypes: readonly string[];
  },
): QueueDestination | null {
  const routeOps = graph.routes[args.routeCode];
  if (!routeOps || routeOps.length === 0) return null;

  const matches = opsForKindInRoute(routeOps, args.stationKind);
  if (matches.length === 0) return null;

  // Bottle-finishing narrowing: any op in the BOTTLE_FINISHING group
  // triggers the narrowing logic (self-implication for the working
  // finishing station included).
  const inFinishingGroup = matches.find(
    (o) => o.orderIndependentGroup === "BOTTLE_FINISHING",
  );
  if (inFinishingGroup) {
    // Self-implication: from the perspective of the station currently
    // working the bag, treat its own step as done when computing where
    // the bag goes AFTER this station finishes. This keeps the row from
    // listing the working station as eligible for its own output and
    // makes pickup-time and completion-time destinations agree.
    const implied = FINISHING_COMPLETION_FOR_KIND[args.stationKind];
    const effective =
      implied && !args.priorEventTypes.includes(implied)
        ? [...args.priorEventTypes, implied]
        : args.priorEventTypes;
    return bottleFinishingDestinationFromGraph(routeOps, effective);
  }

  // Bottle fill has no group but produces a bag that both finishing
  // stations are eligible for.
  if (args.stationKind === "BOTTLE_HANDPACK") {
    return bottleFinishingDestinationFromGraph(routeOps, args.priorEventTypes);
  }

  // General case: follow the graph past staging ops.
  const op = matches[0]!;
  const nextQueue = walkToNextStationedQueue(routeOps, op.stageKey);
  if (!nextQueue) return null;
  return {
    queueStageKey: nextQueue,
    eligibleStationKinds: eligibleKindsForQueue(routeOps, nextQueue),
  };
}

/** Graph twin of queueRank. Rank enumerates the DESTINATION queues
 *  produced by queueAfterWorkAt along the sequenced stationed ops.
 *  Order-independent group members share a rank; the group's collective
 *  post-done destination is one rank downstream. */
export function queueRankFromGraph(
  graph: RouteGraph,
  routeCode: string,
  queueStageKey: string,
): number | null {
  const routeOps = graph.routes[routeCode];
  if (!routeOps) return null;

  // Sequenced stationed ops (in visit order).
  const stationedOps = routeOps
    .filter((o) => o.allowedStationKind !== null)
    .sort((a, b) => a.sequence - b.sequence);

  const ranks = new Map<string, number>();
  let currentRank = 1;
  const seenGroups = new Set<string>();

  const assignRank = (queue: string) => {
    if (!ranks.has(queue)) ranks.set(queue, currentRank);
  };

  for (let i = 0; i < stationedOps.length; i++) {
    const op = stationedOps[i]!;
    if (op.orderIndependentGroup) {
      if (seenGroups.has(op.orderIndependentGroup)) continue; // second peer — skip
      seenGroups.add(op.orderIndependentGroup);

      // Collective group tier: each peer's stage_key is a valid parking
      // destination (both-eligible until narrowed). These share a rank.
      const peers = stationedOps.filter(
        (o) => o.orderIndependentGroup === op.orderIndependentGroup,
      );
      for (const peer of peers) assignRank(peer.stageKey);
      currentRank++;

      // Group-done destination: walk from the last-sequenced peer's
      // stage_key past staging ops to the next stationed queue.
      const lastPeer = peers[peers.length - 1]!;
      const groupDone = walkToNextStationedQueue(routeOps, lastPeer.stageKey);
      if (groupDone) {
        assignRank(groupDone);
        currentRank++;
      }
      continue;
    }

    // Ungrouped stationed op: its destination is one tier further.
    const dest = walkToNextStationedQueue(routeOps, op.stageKey);
    if (!dest) continue;

    // If dest is a group entrance, the tier is the whole group
    // (both-eligible parking). Rank all peers together, then advance.
    const destOp = routeOps.find(
      (o) => o.stageKey === dest && o.allowedStationKind !== null,
    );
    if (destOp?.orderIndependentGroup) {
      const peers = stationedOps.filter(
        (o) => o.orderIndependentGroup === destOp.orderIndependentGroup,
      );
      for (const peer of peers) assignRank(peer.stageKey);
      currentRank++;
      // The group's own stationed ops will be skipped when the loop
      // reaches them (seenGroups). But the group-done tier still needs
      // to be added — that happens when the peer op is processed
      // (skipped path above assigns it via a peer). To be safe, mark
      // the group as seen here so the group-done tier gets added when
      // any peer is next encountered.
      seenGroups.add(destOp.orderIndependentGroup);
      const lastPeer = peers[peers.length - 1]!;
      const groupDone = walkToNextStationedQueue(routeOps, lastPeer.stageKey);
      if (groupDone) {
        assignRank(groupDone);
        currentRank++;
      }
    } else {
      assignRank(dest);
      currentRank++;
    }
  }

  return ranks.get(queueStageKey) ?? null;
}

/** Graph twin of queueKeysForStationKind.
 *
 *  Derivation:
 *    - First-op kinds (no entry in STATION_PICKUP_FROM_STAGE) return [].
 *    - Base: stage_keys of ops with this station kind, across all routes.
 *    - Order-independent group: add peer stage_keys within the same route.
 *    - Overlap-parking: for each pickup stage S ≠ STARTED in
 *      STATION_PICKUP_FROM_STAGE[kind], for each route R where the kind
 *      has an op, add bagStageToQueueStageKey(S, R) IF (a) different from
 *      the kind's own stage_key on R, and (b) a non-stationed "staging"
 *      op sits between the queue's op and the kind's op in R's sequence
 *      (this scopes overlap to CARD_BLISTER's staging-mediated flow,
 *      matching hardcoded behavior — see route-data.test.ts).
 *
 *  See task-2-report.md for the ambiguous case flagged: BOTTLE-route
 *  PACKAGING overlap-parking (BLISTERED→BOTTLE_STICKER_QUEUE) is
 *  EXCLUDED by the staging-op scope, mirroring hardcoded exactly. */
export function queueKeysForStationKindFromGraph(
  graph: RouteGraph,
  kind: string,
): readonly string[] {
  const pickupStages = STATION_PICKUP_FROM_STAGE[kind];
  if (!pickupStages || pickupStages.length === 0) return [];

  const watched: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      watched.push(key);
    }
  };

  // Ordering rule to match hardcoded: for kinds with a single op, own key
  // comes first. For BOTTLE_CAP_SEAL, hardcoded lists
  //   [BOTTLE_STICKER_QUEUE, BOTTLE_INDUCTION_QUEUE]
  // — peer stage_key precedes own. Hardcoded also lists PACKAGING as
  //   [SEALING_QUEUE, PACKAGING_QUEUE]
  // — overlap-parking precedes own. Emit in this order:
  //   1. Peer stage_keys (order-independent group) from ops in any route.
  //   2. Overlap-parking keys per route.
  //   3. Own stage_key per route.

  const routesWithKind: Array<{
    routeCode: string;
    ownOp: RouteGraphOp;
    ops: readonly RouteGraphOp[];
  }> = [];
  for (const [routeCode, ops] of Object.entries(graph.routes)) {
    for (const op of ops) {
      if (op.allowedStationKind === kind) {
        routesWithKind.push({ routeCode, ownOp: op, ops });
      }
    }
  }

  // 1. Order-independent group: watch the group's CANONICAL entry stage
  //    (the first peer by sequence) — that's where both-eligible bags
  //    park. Non-canonical peers (e.g. BOTTLE_CAP_SEAL) must watch the
  //    canonical entry to see them arrive; the canonical peer's own
  //    stage_key IS the entry, so no extra add is needed for it.
  //    Mirrors floor-event-relevance.ts's asymmetric hardcoded table.
  for (const { ownOp, ops } of routesWithKind) {
    if (!ownOp.orderIndependentGroup) continue;
    const groupPeers = ops
      .filter(
        (o) =>
          o.orderIndependentGroup === ownOp.orderIndependentGroup &&
          o.allowedStationKind !== null,
      )
      .sort((a, b) => a.sequence - b.sequence);
    const canonicalEntry = groupPeers[0]?.stageKey;
    if (canonicalEntry && canonicalEntry !== ownOp.stageKey) {
      push(canonicalEntry);
    }
  }

  // 2. Overlap-parking (per route). Only add when a non-stationed staging
  //    op sits between the upstream queue's op and this kind's op — this
  //    scopes overlap to CARD_BLISTER-style flows and matches hardcoded.
  for (const { routeCode, ownOp, ops } of routesWithKind) {
    for (const stage of pickupStages) {
      if (stage === "STARTED") continue; // STARTED bags aren't in a queue.
      const q = bagStageToQueueStageKey(stage, routeCode);
      if (!q || q === ownOp.stageKey) continue;
      if (!hasStagingOpBetween(ops, q, ownOp.stageKey)) continue;
      push(q);
    }
  }

  // 3. Own stage_key per route.
  for (const { ownOp } of routesWithKind) {
    push(ownOp.stageKey);
  }

  return watched;
}

/** True when a non-stationed staging op sits between the op with
 *  `fromStage` and the op with `toStage` in the sequence chain of `ops`.
 *  Walks `nextStageKey` forward from the from-op; a staging op is any op
 *  with `allowedStationKind === null` (excluding the terminal
 *  FINISHED_GOODS op, which has next=null). */
function hasStagingOpBetween(
  ops: readonly RouteGraphOp[],
  fromStage: string,
  toStage: string,
): boolean {
  const byStage = opsByStageKey(ops);
  const fromOp = byStage.get(fromStage);
  if (!fromOp) return false;
  let current = fromOp.nextStageKey;
  const seen = new Set<string>();
  let sawStaging = false;
  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current === toStage) return sawStaging;
    const nextOp = byStage.get(current);
    if (!nextOp) return false;
    if (nextOp.allowedStationKind === null && nextOp.nextStageKey !== null) {
      sawStaging = true;
    }
    current = nextOp.nextStageKey;
  }
  return false;
}
