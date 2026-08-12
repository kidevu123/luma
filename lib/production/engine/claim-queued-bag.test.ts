import { describe, it, expect } from "vitest";
import { checkClaimGuards } from "./claim-queued-bag";

const ROW = {
  eligibleStationKinds: ["SEALING"],
  claimedByStationId: null,
  readyState: "READY",
};

describe("checkClaimGuards", () => {
  it("allows an eligible unclaimed READY bag", () => {
    expect(
      checkClaimGuards({
        stationKind: "SEALING",
        queueRow: ROW,
        bagStage: "BLISTERED",
        isPaused: false,
        isFinalized: false,
      }),
    ).toBeNull();
  });

  it("allows the overlap claim while upstream still runs, per pickup rules", () => {
    expect(
      checkClaimGuards({
        stationKind: "SEALING",
        queueRow: { ...ROW, readyState: "UPSTREAM_RUNNING" },
        bagStage: "STARTED", // STATION_PICKUP_FROM_STAGE.SEALING includes STARTED
        isPaused: false,
        isFinalized: false,
      }),
    ).toBeNull();
  });

  it("rejects a station kind the queue row does not list", () => {
    const b = checkClaimGuards({
      stationKind: "PACKAGING",
      queueRow: ROW,
      bagStage: "BLISTERED",
      isPaused: false,
      isFinalized: false,
    });
    expect(b?.code).toBe("OPERATION_UNRESOLVED");
  });

  it("rejects a bag already claimed by another station", () => {
    const b = checkClaimGuards({
      stationKind: "SEALING",
      queueRow: { ...ROW, claimedByStationId: "other-station" },
      bagStage: "BLISTERED",
      isPaused: false,
      isFinalized: false,
    });
    expect(b).not.toBeNull();
    expect(b?.code).toBe("BAG_ALREADY_CLAIMED");
    expect(b?.operatorSentence).not.toMatch(/BLISTERED|QUEUE|_COMPLETE/);
  });

  it("rejects a stage the pickup table does not allow", () => {
    const b = checkClaimGuards({
      stationKind: "PACKAGING",
      queueRow: { ...ROW, eligibleStationKinds: ["PACKAGING"] },
      bagStage: "STARTED", // packaging picks up at BLISTERED or SEALED only
      isPaused: false,
      isFinalized: false,
    });
    expect(b?.code).toBe("UPSTREAM_INCOMPLETE");
  });

  it("rejects paused, finalized, and unknown bags with the catalogue blockers", () => {
    expect(
      checkClaimGuards({ stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED", isPaused: true, isFinalized: false })?.code,
    ).toBe("BAG_PAUSED");
    expect(
      checkClaimGuards({ stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED", isPaused: false, isFinalized: true })?.code,
    ).toBe("BAG_FINALIZED");
    expect(
      checkClaimGuards({ stationKind: "SEALING", queueRow: null, bagStage: null, isPaused: false, isFinalized: false })?.code,
    ).toBe("BAG_UNRECOGNIZED");
  });

  it("rejects a bag with a queue row but no known stage", () => {
    // read_bag_state missing for a queued bag means the projector has not
    // caught up (or the bag was hand-inserted). Claiming would fire a
    // BAG_PICKED_UP from an unknown stage — refuse instead of guessing.
    expect(
      checkClaimGuards({
        stationKind: "SEALING",
        queueRow: ROW,
        bagStage: null,
        isPaused: false,
        isFinalized: false,
      })?.code,
    ).toBe("BAG_UNRECOGNIZED");
  });

  it("reports the finished bag before the routing mistake", () => {
    // An already-finished bag at the wrong station is finished first —
    // "this bag is already finished" is the actionable sentence; sending
    // the operator to a supervisor over routing would be noise.
    const b = checkClaimGuards({
      stationKind: "PACKAGING",
      queueRow: ROW,
      bagStage: "SEALED",
      isPaused: false,
      isFinalized: true,
    });
    expect(b?.code).toBe("BAG_FINALIZED");
  });

  it("never returns a blocker whose operator sentence names a stage or event", () => {
    const cases: Parameters<typeof checkClaimGuards>[0][] = [
      { stationKind: "PACKAGING", queueRow: ROW, bagStage: "BLISTERED", isPaused: false, isFinalized: false },
      { stationKind: "SEALING", queueRow: { ...ROW, claimedByStationId: "s2" }, bagStage: "BLISTERED", isPaused: false, isFinalized: false },
      { stationKind: "PACKAGING", queueRow: { ...ROW, eligibleStationKinds: ["PACKAGING"] }, bagStage: "STARTED", isPaused: false, isFinalized: false },
      { stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED", isPaused: true, isFinalized: false },
      { stationKind: "SEALING", queueRow: null, bagStage: null, isPaused: false, isFinalized: false },
    ];
    for (const input of cases) {
      const b = checkClaimGuards(input);
      expect(b).not.toBeNull();
      expect(b?.operatorSentence).not.toMatch(
        /STARTED|BLISTERED|SEALED|PACKAGED|QUEUE|_COMPLETE|BAG_PICKED_UP/,
      );
    }
  });
});
