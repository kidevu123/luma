// P6 Task 2 — exhaustive parity pins for the data-driven route twins.
//
// This is the CORE parity guard: for every (route × station kind ×
// bottle-priors subset), the three twins must produce IDENTICAL output
// to the hardcoded functions in queue-transitions.ts and
// floor-event-relevance.ts. Task 3 relies on this to delete the
// hardcoded tables safely.
//
// The RouteGraph is built from a fixture transcribed from migrations
// 0013 + 0071 + 0074 — same substring guard pattern as
// station-event-mapping.test.ts. No DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  queueAfterWorkAt,
  queueRank,
} from "./queue-transitions";
import { queueKeysForStationKind } from "./floor-event-relevance";
import {
  buildRouteGraph,
  queueAfterWorkAtFromGraph,
  queueRankFromGraph,
  queueKeysForStationKindFromGraph,
} from "./route-data";
import type { RouteOperationView } from "@/lib/production/routes";

// ─── Fixture: transcribed from migrations 0013 + 0071 + 0074 ────────
//
// Field order matches drizzle/0013_route_operation_compat.sql
// (VALUES rows starting at line 173) and drizzle/0074_handpack_route_operation.sql.
// The BOTTLE route's order_independent_group column is set by
// drizzle/0071_read_bag_queue_and_bottle_flex.sql (BOTTLE_FINISHING on
// STICKERING + INDUCTION_SEAL).

type Seed = {
  routeCode: string;
  sequence: number;
  operationCode: string;
  stageKey: string;
  nextStageKey: string | null;
  allowedStationKind: string | null;
  orderIndependentGroup: string | null;
};

const SEED: readonly Seed[] = [
  // CARD_BLISTER (0013 lines 173-179)
  { routeCode: "CARD_BLISTER", sequence: 1, operationCode: "RECEIVING",           stageKey: "RECEIVING_QUEUE",       nextStageKey: "BLISTER_QUEUE",        allowedStationKind: null,         orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 2, operationCode: "BLISTER",             stageKey: "BLISTER_QUEUE",         nextStageKey: "POST_BLISTER_STAGING", allowedStationKind: "BLISTER",    orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 3, operationCode: "POST_BLISTER_STAGING", stageKey: "POST_BLISTER_STAGING",  nextStageKey: "SEALING_QUEUE",        allowedStationKind: null,         orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 4, operationCode: "HEAT_SEAL",           stageKey: "SEALING_QUEUE",         nextStageKey: "POST_SEAL_STAGING",    allowedStationKind: "SEALING",    orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 5, operationCode: "POST_SEAL_STAGING",   stageKey: "POST_SEAL_STAGING",     nextStageKey: "PACKAGING_QUEUE",      allowedStationKind: null,         orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 6, operationCode: "PACKAGING",           stageKey: "PACKAGING_QUEUE",       nextStageKey: "FINISHED_GOODS_QUEUE", allowedStationKind: "PACKAGING",  orderIndependentGroup: null },
  { routeCode: "CARD_BLISTER", sequence: 7, operationCode: "FINISHED_GOODS",      stageKey: "FINISHED_GOODS_QUEUE",  nextStageKey: null,                    allowedStationKind: null,         orderIndependentGroup: null },
  // 0074: HANDPACK_BLISTER row on CARD_BLISTER (seq 8), same stage/next as BLISTER.
  { routeCode: "CARD_BLISTER", sequence: 8, operationCode: "HANDPACK_BLISTER",    stageKey: "BLISTER_QUEUE",         nextStageKey: "POST_BLISTER_STAGING", allowedStationKind: "HANDPACK_BLISTER", orderIndependentGroup: null },

  // BOTTLE (0013 lines 191-196)
  { routeCode: "BOTTLE", sequence: 1, operationCode: "RECEIVING",       stageKey: "RECEIVING_QUEUE",     nextStageKey: "BOTTLE_FILL_QUEUE",      allowedStationKind: null,               orderIndependentGroup: null },
  { routeCode: "BOTTLE", sequence: 2, operationCode: "BOTTLE_FILL",     stageKey: "BOTTLE_FILL_QUEUE",   nextStageKey: "BOTTLE_STICKER_QUEUE",   allowedStationKind: "BOTTLE_HANDPACK",  orderIndependentGroup: null },
  // 0071: STICKERING + INDUCTION_SEAL get order_independent_group='BOTTLE_FINISHING'.
  { routeCode: "BOTTLE", sequence: 3, operationCode: "STICKERING",      stageKey: "BOTTLE_STICKER_QUEUE",   nextStageKey: "BOTTLE_INDUCTION_QUEUE", allowedStationKind: "BOTTLE_STICKER",   orderIndependentGroup: "BOTTLE_FINISHING" },
  { routeCode: "BOTTLE", sequence: 4, operationCode: "INDUCTION_SEAL",  stageKey: "BOTTLE_INDUCTION_QUEUE", nextStageKey: "PACKAGING_QUEUE",        allowedStationKind: "BOTTLE_CAP_SEAL",  orderIndependentGroup: "BOTTLE_FINISHING" },
  { routeCode: "BOTTLE", sequence: 5, operationCode: "PACKAGING",       stageKey: "PACKAGING_QUEUE",     nextStageKey: "FINISHED_GOODS_QUEUE",   allowedStationKind: "PACKAGING",        orderIndependentGroup: null },
  { routeCode: "BOTTLE", sequence: 6, operationCode: "FINISHED_GOODS",  stageKey: "FINISHED_GOODS_QUEUE", nextStageKey: null,                    allowedStationKind: null,               orderIndependentGroup: null },

  // STICKER_ONLY (0013 lines 208-211)
  { routeCode: "STICKER_ONLY", sequence: 1, operationCode: "RECEIVING",       stageKey: "RECEIVING_QUEUE",       nextStageKey: "BOTTLE_STICKER_QUEUE", allowedStationKind: null,             orderIndependentGroup: null },
  { routeCode: "STICKER_ONLY", sequence: 2, operationCode: "STICKERING",      stageKey: "BOTTLE_STICKER_QUEUE",  nextStageKey: "PACKAGING_QUEUE",      allowedStationKind: "BOTTLE_STICKER", orderIndependentGroup: null },
  { routeCode: "STICKER_ONLY", sequence: 3, operationCode: "PACKAGING",       stageKey: "PACKAGING_QUEUE",       nextStageKey: "FINISHED_GOODS_QUEUE", allowedStationKind: "PACKAGING",      orderIndependentGroup: null },
  { routeCode: "STICKER_ONLY", sequence: 4, operationCode: "FINISHED_GOODS",  stageKey: "FINISHED_GOODS_QUEUE",  nextStageKey: null,                    allowedStationKind: null,             orderIndependentGroup: null },
];

function toRouteOperationView(s: Seed): RouteOperationView {
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

function makeGraph(): ReturnType<typeof buildRouteGraph> {
  const perRoute = new Map<string, RouteOperationView[]>();
  for (const s of SEED) {
    const bucket = perRoute.get(s.routeCode) ?? [];
    bucket.push(toRouteOperationView(s));
    perRoute.set(s.routeCode, bucket);
  }
  return buildRouteGraph(Array.from(perRoute.values()));
}

// ─── Migration-text guards ──────────────────────────────────────────
//
// A substring check, not a parser (same limitation as
// station-event-mapping.test.ts): catches a renamed or dropped op code;
// does not notice a changed sequence, stage key, or allowed station kind.

const MIGRATION_0013 = join(process.cwd(), "drizzle", "0013_route_operation_compat.sql");
const MIGRATION_0071 = join(process.cwd(), "drizzle", "0071_read_bag_queue_and_bottle_flex.sql");
const MIGRATION_0074 = join(process.cwd(), "drizzle", "0074_handpack_route_operation.sql");

describe("route-data fixture is grounded in the seed migrations", () => {
  it("every SEED op code appears in its source migration", () => {
    const sql0013 = readFileSync(MIGRATION_0013, "utf8");
    const sql0074 = readFileSync(MIGRATION_0074, "utf8");
    for (const s of SEED) {
      const sql = s.operationCode === "HANDPACK_BLISTER" ? sql0074 : sql0013;
      expect(sql).toContain(`'${s.operationCode}'`);
    }
  });

  it("the BOTTLE_FINISHING group name is set in migration 0071", () => {
    const sql = readFileSync(MIGRATION_0071, "utf8");
    expect(sql).toContain("'BOTTLE_FINISHING'");
    expect(sql).toMatch(/'STICKERING',\s*'INDUCTION_SEAL'/);
  });
});

// ─── Enumerated parity matrix ───────────────────────────────────────
//
// Routes × station kinds × bottle-priors powerset.
// Station kinds include HANDPACK_BLISTER (post-0074), COMBINED (no
// op — must return null/[]), and an unknown kind ("NOT_A_KIND").

const ROUTES = ["CARD_BLISTER", "BOTTLE", "STICKER_ONLY", "NOT_A_ROUTE"] as const;

const STATION_KINDS = [
  "BLISTER",
  "HANDPACK_BLISTER",
  "SEALING",
  "PACKAGING",
  "BOTTLE_HANDPACK",
  "BOTTLE_STICKER",
  "BOTTLE_CAP_SEAL",
  "COMBINED",
  "NOT_A_KIND",
] as const;

// Bottle-priors powerset. Every parity assertion is repeated for each
// subset; non-bottle stations are unaffected but we still enumerate to
// catch any accidental prior-dependence in card / sticker-only kinds.
// Plus the "BOTTLE_HANDPACK_COMPLETE only" baseline (fill has run,
// finishing has not) so the both-eligible narrowing is exercised.
const PRIOR_SUBSETS: ReadonlyArray<readonly string[]> = [
  [],
  ["BOTTLE_STICKER_COMPLETE"],
  ["BOTTLE_CAP_SEAL_COMPLETE"],
  ["BOTTLE_STICKER_COMPLETE", "BOTTLE_CAP_SEAL_COMPLETE"],
  ["BOTTLE_HANDPACK_COMPLETE"],
  ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_STICKER_COMPLETE"],
  ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_CAP_SEAL_COMPLETE"],
  [
    "BOTTLE_HANDPACK_COMPLETE",
    "BOTTLE_STICKER_COMPLETE",
    "BOTTLE_CAP_SEAL_COMPLETE",
  ],
];

// Queues to rank-check. Includes every queue key referenced by
// QUEUE_RANK in queue-transitions.ts plus an unknown queue.
const QUEUES_FOR_RANK = [
  "SEALING_QUEUE",
  "PACKAGING_QUEUE",
  "FINISHED_GOODS_QUEUE",
  "BOTTLE_STICKER_QUEUE",
  "BOTTLE_INDUCTION_QUEUE",
  "BLISTER_QUEUE", // not ranked — twin must return null
  "NOT_A_QUEUE",
] as const;

describe("queueAfterWorkAtFromGraph is a parity twin", () => {
  const graph = makeGraph();
  let asserted = 0;

  for (const routeCode of ROUTES) {
    for (const stationKind of STATION_KINDS) {
      for (const priors of PRIOR_SUBSETS) {
        it(`route=${routeCode} kind=${stationKind} priors=[${priors.join(",")}]`, () => {
          const hardcoded = queueAfterWorkAt({
            routeCode,
            stationKind,
            priorEventTypes: priors,
          });
          const twin = queueAfterWorkAtFromGraph(graph, {
            routeCode,
            stationKind,
            priorEventTypes: priors,
          });
          if (hardcoded === null) {
            expect(twin).toBeNull();
          } else {
            expect(twin).not.toBeNull();
            expect(twin!.queueStageKey).toBe(hardcoded.queueStageKey);
            // eligibleStationKinds is a set — order-insensitive compare.
            expect([...twin!.eligibleStationKinds].sort()).toEqual(
              [...hardcoded.eligibleStationKinds].sort(),
            );
          }
          asserted++;
        });
      }
    }
  }

  it(`matrix size — queueAfterWorkAt`, () => {
    // 4 routes × 9 kinds × 8 priors = 288 assertions.
    expect(ROUTES.length * STATION_KINDS.length * PRIOR_SUBSETS.length).toBe(288);
  });
});

describe("queueRankFromGraph is a parity twin", () => {
  const graph = makeGraph();

  for (const routeCode of ROUTES) {
    for (const q of QUEUES_FOR_RANK) {
      it(`route=${routeCode} queue=${q}`, () => {
        expect(queueRankFromGraph(graph, routeCode, q)).toBe(
          queueRank(routeCode, q),
        );
      });
    }
  }

  it(`matrix size — queueRank`, () => {
    expect(ROUTES.length * QUEUES_FOR_RANK.length).toBe(28);
  });
});

describe("queueKeysForStationKindFromGraph is a parity twin", () => {
  const graph = makeGraph();

  for (const stationKind of STATION_KINDS) {
    it(`kind=${stationKind}`, () => {
      const twin = queueKeysForStationKindFromGraph(graph, stationKind);
      const hardcoded = queueKeysForStationKind(stationKind);
      // Order matters for hardcoded — the twin must produce the same
      // ordering (see comment in route-data.ts for the emission order rule).
      expect([...twin]).toEqual([...hardcoded]);
    });
  }

  it(`matrix size — queueKeysForStationKind`, () => {
    expect(STATION_KINDS.length).toBe(9);
  });
});

// ─── Grand total ────────────────────────────────────────────────────

describe("parity matrix — grand total", () => {
  it("288 + 28 + 9 = 325 twin-vs-hardcoded assertions", () => {
    const total =
      ROUTES.length * STATION_KINDS.length * PRIOR_SUBSETS.length +
      ROUTES.length * QUEUES_FOR_RANK.length +
      STATION_KINDS.length;
    expect(total).toBe(325);
  });
});
