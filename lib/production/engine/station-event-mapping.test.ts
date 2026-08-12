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
//     a changed sequence, stage key or allowed station kind, except on
//     the BOTTLE rows explicitly pinned by the divergence test below.

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
import type { RouteOperationView } from "@/lib/production/routes";

const MIGRATION = join(process.cwd(), "drizzle", "0013_route_operation_compat.sql");

function op(
  sequence: number,
  operationCode: string,
  allowedStationKind: string | null,
): RouteOperationView {
  return {
    routeCode: "FIXTURE",
    routeName: "Fixture",
    sequence,
    operationCode,
    operationName: operationCode,
    stageKey: "FIXTURE_QUEUE",
    nextStageKey: null,
    reworkStageKey: null,
    allowedStationKind,
    allowedMachineKind: allowedStationKind,
    requiresScan: true,
    requiresCounter: true,
    requiresTimer: false,
    outputUnit: "cards",
  };
}

// Transcribed from drizzle/0013_route_operation_compat.sql:168-215.
// Note the stage keys are NOT transcribed — op() stubs them — so any
// assertion about the stage chain must read the migration text instead.
const SEEDED_ROUTES: Readonly<Record<string, RouteOperationView[]>> = {
  CARD_BLISTER: [
    op(1, "RECEIVING", null),
    op(2, "BLISTER", "BLISTER"),
    op(3, "POST_BLISTER_STAGING", null),
    op(4, "HEAT_SEAL", "SEALING"),
    op(5, "POST_SEAL_STAGING", null),
    op(6, "PACKAGING", "PACKAGING"),
    op(7, "FINISHED_GOODS", null),
  ],
  BOTTLE: [
    op(1, "RECEIVING", null),
    op(2, "BOTTLE_FILL", "BOTTLE_HANDPACK"),
    op(3, "STICKERING", "BOTTLE_STICKER"),
    op(4, "INDUCTION_SEAL", "BOTTLE_CAP_SEAL"),
    op(5, "PACKAGING", "PACKAGING"),
    op(6, "FINISHED_GOODS", null),
  ],
  STICKER_ONLY: [
    op(1, "RECEIVING", null),
    op(2, "STICKERING", "BOTTLE_STICKER"),
    op(3, "PACKAGING", "PACKAGING"),
    op(4, "FINISHED_GOODS", null),
  ],
};

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
      expect(intentToEventType("COMPLETE", resolved!.operationCode)).toBe(expectedEvent);
    },
  );

  it("every event the engine can fire is known to the legacy prereq table", () => {
    for (const [stationKind, routeCode] of LEGACY_STATION_EVENT) {
      const resolved = pickOperationForStationKind(SEEDED_ROUTES[routeCode]!, stationKind);
      const event = intentToEventType("COMPLETE", resolved!.operationCode);
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
    const sql = readFileSync(MIGRATION, "utf8");
    // A guard, not a parser: if someone renames or drops a seeded
    // operation, this fails and forces the fixture to be re-checked by
    // hand. It does NOT notice a changed sequence or stage key.
    for (const ops of Object.values(SEEDED_ROUTES)) {
      for (const o of ops) {
        expect(sql).toContain(`'${o.operationCode}'`);
      }
    }
  });

  it("the engine hands recordStageEvent the same shape the action does", () => {
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

// KNOWN DIVERGENCE — BOTTLE finishing order. Phase 2 must resolve this
// and DELETE this test.
//
// Two sources of truth disagree about whether stickering and induction
// sealing may run in either order:
//
//   route_operations (drizzle/0013) says ORDERED. STICKERING is
//   sequence 3 and hands off to BOTTLE_INDUCTION_QUEUE, which is
//   exactly INDUCTION_SEAL's stage_key at sequence 4. A bag cannot
//   reach induction seal without passing through stickering.
//
//   stage-progression.ts says INTERCHANGEABLE (BOTTLE-ORDER-FLEX-1).
//   Both BOTTLE_CAP_SEAL and BOTTLE_STICKER accept a bag from the same
//   two stages, and EVENT_STAGE_PREREQ lets either event fire first.
//   "Exactly once each" is enforced separately by
//   bottleFinishingAlreadyFired, not by ordering.
//
// This test PASSES on purpose: it pins the contradiction so it cannot be
// silently resolved in one place and not the other. Nothing in Phase 1
// exercises the route's stage chain, so no other test would notice.
describe("KNOWN DIVERGENCE: BOTTLE finishing order (Phase 2 must resolve)", () => {
  it("route data orders STICKERING strictly before INDUCTION_SEAL", () => {
    const bottle = SEEDED_ROUTES.BOTTLE!;
    const stickering = bottle.find((o) => o.operationCode === "STICKERING");
    const induction = bottle.find((o) => o.operationCode === "INDUCTION_SEAL");
    expect(stickering?.sequence).toBe(3);
    expect(induction?.sequence).toBe(4);
    expect(stickering!.sequence).toBeLessThan(induction!.sequence);

    // The fixture stubs stage keys, so the hand-off chain is read from
    // the migration itself: STICKERING's next_stage_key is exactly
    // INDUCTION_SEAL's stage_key.
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(
      /\(3,\s*'STICKERING',\s*'BOTTLE_STICKER_QUEUE',\s*'BOTTLE_INDUCTION_QUEUE',\s*'BOTTLE_STICKER'/,
    );
    expect(sql).toMatch(
      /\(4,\s*'INDUCTION_SEAL',\s*'BOTTLE_INDUCTION_QUEUE',\s*'PACKAGING_QUEUE',\s*'BOTTLE_CAP_SEAL'/,
    );
  });

  it("stage-progression treats the same two stations as interchangeable", () => {
    // Same accepted stages for both stations means neither is gated on
    // the other having run first — the opposite of the route chain above.
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_STICKER).toEqual(["BLISTERED", "SEALED"]);
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_CAP_SEAL).toEqual(["BLISTERED", "SEALED"]);
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_CAP_SEAL).toEqual(
      STATION_PICKUP_FROM_STAGE.BOTTLE_STICKER,
    );

    // And either completion event may fire from either stage.
    expect(EVENT_STAGE_PREREQ.BOTTLE_STICKER_COMPLETE).toEqual(["BLISTERED", "SEALED"]);
    expect(EVENT_STAGE_PREREQ.BOTTLE_CAP_SEAL_COMPLETE).toEqual(["BLISTERED", "SEALED"]);
  });
});
