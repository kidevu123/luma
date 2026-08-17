import { describe, it, expect } from "vitest";
import { floorEventRelevantToStation, queueKeysForStationKind } from "./floor-event-relevance";
import { makeSeededRouteGraph } from "./__fixtures__/seeded-routes";

const SEALING = { id: "st-seal-1", kind: "SEALING" };
const PACKAGING = { id: "st-pack-1", kind: "PACKAGING" };
const graph = makeSeededRouteGraph();

describe("floorEventRelevantToStation", () => {
  it("always cares about its own events", () => {
    expect(
      floorEventRelevantToStation(
        graph,
        { stationId: "st-seal-1", stationKind: null, queueStageKey: null },
        SEALING,
      ),
    ).toBe(true);
  });
  it("cares about same-kind peers", () => {
    expect(
      floorEventRelevantToStation(
        graph,
        { stationId: "st-seal-2", stationKind: "SEALING", queueStageKey: null },
        SEALING,
      ),
    ).toBe(true);
  });
  it("cares about bags entering a queue it claims from", () => {
    expect(
      floorEventRelevantToStation(
        graph,
        { stationId: "st-blister-1", stationKind: "BLISTER", queueStageKey: "SEALING_QUEUE" },
        SEALING,
      ),
    ).toBe(true);
  });
  it("ignores unrelated stations and queues", () => {
    expect(
      floorEventRelevantToStation(
        graph,
        { stationId: "st-pack-1", stationKind: "PACKAGING", queueStageKey: "FINISHED_GOODS_QUEUE" },
        SEALING,
      ),
    ).toBe(false);
  });
  it("BLISTER_COMPLETE parked under SEALING_QUEUE is relevant to packaging (overlap-claim at BLISTERED)", () => {
    expect(
      floorEventRelevantToStation(
        graph,
        { stationId: "st-blister-1", stationKind: "BLISTER", queueStageKey: "SEALING_QUEUE" },
        PACKAGING,
      ),
    ).toBe(true);
  });
  it("nulls never match", () => {
    expect(
      floorEventRelevantToStation(
        graph,
        { stationId: null, stationKind: null, queueStageKey: null },
        SEALING,
      ),
    ).toBe(false);
  });
});

describe("queueKeysForStationKind", () => {
  it("cap-seal watches both finishing queues (order-flex parking)", () => {
    expect(queueKeysForStationKind(graph, "BOTTLE_CAP_SEAL")).toEqual([
      "BOTTLE_STICKER_QUEUE",
      "BOTTLE_INDUCTION_QUEUE",
    ]);
  });
  it("first-op kinds have no inbound queue", () => {
    for (const kind of ["BLISTER", "HANDPACK_BLISTER", "COMBINED", "BOTTLE_HANDPACK"]) {
      expect(queueKeysForStationKind(graph, kind)).toEqual([]);
    }
  });
  it("unknown kinds get an empty list, not a throw", () => {
    expect(queueKeysForStationKind(graph, "NOT_A_KIND")).toEqual([]);
  });
});
