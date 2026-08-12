import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickOperationForStationKind } from "./resolve-operation";
import { intentToEventType, buildRecordStageEventInput } from "./advance";
import type { StationRow } from "./record-stage-event";
import { EVENT_STAGE_PREREQ } from "@/lib/production/stage-progression";
import type { RouteOperationView } from "@/lib/production/routes";

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
// The last test asserts this transcription still matches the migration.
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

// The event each station kind fires today, per ALLOWED_EVENTS_BY_KIND in
// lib/production/engine/record-stage-event.ts (moved verbatim from
// app/(floor)/floor/[token]/actions.ts in Task 7) and STAGE_FOR_EVENT in
// lib/projector/index.ts.
const LEGACY_STATION_EVENT: ReadonlyArray<[string, string, string]> = [
  ["BLISTER", "CARD_BLISTER", "BLISTER_COMPLETE"],
  ["SEALING", "CARD_BLISTER", "SEALING_SEGMENT_COMPLETE"],
  ["PACKAGING", "CARD_BLISTER", "PACKAGING_COMPLETE"],
  ["BOTTLE_HANDPACK", "BOTTLE", "BOTTLE_HANDPACK_COMPLETE"],
  ["BOTTLE_STICKER", "BOTTLE", "BOTTLE_STICKER_COMPLETE"],
  ["BOTTLE_CAP_SEAL", "BOTTLE", "BOTTLE_CAP_SEAL_COMPLETE"],
];

const STATION = { id: "s1", label: "Sealing 2", kind: "SEALING" } as StationRow;

describe("engine/legacy parity", () => {
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

  it("the transcribed fixture still matches the migration", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle", "0013_route_operation_compat.sql"),
      "utf8",
    );
    // A guard, not a parser: if someone edits the seeded operations, this
    // fails and forces the fixture above to be re-checked by hand.
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
