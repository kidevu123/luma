import { describe, it, expect } from "vitest";
import {
  EVENT_STAGE_PREREQ,
  STATION_RELEASE_FROM_STAGE,
  STATION_PICKUP_FROM_STAGE,
  STATION_STARTED_RESUME_FROM_STAGE,
  STATIONS_THAT_FINALIZE,
  BOTTLE_FINISHING_EVENTS,
  isBottleFinishingEvent,
  bottleFinishingAlreadyFired,
  bothBottleFinishingDone,
  missingBottleFinishingSteps,
  checkStageProgression,
  formatFloorStationBagOpenError,
} from "./stage-progression";

describe("stage progression — duplicate BLISTER_COMPLETE prevention", () => {
  it("allows BLISTER_COMPLETE when bag is at STARTED", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: "STARTED",
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects a SECOND BLISTER_COMPLETE when bag is already BLISTERED (the bug we're fixing)", () => {
    const r = checkStageProgression({
      eventType: "BLISTER_COMPLETE",
      currentStage: "BLISTERED",
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toMatch(/BLISTERED/);
      expect(r.reason).toMatch(/BLISTER_COMPLETE/);
    }
  });

  it("rejects BLISTER_COMPLETE when bag is SEALED", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: "SEALED",
      }).allowed,
    ).toBe(false);
  });

  it("rejects BLISTER_COMPLETE when bag is PACKAGED", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: "PACKAGED",
      }).allowed,
    ).toBe(false);
  });

  it("rejects ANY stage event when bag is finalized", () => {
    for (const eventType of Object.keys(EVENT_STAGE_PREREQ)) {
      const r = checkStageProgression({
        eventType,
        currentStage: "FINALIZED",
        isFinalized: true,
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toMatch(/finalized/);
    }
  });

  it("rejects forward stage events when bag is paused", () => {
    const r = checkStageProgression({
      eventType: "BLISTER_COMPLETE",
      currentStage: "STARTED",
      isPaused: true,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/paused/);
  });
});

describe("STATION_STARTED_RESUME_FROM_STAGE", () => {
  it("BLISTER can resume STARTED bags at same station", () => {
    expect(STATION_STARTED_RESUME_FROM_STAGE.BLISTER).toContain("STARTED");
    expect(STATION_PICKUP_FROM_STAGE.BLISTER).toBeUndefined();
  });
});

describe("formatFloorStationBagOpenError", () => {
  it("never returns developer pickup-stage text", () => {
    const msg = formatFloorStationBagOpenError({
      stationKind: "BLISTER",
      bagStage: "STARTED",
      pickupStages: [],
    });
    expect(msg).not.toMatch(/no pickup stages defined/i);
    expect(msg).toMatch(/not ready for this station/i);
  });
});

describe("stage progression — full forward pipeline", () => {
  const cases: Array<[string, string, boolean]> = [
    // [event, currentStage, allowed]
    ["BLISTER_COMPLETE", "STARTED", true],
    ["BLISTER_COMPLETE", "BLISTERED", false],
    ["BLISTER_COMPLETE", "SEALED", false],
    ["SEALING_COMPLETE", "BLISTERED", true],
    ["SEALING_COMPLETE", "STARTED", false],
    ["SEALING_COMPLETE", "SEALED", false],
    ["PACKAGING_SNAPSHOT", "SEALED", true],
    ["PACKAGING_SNAPSHOT", "BLISTERED", false],
    ["PACKAGING_SNAPSHOT", "PACKAGED", false],
    ["PACKAGING_COMPLETE", "SEALED", true],
    ["PACKAGING_COMPLETE", "PACKAGED", false],
    ["BOTTLE_HANDPACK_COMPLETE", "STARTED", true],
    ["BOTTLE_HANDPACK_COMPLETE", "BLISTERED", false],
    // BOTTLE-ORDER-FLEX-1: cap-seal and sticker run in either order after
    // fill (BLISTERED). The first runs from BLISTERED, the second from
    // SEALED. Both stage prereqs therefore accept BLISTERED *or* SEALED.
    ["BOTTLE_CAP_SEAL_COMPLETE", "BLISTERED", true],
    ["BOTTLE_CAP_SEAL_COMPLETE", "SEALED", true],
    ["BOTTLE_CAP_SEAL_COMPLETE", "STARTED", false],
    ["BOTTLE_CAP_SEAL_COMPLETE", "PACKAGED", false],
    ["BOTTLE_STICKER_COMPLETE", "BLISTERED", true],
    ["BOTTLE_STICKER_COMPLETE", "SEALED", true],
    ["BOTTLE_STICKER_COMPLETE", "STARTED", false],
    ["BOTTLE_STICKER_COMPLETE", "PACKAGED", false],
  ];
  for (const [eventType, stage, allowed] of cases) {
    it(`${eventType} from ${stage} → ${allowed ? "allowed" : "rejected"}`, () => {
      expect(
        checkStageProgression({ eventType, currentStage: stage }).allowed,
      ).toBe(allowed);
    });
  }
});

describe("stage progression — read-model lag", () => {
  it("permits the event when currentStage is null (server re-reads)", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: null,
      }).allowed,
    ).toBe(true);
  });
});

describe("stage progression — non-progression events", () => {
  it("does not gate CARD_ASSIGNED or pause/resume events", () => {
    for (const eventType of [
      "CARD_ASSIGNED",
      "BAG_PAUSED",
      "BAG_RESUMED",
      "OPERATOR_CHANGE",
      "BAG_FINALIZED",
      "BAG_RELEASED",
      "BAG_PICKED_UP",
    ]) {
      expect(
        checkStageProgression({ eventType, currentStage: "BLISTERED" }).allowed,
      ).toBe(true);
    }
  });
});

describe("station release / finalize policy", () => {
  it("BLISTER station releases at BLISTERED, never finalizes", () => {
    expect(STATION_RELEASE_FROM_STAGE.BLISTER).toBe("BLISTERED");
    expect(STATIONS_THAT_FINALIZE.has("BLISTER")).toBe(false);
  });

  it("SEALING station releases at SEALED, never finalizes", () => {
    expect(STATION_RELEASE_FROM_STAGE.SEALING).toBe("SEALED");
    expect(STATIONS_THAT_FINALIZE.has("SEALING")).toBe(false);
  });

  it("PACKAGING station finalizes, does NOT release forward", () => {
    expect(STATION_RELEASE_FROM_STAGE.PACKAGING).toBeUndefined();
    expect(STATIONS_THAT_FINALIZE.has("PACKAGING")).toBe(true);
  });

  it("COMBINED station finalizes (it does the whole pipeline in one place)", () => {
    expect(STATIONS_THAT_FINALIZE.has("COMBINED")).toBe(true);
  });

  it("Bottle pipeline: HANDPACK + CAP_SEAL + STICKER all release forward; only PACKAGING finalizes", () => {
    // BOTTLE-ORDER-FLEX-1: the bottle route is now
    // fill → (cap-seal | sticker, either order) → packaging. Both
    // finishing stations release the bag forward (at SEALED) so the
    // Packaging station is always the terminal finalize step — matching
    // the card route. Sticker no longer finalizes.
    expect(STATION_RELEASE_FROM_STAGE.BOTTLE_HANDPACK).toBe("BLISTERED");
    expect(STATION_RELEASE_FROM_STAGE.BOTTLE_CAP_SEAL).toBe("SEALED");
    expect(STATION_RELEASE_FROM_STAGE.BOTTLE_STICKER).toBe("SEALED");
    expect(STATIONS_THAT_FINALIZE.has("BOTTLE_STICKER")).toBe(false);
    expect(STATIONS_THAT_FINALIZE.has("PACKAGING")).toBe(true);
  });
});

describe("BOTTLE-ORDER-FLEX-1 — cap-seal and sticker run in either order", () => {
  it("both finishing stations can pick up a freshly-filled bag (BLISTERED) or a half-finished one (SEALED)", () => {
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_CAP_SEAL).toEqual([
      "BLISTERED",
      "SEALED",
    ]);
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_STICKER).toEqual([
      "BLISTERED",
      "SEALED",
    ]);
  });

  it("BOTTLE_FINISHING_EVENTS is exactly cap-seal + sticker", () => {
    expect([...BOTTLE_FINISHING_EVENTS]).toEqual([
      "BOTTLE_CAP_SEAL_COMPLETE",
      "BOTTLE_STICKER_COMPLETE",
    ]);
  });

  it("isBottleFinishingEvent only matches the two finishing events", () => {
    expect(isBottleFinishingEvent("BOTTLE_CAP_SEAL_COMPLETE")).toBe(true);
    expect(isBottleFinishingEvent("BOTTLE_STICKER_COMPLETE")).toBe(true);
    expect(isBottleFinishingEvent("BOTTLE_HANDPACK_COMPLETE")).toBe(false);
    expect(isBottleFinishingEvent("SEALING_COMPLETE")).toBe(false);
  });

  it("bottleFinishingAlreadyFired blocks a SECOND cap-seal or sticker on the same bag", () => {
    // Sticker already done; trying to sticker again is rejected even
    // though the bag sits at SEALED (which the stage prereq allows).
    expect(
      bottleFinishingAlreadyFired("BOTTLE_STICKER_COMPLETE", [
        "BOTTLE_HANDPACK_COMPLETE",
        "BOTTLE_STICKER_COMPLETE",
      ]),
    ).toBe(true);
    // Cap-seal not yet done → allowed.
    expect(
      bottleFinishingAlreadyFired("BOTTLE_CAP_SEAL_COMPLETE", [
        "BOTTLE_HANDPACK_COMPLETE",
        "BOTTLE_STICKER_COMPLETE",
      ]),
    ).toBe(false);
    // Non-finishing events are never blocked by this guard.
    expect(
      bottleFinishingAlreadyFired("BOTTLE_HANDPACK_COMPLETE", [
        "BOTTLE_HANDPACK_COMPLETE",
      ]),
    ).toBe(false);
  });

  it("bothBottleFinishingDone is true only when BOTH cap-seal and sticker fired", () => {
    expect(bothBottleFinishingDone(["BOTTLE_HANDPACK_COMPLETE"])).toBe(false);
    expect(
      bothBottleFinishingDone([
        "BOTTLE_HANDPACK_COMPLETE",
        "BOTTLE_STICKER_COMPLETE",
      ]),
    ).toBe(false);
    expect(
      bothBottleFinishingDone([
        "BOTTLE_HANDPACK_COMPLETE",
        "BOTTLE_CAP_SEAL_COMPLETE",
        "BOTTLE_STICKER_COMPLETE",
      ]),
    ).toBe(true);
  });

  it("missingBottleFinishingSteps lists operator-facing labels for what's left", () => {
    expect(missingBottleFinishingSteps(["BOTTLE_HANDPACK_COMPLETE"])).toEqual([
      "cap-sealing",
      "stickering",
    ]);
    expect(
      missingBottleFinishingSteps([
        "BOTTLE_HANDPACK_COMPLETE",
        "BOTTLE_CAP_SEAL_COMPLETE",
      ]),
    ).toEqual(["stickering"]);
    expect(
      missingBottleFinishingSteps([
        "BOTTLE_CAP_SEAL_COMPLETE",
        "BOTTLE_STICKER_COMPLETE",
      ]),
    ).toEqual([]);
  });

  it("end-to-end stage prereqs allow sticker-first AND seal-first orders", () => {
    // Sticker-first: fill(BLISTERED) → sticker → seal.
    expect(
      checkStageProgression({
        eventType: "BOTTLE_STICKER_COMPLETE",
        currentStage: "BLISTERED",
      }).allowed,
    ).toBe(true);
    expect(
      checkStageProgression({
        eventType: "BOTTLE_CAP_SEAL_COMPLETE",
        currentStage: "SEALED",
      }).allowed,
    ).toBe(true);
    // Seal-first: fill(BLISTERED) → seal → sticker.
    expect(
      checkStageProgression({
        eventType: "BOTTLE_CAP_SEAL_COMPLETE",
        currentStage: "BLISTERED",
      }).allowed,
    ).toBe(true);
    expect(
      checkStageProgression({
        eventType: "BOTTLE_STICKER_COMPLETE",
        currentStage: "SEALED",
      }).allowed,
    ).toBe(true);
  });
});

describe("station pickup eligibility — same QR scanned downstream", () => {
  it("SEALING picks up bags at BLISTERED (sealed expected to fire next)", () => {
    expect(STATION_PICKUP_FROM_STAGE.SEALING).toContain("BLISTERED");
  });

  it("SEALING also picks up bags at STARTED (overlap scan — blister still running)", () => {
    expect(STATION_PICKUP_FROM_STAGE.SEALING).toContain("STARTED");
  });

  it("SEALING_COMPLETE still requires BLISTERED even though pickup allows STARTED", () => {
    expect(
      checkStageProgression({ eventType: "SEALING_COMPLETE", currentStage: "STARTED" }).allowed,
    ).toBe(false);
  });

  it("SEALING_COMPLETE still allowed from BLISTERED (unchanged)", () => {
    expect(
      checkStageProgression({ eventType: "SEALING_COMPLETE", currentStage: "BLISTERED" }).allowed,
    ).toBe(true);
  });

  it("PACKAGING picks up bags at SEALED", () => {
    expect(STATION_PICKUP_FROM_STAGE.PACKAGING).toContain("SEALED");
  });

  it("PACKAGING also picks up bags at BLISTERED (overlap scan — sealing still running)", () => {
    expect(STATION_PICKUP_FROM_STAGE.PACKAGING).toContain("BLISTERED");
  });

  it("PACKAGING_COMPLETE still requires SEALED even though pickup allows BLISTERED", () => {
    expect(
      checkStageProgression({ eventType: "PACKAGING_COMPLETE", currentStage: "BLISTERED" }).allowed,
    ).toBe(false);
  });

  it("PACKAGING_COMPLETE allowed at BLISTERED after partial sealing close-out", () => {
    expect(
      checkStageProgression({
        eventType: "PACKAGING_COMPLETE",
        currentStage: "BLISTERED",
        packagingPartialSealedReady: true,
      }).allowed,
    ).toBe(true);
  });

  it("PACKAGING_COMPLETE still allowed from SEALED (unchanged)", () => {
    expect(
      checkStageProgression({ eventType: "PACKAGING_COMPLETE", currentStage: "SEALED" }).allowed,
    ).toBe(true);
  });

  it("PACKAGING cannot pick up at STARTED — too early, sealing has not started", () => {
    expect(STATION_PICKUP_FROM_STAGE.PACKAGING).not.toContain("STARTED");
  });

  it("BLISTER does NOT pick up assigned cards (first-station only)", () => {
    expect(STATION_PICKUP_FROM_STAGE.BLISTER).toBeUndefined();
  });

  it("BOTTLE_HANDPACK does NOT pick up assigned cards (first-station)", () => {
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_HANDPACK).toBeUndefined();
  });
});

describe("multi-station travel — invariants the workflow guarantees", () => {
  it("After BLISTER_COMPLETE the bag is releasable from BLISTER and PACKAGING may begin overlap scan", () => {
    // PRODUCTION-OVERLAP-2: PACKAGING now accepts BLISTERED for overlap pickup.
    // Packaging still cannot COMPLETE until SEALED — PACKAGING_COMPLETE guards that.
    expect(STATION_RELEASE_FROM_STAGE.BLISTER).toBe("BLISTERED");
    expect(STATION_PICKUP_FROM_STAGE.PACKAGING).toContain("BLISTERED");
    expect(
      checkStageProgression({ eventType: "PACKAGING_COMPLETE", currentStage: "BLISTERED" }).allowed,
    ).toBe(false);
  });

  it("After SEALING_COMPLETE the bag is releasable from SEALING and pickable by PACKAGING", () => {
    expect(STATION_RELEASE_FROM_STAGE.SEALING).toBe("SEALED");
    expect(STATION_PICKUP_FROM_STAGE.PACKAGING).toContain("SEALED");
  });

  it("BAG_RELEASED is a non-progression event (does not advance stage by itself)", () => {
    // The bag's stage is unchanged by release; it stays at the
    // current value (BLISTERED / SEALED) until the next station's
    // stage event fires.
    for (const stage of ["BLISTERED", "SEALED"]) {
      expect(
        checkStageProgression({
          eventType: "BAG_RELEASED",
          currentStage: stage,
        }).allowed,
      ).toBe(true);
    }
  });

  it("BAG_PICKED_UP is a non-progression event (does not advance stage by itself)", () => {
    for (const stage of ["BLISTERED", "SEALED"]) {
      expect(
        checkStageProgression({
          eventType: "BAG_PICKED_UP",
          currentStage: stage,
        }).allowed,
      ).toBe(true);
    }
  });
});
