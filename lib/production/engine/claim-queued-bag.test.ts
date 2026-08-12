import { describe, it, expect } from "vitest";
import { checkClaimGuards } from "./claim-queued-bag";

// An unheld row bound for the sealing queue. `claimedByStationId` is the
// station HOLDING the bag, not a peer's reservation — see the queueRow
// docs on ClaimGuardInput.
const ROW = {
  eligibleStationKinds: ["SEALING"],
  claimedByStationId: null,
  claimedByStationKind: null,
  readyState: "READY",
};

/** The real overlap shape the projector emits: blister is still working
 *  the bag, so the row is UPSTREAM_RUNNING and HELD by the blister
 *  station. BLISTER is not in eligibleStationKinds, so it is upstream,
 *  not a peer. */
const HELD_UPSTREAM = {
  ...ROW,
  readyState: "UPSTREAM_RUNNING",
  claimedByStationId: "blister-1",
  claimedByStationKind: "BLISTER",
};

const BASE = {
  stationId: "sealer-1",
  isPaused: false,
  isFinalized: false,
  isOnHold: false,
};

describe("checkClaimGuards", () => {
  it("allows an eligible unclaimed READY bag", () => {
    expect(
      checkClaimGuards({
        ...BASE,
        stationKind: "SEALING",
        queueRow: ROW,
        bagStage: "BLISTERED",
      }),
    ).toBeNull();
  });

  it("allows the overlap claim while an upstream station still holds the bag", () => {
    // STATION_PICKUP_FROM_STAGE.SEALING includes STARTED precisely so a
    // sealer can take a bag blister has not finished. The holder being
    // non-null is the NORMAL state here, not a competing claim.
    expect(
      checkClaimGuards({
        ...BASE,
        stationKind: "SEALING",
        queueRow: HELD_UPSTREAM,
        bagStage: "STARTED",
      }),
    ).toBeNull();
  });

  it("rejects a bag a peer of the same kind is already holding", () => {
    // Two sealers reaching for the same bag: the holder's kind IS in
    // eligibleStationKinds, so this is a real race.
    const b = checkClaimGuards({
      ...BASE,
      stationKind: "SEALING",
      queueRow: {
        ...ROW,
        claimedByStationId: "sealer-2",
        claimedByStationKind: "SEALING",
      },
      bagStage: "BLISTERED",
    });
    expect(b?.code).toBe("BAG_ALREADY_CLAIMED");
    expect(b?.operatorSentence).not.toMatch(/BLISTERED|QUEUE|_COMPLETE/);
  });

  it("rejects a peer claim even when the queue lists several kinds", () => {
    // Both bottle finishing kinds are eligible for the same row; either
    // one holding it blocks the other.
    const b = checkClaimGuards({
      ...BASE,
      stationKind: "BOTTLE_STICKER",
      queueRow: {
        ...ROW,
        eligibleStationKinds: ["BOTTLE_STICKER", "BOTTLE_CAP_SEAL"],
        claimedByStationId: "capseal-1",
        claimedByStationKind: "BOTTLE_CAP_SEAL",
      },
      bagStage: "BLISTERED",
    });
    expect(b?.code).toBe("BAG_ALREADY_CLAIMED");
  });

  it("fails closed when the holder's kind cannot be resolved", () => {
    // Held by SOMETHING Luma cannot name. Refusing a claim is
    // recoverable; two stations working one bag is not.
    const b = checkClaimGuards({
      ...BASE,
      stationKind: "SEALING",
      queueRow: { ...ROW, claimedByStationId: "ghost", claimedByStationKind: null },
      bagStage: "BLISTERED",
    });
    expect(b?.code).toBe("BAG_ALREADY_CLAIMED");
  });

  it("rejects a station kind the queue row does not list", () => {
    const b = checkClaimGuards({
      ...BASE,
      stationKind: "PACKAGING",
      queueRow: ROW,
      bagStage: "BLISTERED",
    });
    expect(b?.code).toBe("OPERATION_UNRESOLVED");
  });

  it("tells the race loser a colleague got there first, not that they are at the wrong station", () => {
    // The shape a losing claim actually sees. A peer's BAG_PICKED_UP is a
    // WORKING transition, so the projector REWRITES the row to the
    // winner's downstream destination — SEALING_QUEUE becomes
    // PACKAGING_QUEUE and eligible_station_kinds becomes ["PACKAGING"] —
    // and holds it for the winner. Nothing is deleted. Without the
    // foreign-holder rule this reads as OPERATION_UNRESOLVED: "This bag
    // does not belong at this station", plus a supervisor call, for a
    // sealer standing at the right machine.
    const b = checkClaimGuards({
      ...BASE,
      stationId: "sealer-1",
      stationKind: "SEALING",
      queueRow: {
        eligibleStationKinds: ["PACKAGING"],
        claimedByStationId: "sealer-2",
        claimedByStationKind: "SEALING",
        readyState: "UPSTREAM_RUNNING",
      },
      bagStage: "BLISTERED",
    });
    expect(b?.code).toBe("BAG_ALREADY_CLAIMED");
    expect(b?.operatorSentence).toBe(
      "Another station is already working on this bag.",
    );
  });

  it("still calls a genuine routing mistake a routing mistake", () => {
    // Ineligible AND nobody holding it: no race happened, the bag really
    // is at the wrong station. The foreign holder is the distinguishing
    // fact, not the ineligibility.
    expect(
      checkClaimGuards({
        ...BASE,
        stationKind: "PACKAGING",
        queueRow: ROW,
        bagStage: "BLISTERED",
      })?.code,
    ).toBe("OPERATION_UNRESOLVED");
  });

  it("does not call this station's own hold a race", () => {
    // The row is held by ME (double tap, refreshed tablet). "Another
    // station is already working on this bag" would be a lie.
    const b = checkClaimGuards({
      ...BASE,
      stationId: "sealer-1",
      stationKind: "SEALING",
      queueRow: {
        eligibleStationKinds: ["PACKAGING"],
        claimedByStationId: "sealer-1",
        claimedByStationKind: "SEALING",
        readyState: "UPSTREAM_RUNNING",
      },
      bagStage: "BLISTERED",
    });
    expect(b?.code).toBe("OPERATION_UNRESOLVED");
  });

  it("reports a finished bag whose queue row is gone as finished", () => {
    // BAG_FINALIZED is the ONLY event that deletes a queue row, so a
    // missing row on a finalized bag is not a mystery — say so instead of
    // "not recognized" or inventing a competing station.
    expect(
      checkClaimGuards({
        ...BASE,
        isFinalized: true,
        stationKind: "SEALING",
        queueRow: null,
        bagStage: "PACKAGED",
      })?.code,
    ).toBe("BAG_FINALIZED");
  });

  it("rejects a stage the pickup table does not allow", () => {
    const b = checkClaimGuards({
      ...BASE,
      stationKind: "PACKAGING",
      queueRow: { ...ROW, eligibleStationKinds: ["PACKAGING"] },
      bagStage: "STARTED", // packaging picks up at BLISTERED or SEALED only
    });
    expect(b?.code).toBe("UPSTREAM_INCOMPLETE");
  });

  it("rejects paused, held, finished, and unknown bags with the catalogue blockers", () => {
    const at = (over: Partial<Parameters<typeof checkClaimGuards>[0]>) =>
      checkClaimGuards({
        ...BASE,
        stationKind: "SEALING",
        queueRow: ROW,
        bagStage: "BLISTERED",
        ...over,
      })?.code;
    expect(at({ isPaused: true })).toBe("BAG_PAUSED");
    expect(at({ isFinalized: true })).toBe("BAG_FINALIZED");
    expect(at({ isOnHold: true })).toBe("BAG_ON_HOLD");
    expect(at({ queueRow: null, bagStage: null })).toBe("BAG_UNRECOGNIZED");
  });

  it("refuses a held bag at claim time rather than letting it be claimed then blocked", () => {
    // read_bag_state.is_on_hold is a supervisor decision. Claiming first
    // and discovering it on the next screen wastes a trip to the machine.
    expect(
      checkClaimGuards({
        ...BASE,
        isOnHold: true,
        stationKind: "SEALING",
        queueRow: HELD_UPSTREAM,
        bagStage: "STARTED",
      })?.code,
    ).toBe("BAG_ON_HOLD");
  });

  it("rejects a bag with a queue row but no known stage", () => {
    // read_bag_state missing for a queued bag means the projector has not
    // caught up (or the bag was hand-inserted). Claiming would fire a
    // BAG_PICKED_UP from an unknown stage — refuse instead of guessing.
    expect(
      checkClaimGuards({
        ...BASE,
        stationKind: "SEALING",
        queueRow: ROW,
        bagStage: null,
      })?.code,
    ).toBe("BAG_UNRECOGNIZED");
  });

  it("reports the finished bag before the routing mistake", () => {
    // An already-finished bag at the wrong station is finished first —
    // "this bag is already finished" is the actionable sentence; sending
    // the operator to a supervisor over routing would be noise.
    const b = checkClaimGuards({
      ...BASE,
      isFinalized: true,
      stationKind: "PACKAGING",
      queueRow: ROW,
      bagStage: "SEALED",
    });
    expect(b?.code).toBe("BAG_FINALIZED");
  });

  it("never returns a blocker whose operator sentence names a stage or event", () => {
    const cases: Parameters<typeof checkClaimGuards>[0][] = [
      { ...BASE, stationKind: "PACKAGING", queueRow: ROW, bagStage: "BLISTERED" },
      {
        ...BASE,
        stationKind: "SEALING",
        queueRow: { ...ROW, claimedByStationId: "s2", claimedByStationKind: "SEALING" },
        bagStage: "BLISTERED",
      },
      {
        ...BASE,
        stationKind: "PACKAGING",
        queueRow: { ...ROW, eligibleStationKinds: ["PACKAGING"] },
        bagStage: "STARTED",
      },
      { ...BASE, isPaused: true, stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED" },
      { ...BASE, isOnHold: true, stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED" },
      { ...BASE, stationKind: "SEALING", queueRow: null, bagStage: null },
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
