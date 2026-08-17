// Station-kind -> workflow-event pin. NOT a parity harness.
//
// WHAT THIS VERIFIES
//   That for each station kind on the seeded routes, the engine's
//   pickOperationForStationKind + intentToEventType pair produces the
//   workflow event that station fires today, and that every such event
//   is known to EVENT_STAGE_PREREQ. It also pins the seeded BOTTLE
//   route's operation ordering against the migration text.
//
// WHAT THIS DOES NOT VERIFY — read this before trusting a green run.
//   - It does NOT compare against the legacy code path. The expected
//     event on the right-hand side of every assertion is a constant
//     typed by hand from ALLOWED_EVENTS_BY_KIND and STAGE_FOR_EVENT. If
//     those tables drift, this file keeps passing.
//   - It does NOT exercise operation sequencing. Every station kind in
//     these fixtures matches exactly one operation, so the sort by
//     `sequence` inside pickOperationForStationKind never breaks a tie.
//     Set every sequence below to 0 and every mapping test still passes.
//   - It does NOT run a database. This repo's suite has none by design
//     (vitest.config.ts); DB behaviour is verified on staging by the
//     checklist at
//     docs/superpowers/plans/2026-08-11-production-engine-p1-staging-smoke.md
//   - The fixture-vs-migration guard is a substring check, not a parser.
//     It catches a renamed or deleted operation code; it does not catch
//     a changed sequence, stage key or allowed station kind.
//
// RESOLVED (P2-BOTTLE-FLEX-1): the BOTTLE route's STICKERING/
// INDUCTION_SEAL ordering conflict pinned in Phase 1 is resolved by
// migration 0071, which sets route_operations.order_independent_group
// = 'BOTTLE_FINISHING' on both operations. See the
// "bottle finishing order-independence" describe block below.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickOperationForStationKind } from "./resolve-operation";
import { intentToEventType, buildRecordStageEventInput } from "./advance";
import type { StationRow } from "./record-stage-event";
import {
  EVENT_STAGE_PREREQ,
  STATION_PICKUP_FROM_STAGE,
} from "@/lib/production/stage-progression";
import { SEEDED_ROUTES_BY_CODE as SEEDED_ROUTES } from "./__fixtures__/seeded-routes";

// P6 Task 3 — the seeded routes fixture is now shared with
// route-data.test.ts + the consumer tests (queue-transitions,
// floor-event-relevance). See lib/production/engine/__fixtures__/
// seeded-routes.ts. The migration-text guard below stays intact.

const MIGRATION_0013 = join(process.cwd(), "drizzle", "0013_route_operation_compat.sql");
const MIGRATION_0074 = join(process.cwd(), "drizzle", "0074_handpack_route_operation.sql");

// Hand-typed from ALLOWED_EVENTS_BY_KIND in
// lib/production/engine/record-stage-event.ts (moved verbatim from
// app/(floor)/floor/[token]/actions.ts in Task 7) and STAGE_FOR_EVENT in
// lib/projector/index.ts. These constants are the weak point named in the
// header: they are a transcription, not a read of the legacy path.
const LEGACY_STATION_EVENT: ReadonlyArray<[string, string, string]> = [
  ["BLISTER", "CARD_BLISTER", "BLISTER_COMPLETE"],
  ["SEALING", "CARD_BLISTER", "SEALING_SEGMENT_COMPLETE"],
  ["PACKAGING", "CARD_BLISTER", "PACKAGING_COMPLETE"],
  ["BOTTLE_HANDPACK", "BOTTLE", "BOTTLE_HANDPACK_COMPLETE"],
  ["BOTTLE_STICKER", "BOTTLE", "BOTTLE_STICKER_COMPLETE"],
  ["BOTTLE_CAP_SEAL", "BOTTLE", "BOTTLE_CAP_SEAL_COMPLETE"],
  // Migration 0074: HANDPACK_BLISTER now has its own real route_operations
  // row (operation code HANDPACK_BLISTER, allowed_station_kind HANDPACK_BLISTER).
  // pickOperationForStationKind resolves directly — no alias, no
  // station-kind override. COMPLETE_EVENT_FOR_OPERATION['HANDPACK_BLISTER']
  // = 'HANDPACK_BLISTER_COMPLETE' without going through BLISTER at all.
  // COMBINED still aliases onto BLISTER; BLISTER_COMPLETE is exactly what
  // ALLOWED_EVENTS_BY_KIND.COMBINED accepts.
  ["HANDPACK_BLISTER", "CARD_BLISTER", "HANDPACK_BLISTER_COMPLETE"],
  ["COMBINED", "CARD_BLISTER", "BLISTER_COMPLETE"],
];

const STATION = { id: "s1", label: "Sealing 2", kind: "SEALING" } as StationRow;

describe("station kind to workflow event mapping", () => {
  it.each(LEGACY_STATION_EVENT)(
    "engine fires the legacy event for a %s station",
    (stationKind, routeCode, expectedEvent) => {
      const ops = SEEDED_ROUTES[routeCode];
      expect(ops).toBeDefined();
      const resolved = pickOperationForStationKind(ops!, stationKind);
      expect(resolved).not.toBeNull();
      expect(
        intentToEventType("COMPLETE", resolved!.operationCode, stationKind),
      ).toBe(expectedEvent);
    },
  );

  it("every event the engine can fire is known to the legacy prereq table", () => {
    for (const [stationKind, routeCode] of LEGACY_STATION_EVENT) {
      const resolved = pickOperationForStationKind(SEEDED_ROUTES[routeCode]!, stationKind);
      const event = intentToEventType("COMPLETE", resolved!.operationCode, stationKind);
      expect(Object.keys(EVENT_STAGE_PREREQ)).toContain(event);
    }
  });

  it("resolves a station kind that appears on two routes without ambiguity", () => {
    // BOTTLE_STICKER performs STICKERING on both BOTTLE and STICKER_ONLY.
    for (const routeCode of ["BOTTLE", "STICKER_ONLY"]) {
      const resolved = pickOperationForStationKind(
        SEEDED_ROUTES[routeCode]!,
        "BOTTLE_STICKER",
      );
      expect(resolved?.operationCode).toBe("STICKERING");
    }
  });

  it("the transcribed fixture still names operations the migration seeds", () => {
    const sql0013 = readFileSync(MIGRATION_0013, "utf8");
    const sql0074 = readFileSync(MIGRATION_0074, "utf8");
    // A guard, not a parser: if someone renames or drops a seeded
    // operation, this fails and forces the fixture to be re-checked by
    // hand. It does NOT notice a changed sequence or stage key.
    // HANDPACK_BLISTER (seq 8) comes from migration 0074; all others from 0013.
    for (const ops of Object.values(SEEDED_ROUTES)) {
      for (const o of ops) {
        const sql = o.operationCode === "HANDPACK_BLISTER" ? sql0074 : sql0013;
        expect(sql).toContain(`'${o.operationCode}'`);
      }
    }
  });

  it("the mapped fields it covers agree with the action's call site", () => {
    // NOT a shape-equality proof. Three limitations, all deliberate —
    // read them before treating a green run as parity:
    //
    //   1. The right-hand side is a hand-typed literal transcribed from
    //      fireStageEventAction, not a value read from the action. If the
    //      action's real call site changes, this keeps passing.
    //   2. The pinned call is a SEALING segment with NO counterPresses —
    //      a shape the action never sends and that recordStageEvent
    //      rejects outright (SEALING_COUNTER_PRESS_ERROR). Since Task 7
    //      the engine CAN carry presses (inputs.counterPresses), so this
    //      is now a deliberately partial input, not an impossible one: it
    //      pins the count routing, not a call that could succeed.
    //      advance.test.ts covers the press passthrough.
    //   3. It iterates Object.keys(viaAction) only, so a field the engine
    //      FAILS to set (and the action does not list here) or an EXTRA
    //      field the engine adds are both invisible to it.
    //
    // The action's own call site, transcribed from
    // app/(floor)/floor/[token]/actions.ts (fireStageEventAction), for a
    // plain sealing segment with no partial-close fields.
    const viaAction = {
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      countTotal: 52,
      packsRemaining: 0,
      cardsReopened: 0,
      clientEventId: "cid-1",
      pickedSealingProductId: null,
    };

    const viaEngine = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counter: 52 },
      clientEventId: "cid-1",
    });

    for (const key of Object.keys(viaAction) as (keyof typeof viaAction)[]) {
      expect(viaEngine[key]).toEqual(viaAction[key]);
    }
  });
});

describe("bottle finishing order-independence (P2-BOTTLE-FLEX-1)", () => {
  it("the seeded BOTTLE route marks stickering and induction seal as one group", () => {
    // Migration 0071 sets order_independent_group = 'BOTTLE_FINISHING'
    // on exactly these two operations. The fixture mirrors the seed;
    // the migration-text guard below keeps the mirror honest.
    const sql = readFileSync(
      join(process.cwd(), "drizzle", "0071_read_bag_queue_and_bottle_flex.sql"),
      "utf8",
    );
    expect(sql).toContain("'BOTTLE_FINISHING'");
    expect(sql).toMatch(/'STICKERING',\s*'INDUCTION_SEAL'/);
  });

  it("code and data now agree: both finishing stations accept both entry stages", () => {
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_CAP_SEAL).toEqual(["BLISTERED", "SEALED"]);
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_STICKER).toEqual(["BLISTERED", "SEALED"]);
  });
});
