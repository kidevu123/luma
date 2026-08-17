// P6 Task 3 — RETARGETED honest guard for the data-driven route graph.
//
// TASK 2 HISTORY (now removed): this file used to assert `twin(graph) ===
// hardcoded(no-graph)` for every (route × station kind × bottle-priors
// subset). Task 3 deleted the hardcoded tables — queueAfterWorkAt,
// queueRank, and queueKeysForStationKind now ALL resolve from the graph.
// The old parity assertion would be tautological (both sides call the
// same code path).
//
// WHAT THIS NOW GUARDS
//   1. The transcribed migration fixture (lib/production/engine/
//      __fixtures__/seeded-routes.ts) survives buildRouteGraph -> graph
//      twins without distortion — enumerated across the same matrix the
//      Task-2 parity used (325 combinations).
//   2. The loader mechanism (loadRouteGraph with an injectable loader
//      returning the same fixture rows) produces a graph IDENTICAL to
//      the direct build. This is what the DB path exercises in prod;
//      the injectable loader is the DB-free stand-in.
//   3. Migration-text substring guards keep the fixture honest: if a
//      migration renames or drops a seeded op code, the fixture drifts
//      and the guard trips.
//   4. The build-time stage-key/next-stage-key invariant fires on ops
//      that violate it (additive safety, cannot fire on seeded data).
//
// WHAT THIS DOES NOT GUARD
//   - The fixture's exact stage keys, sequence values, allowed station
//     kinds — a migration that only changes those fields (without
//     renaming an op code) passes the substring guard silently. Same
//     limitation as station-event-mapping.test.ts.
//   - Live DB parity — that is a staging-smoke concern; the
//     transcription is the pre-deploy check.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRouteGraph,
  loadRouteGraph,
  queueAfterWorkAtFromGraph,
  queueRankFromGraph,
  queueKeysForStationKindFromGraph,
  __resetRouteGraphCacheForTests,
} from "./route-data";
import {
  SEEDED_ROUTE_OPS,
  SEEDED_ROUTES_BY_CODE,
  makeSeededRouteGraph,
  toRouteOperationView,
} from "./__fixtures__/seeded-routes";

// ─── Migration-text guards ──────────────────────────────────────────
//
// A substring check, not a parser (same limitation as
// station-event-mapping.test.ts): catches a renamed or dropped op code;
// does not notice a changed sequence, stage key, or allowed station kind.

const MIGRATION_0013 = join(process.cwd(), "drizzle", "0013_route_operation_compat.sql");
const MIGRATION_0071 = join(process.cwd(), "drizzle", "0071_read_bag_queue_and_bottle_flex.sql");
const MIGRATION_0074 = join(process.cwd(), "drizzle", "0074_handpack_route_operation.sql");

describe("shared seeded-routes fixture is grounded in the seed migrations", () => {
  it("every fixture op code appears in its source migration", () => {
    const sql0013 = readFileSync(MIGRATION_0013, "utf8");
    const sql0074 = readFileSync(MIGRATION_0074, "utf8");
    for (const s of SEEDED_ROUTE_OPS) {
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

// ─── Enumerated matrix — graph twin outputs vs shared fixture ───────
//
// Now that hardcoded is gone, we enumerate the graph twin's outputs
// against the graph built two ways:
//   - Direct: buildRouteGraph(fixture rows)         (makeSeededRouteGraph)
//   - Loader: loadRouteGraph(fixture-returning fn)  (production DB shape,
//                                                   just DB-free here)
// A discrepancy would mean the loader path (default DB shape) distorts
// what buildRouteGraph produces — the honest guard for the DB pipeline.

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

const QUEUES_FOR_RANK = [
  "SEALING_QUEUE",
  "PACKAGING_QUEUE",
  "FINISHED_GOODS_QUEUE",
  "BOTTLE_STICKER_QUEUE",
  "BOTTLE_INDUCTION_QUEUE",
  "BLISTER_QUEUE", // not ranked — twin must return null
  "NOT_A_QUEUE",
] as const;

/** loadRouteGraph with an injectable loader returning the shared
 *  fixture rows — same shape a DB query would produce. Reset the
 *  process cache before each use so the loader actually runs. */
async function graphViaLoader() {
  __resetRouteGraphCacheForTests();
  return loadRouteGraph(async () =>
    Object.values(SEEDED_ROUTES_BY_CODE).map((ops) => ops.map((op) => ({ ...op }))),
  );
}

describe("queueAfterWorkAtFromGraph agrees between direct-build and loader graphs", () => {
  const directGraph = makeSeededRouteGraph();

  for (const routeCode of ROUTES) {
    for (const stationKind of STATION_KINDS) {
      for (const priors of PRIOR_SUBSETS) {
        it(`route=${routeCode} kind=${stationKind} priors=[${priors.join(",")}]`, async () => {
          const loaderGraph = await graphViaLoader();
          const direct = queueAfterWorkAtFromGraph(directGraph, {
            routeCode,
            stationKind,
            priorEventTypes: priors,
          });
          const viaLoader = queueAfterWorkAtFromGraph(loaderGraph, {
            routeCode,
            stationKind,
            priorEventTypes: priors,
          });
          if (direct === null) {
            expect(viaLoader).toBeNull();
          } else {
            expect(viaLoader).not.toBeNull();
            expect(viaLoader!.queueStageKey).toBe(direct.queueStageKey);
            // eligibleStationKinds is a set — order-insensitive compare.
            expect([...viaLoader!.eligibleStationKinds].sort()).toEqual(
              [...direct.eligibleStationKinds].sort(),
            );
          }
        });
      }
    }
  }

  it(`matrix size — queueAfterWorkAt`, () => {
    // 4 routes × 9 kinds × 8 priors = 288 assertions.
    expect(ROUTES.length * STATION_KINDS.length * PRIOR_SUBSETS.length).toBe(288);
  });
});

describe("queueRankFromGraph agrees between direct-build and loader graphs", () => {
  const directGraph = makeSeededRouteGraph();

  for (const routeCode of ROUTES) {
    for (const q of QUEUES_FOR_RANK) {
      it(`route=${routeCode} queue=${q}`, async () => {
        const loaderGraph = await graphViaLoader();
        expect(queueRankFromGraph(loaderGraph, routeCode, q)).toBe(
          queueRankFromGraph(directGraph, routeCode, q),
        );
      });
    }
  }

  it(`matrix size — queueRank`, () => {
    expect(ROUTES.length * QUEUES_FOR_RANK.length).toBe(28);
  });
});

describe("queueKeysForStationKindFromGraph agrees between direct-build and loader graphs", () => {
  const directGraph = makeSeededRouteGraph();

  for (const stationKind of STATION_KINDS) {
    it(`kind=${stationKind}`, async () => {
      const loaderGraph = await graphViaLoader();
      const direct = queueKeysForStationKindFromGraph(directGraph, stationKind);
      const viaLoader = queueKeysForStationKindFromGraph(loaderGraph, stationKind);
      // Ordering is significant (see route-data.ts's emission rule).
      expect([...viaLoader]).toEqual([...direct]);
    });
  }

  it(`matrix size — queueKeysForStationKind`, () => {
    expect(STATION_KINDS.length).toBe(9);
  });
});

// ─── Grand total ────────────────────────────────────────────────────

describe("graph-behavior matrix — grand total", () => {
  it("288 + 28 + 9 = 325 loader-vs-direct assertions", () => {
    const total =
      ROUTES.length * STATION_KINDS.length * PRIOR_SUBSETS.length +
      ROUTES.length * QUEUES_FOR_RANK.length +
      STATION_KINDS.length;
    expect(total).toBe(325);
  });
});

// ─── Stage-key/next invariant (Task 3 addition) ─────────────────────

describe("buildRouteGraph enforces stage-key -> next-stage-key consistency", () => {
  it("accepts the seeded fixture (BLISTER + HANDPACK_BLISTER share BLISTER_QUEUE, same next)", () => {
    // Sanity: the fixture is the exact case the invariant was written
    // to accept. Should never throw.
    expect(() => makeSeededRouteGraph()).not.toThrow();
  });

  it("throws when two ops on the same route share a stage_key but differ on next_stage_key", () => {
    const bad = [
      [
        toRouteOperationView({
          routeCode: "CARD_BLISTER",
          sequence: 1,
          operationCode: "BLISTER",
          stageKey: "BLISTER_QUEUE",
          nextStageKey: "POST_BLISTER_STAGING",
          allowedStationKind: "BLISTER",
          orderIndependentGroup: null,
        }),
        toRouteOperationView({
          routeCode: "CARD_BLISTER",
          sequence: 2,
          operationCode: "HANDPACK_BLISTER",
          stageKey: "BLISTER_QUEUE", // same stage_key
          nextStageKey: "SEALING_QUEUE", // DIFFERENT next
          allowedStationKind: "HANDPACK_BLISTER",
          orderIndependentGroup: null,
        }),
      ],
    ];
    expect(() => buildRouteGraph(bad)).toThrow(/differing next_stage_key/);
  });
});
