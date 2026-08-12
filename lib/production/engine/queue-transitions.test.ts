import { describe, it, expect } from "vitest";
import { deriveQueueTransition, queueAfterWorkAt, queueRank } from "./queue-transitions";

const CARD = { routeCode: "CARD_BLISTER" } as const;

describe("queueAfterWorkAt", () => {
  it("routes a card bag being blistered toward the sealing queue", () => {
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "BLISTER", priorEventTypes: [] }),
    ).toEqual({ queueStageKey: "SEALING_QUEUE", eligibleStationKinds: ["SEALING"] });
  });

  it("treats handpack-blister and combined as card first ops", () => {
    for (const stationKind of ["HANDPACK_BLISTER", "COMBINED"]) {
      const dest = queueAfterWorkAt({ ...CARD, stationKind, priorEventTypes: [] });
      // COMBINED finalizes in place, so its bag has no next queue.
      if (stationKind === "COMBINED") expect(dest).toBeNull();
      else expect(dest?.queueStageKey).toBe("SEALING_QUEUE");
    }
  });

  it("routes sealing work toward packaging", () => {
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "SEALING", priorEventTypes: [] })
        ?.queueStageKey,
    ).toBe("PACKAGING_QUEUE");
  });

  it("routes packaging work toward finished goods", () => {
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "PACKAGING", priorEventTypes: [] }),
    ).toEqual({
      queueStageKey: "FINISHED_GOODS_QUEUE",
      eligibleStationKinds: [],
    });
  });

  it("offers BOTH finishing kinds after bottle fill when neither has run", () => {
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_HANDPACK",
        priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE"],
      }),
    ).toEqual({
      queueStageKey: "BOTTLE_STICKER_QUEUE",
      eligibleStationKinds: ["BOTTLE_STICKER", "BOTTLE_CAP_SEAL"],
    });
  });

  it("narrows to the remaining finishing kind after the first has run", () => {
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_CAP_SEAL",
        priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_CAP_SEAL_COMPLETE"],
      }),
    ).toEqual({
      queueStageKey: "BOTTLE_STICKER_QUEUE",
      eligibleStationKinds: ["BOTTLE_STICKER"],
    });
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_STICKER",
        priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_STICKER_COMPLETE"],
      }),
    ).toEqual({
      queueStageKey: "BOTTLE_INDUCTION_QUEUE",
      eligibleStationKinds: ["BOTTLE_CAP_SEAL"],
    });
  });

  it("routes to packaging once both finishing steps are done", () => {
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_STICKER",
        priorEventTypes: [
          "BOTTLE_HANDPACK_COMPLETE",
          "BOTTLE_CAP_SEAL_COMPLETE",
          "BOTTLE_STICKER_COMPLETE",
        ],
      })?.queueStageKey,
    ).toBe("PACKAGING_QUEUE");
  });

  it("returns null for an unknown route or station kind", () => {
    expect(
      queueAfterWorkAt({ routeCode: "NOT_A_ROUTE", stationKind: "SEALING", priorEventTypes: [] }),
    ).toBeNull();
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "NOT_A_KIND", priorEventTypes: [] }),
    ).toBeNull();
  });

  it("never lists the working finishing station as eligible for its own output", () => {
    const dest = queueAfterWorkAt({
      routeCode: "BOTTLE",
      stationKind: "BOTTLE_CAP_SEAL",
      priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE"], // picked up, not yet complete
    });
    // Working at cap-seal: after MY step the bag needs stickering.
    expect(dest).toEqual({
      queueStageKey: "BOTTLE_STICKER_QUEUE",
      eligibleStationKinds: ["BOTTLE_STICKER"],
    });
  });

  it("covers the sticker-only route end to end", () => {
    expect(
      queueAfterWorkAt({ routeCode: "STICKER_ONLY", stationKind: "BOTTLE_STICKER", priorEventTypes: [] }),
    ).toEqual({ queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] });
    expect(
      queueAfterWorkAt({ routeCode: "STICKER_ONLY", stationKind: "PACKAGING", priorEventTypes: [] }),
    ).toEqual({ queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] });
  });
});

describe("deriveQueueTransition", () => {
  const base = {
    stationId: "st-1",
    stationKind: "BLISTER",
    routeCode: "CARD_BLISTER",
    priorEventTypes: [] as string[],
    currentRow: null,
  };

  it("starts tracking when a bag is claimed at a first-op station", () => {
    for (const eventType of ["CARD_ASSIGNED", "BAG_CLAIMED"]) {
      const t = deriveQueueTransition({ ...base, eventType });
      expect(t).toEqual({
        kind: "WORKING",
        destination: { queueStageKey: "SEALING_QUEUE", eligibleStationKinds: ["SEALING"] },
        claimedByStationId: "st-1",
      });
    }
  });

  it("marks the bag READY when the stage completes", () => {
    const t = deriveQueueTransition({ ...base, eventType: "BLISTER_COMPLETE" });
    expect(t.kind).toBe("READY");
    if (t.kind === "READY") {
      expect(t.destination.queueStageKey).toBe("SEALING_QUEUE");
    }
  });

  it("advances the destination when the next station picks the bag up", () => {
    const t = deriveQueueTransition({
      ...base,
      stationKind: "SEALING",
      eventType: "BAG_PICKED_UP",
      priorEventTypes: ["CARD_ASSIGNED", "BLISTER_COMPLETE", "BAG_RELEASED"],
    });
    expect(t).toEqual({
      kind: "WORKING",
      destination: { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] },
      claimedByStationId: "st-1",
    });
  });

  it("unclaims on release and removes on finalize", () => {
    expect(deriveQueueTransition({ ...base, eventType: "BAG_RELEASED" })).toEqual({
      kind: "UNCLAIM",
    });
    expect(deriveQueueTransition({ ...base, eventType: "BAG_FINALIZED" })).toEqual({
      kind: "REMOVE",
    });
  });

  it("does nothing for non-flow events", () => {
    for (const eventType of ["BAG_PAUSED", "BAG_RESUMED", "OPERATOR_CHANGE", "MATERIAL_CONSUMED"]) {
      expect(deriveQueueTransition({ ...base, eventType })).toEqual({ kind: "NONE" });
    }
  });

  it("does nothing without a station or route where one is required", () => {
    expect(
      deriveQueueTransition({ ...base, stationId: null, eventType: "BAG_CLAIMED" }),
    ).toEqual({ kind: "NONE" });
    expect(
      deriveQueueTransition({ ...base, routeCode: null, eventType: "BLISTER_COMPLETE" }),
    ).toEqual({ kind: "NONE" });
  });

  it("keeps a bottle bag out of packaging until both finishing steps ran", () => {
    const afterFirst = deriveQueueTransition({
      stationId: "st-9",
      stationKind: "BOTTLE_CAP_SEAL",
      routeCode: "BOTTLE",
      eventType: "BOTTLE_CAP_SEAL_COMPLETE",
      priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_CAP_SEAL_COMPLETE"],
      currentRow: null,
    });
    expect(afterFirst.kind).toBe("READY");
    if (afterFirst.kind === "READY") {
      expect(afterFirst.destination.queueStageKey).toBe("BOTTLE_STICKER_QUEUE");
    }
  });

  it("ignores a stale upstream completion after a downstream pickup (overlap clobber)", () => {
    // Sealing overlap-claimed a STARTED bag; the row already points at
    // PACKAGING_QUEUE. Blister's completion then lands. Applying it
    // would clobber the sealing claim and regress the destination.
    const t = deriveQueueTransition({
      ...base,
      eventType: "BLISTER_COMPLETE",
      currentRow: { queueStageKey: "PACKAGING_QUEUE", claimedByStationId: "sealing-1" },
    });
    expect(t).toEqual({ kind: "NONE" });
  });

  it("applies a completion whose destination matches the current queue rank", () => {
    // Normal case: sealing completes the bag it claimed; destination
    // PACKAGING_QUEUE equals the row's queue. READY must go through.
    const t = deriveQueueTransition({
      ...base,
      stationKind: "SEALING",
      eventType: "SEALING_COMPLETE",
      priorEventTypes: ["CARD_ASSIGNED", "BLISTER_COMPLETE", "BAG_PICKED_UP", "SEALING_COMPLETE"],
      currentRow: { queueStageKey: "PACKAGING_QUEUE", claimedByStationId: "st-1" },
    });
    expect(t.kind).toBe("READY");
  });

  it("still applies a normal in-order completion when a row exists", () => {
    // Blister completes with the row still pointing at SEALING_QUEUE
    // (no overlap). Equal rank: apply.
    const t = deriveQueueTransition({
      ...base,
      eventType: "BLISTER_COMPLETE",
      currentRow: { queueStageKey: "SEALING_QUEUE", claimedByStationId: "st-1" },
    });
    expect(t.kind).toBe("READY");
  });
});

describe("queueRank", () => {
  it("ranks queues downstream-increasing per route, finishing queues tied", () => {
    expect(queueRank("CARD_BLISTER", "SEALING_QUEUE")).toBe(1);
    expect(queueRank("CARD_BLISTER", "PACKAGING_QUEUE")).toBe(2);
    expect(queueRank("BOTTLE", "BOTTLE_STICKER_QUEUE")).toBe(
      queueRank("BOTTLE", "BOTTLE_INDUCTION_QUEUE"),
    );
    expect(queueRank("NOT_A_ROUTE", "SEALING_QUEUE")).toBeNull();
  });
});
