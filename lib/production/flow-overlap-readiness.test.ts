import { describe, it, expect } from "vitest";
import {
  deriveLaneWipFromEvents,
  evaluateFlowOverlapReadiness,
  type FlowOverlapBagSnapshot,
} from "./flow-overlap-readiness";

function snap(
  overrides: Partial<FlowOverlapBagSnapshot> & Pick<FlowOverlapBagSnapshot, "globalStage">,
): FlowOverlapBagSnapshot {
  const { laneWip: laneOverride, ...rest } = overrides;
  return {
    laneWip: {
      blisterOutputUnits: 0,
      sealedOutputUnits: 0,
      packagedOutputUnits: 0,
      ...laneOverride,
    },
    ...rest,
  };
}

describe("FLOW-OVERLAP-2A · deriveLaneWipFromEvents", () => {
  it("STARTED bag with only CARD_ASSIGNED has no lane output", () => {
    const wip = deriveLaneWipFromEvents([
      { eventType: "CARD_ASSIGNED", payload: {} },
    ]);
    expect(wip.blisterOutputUnits).toBe(0);
    expect(wip.sealedOutputUnits).toBe(0);
  });

  it("sums count_total from complete events", () => {
    const wip = deriveLaneWipFromEvents([
      { eventType: "BLISTER_COMPLETE", payload: { count_total: 120 } },
      { eventType: "SEALING_COMPLETE", payload: { count_total: 100 } },
      { eventType: "PACKAGING_COMPLETE", payload: { count_total: 10 } },
    ]);
    expect(wip.blisterOutputUnits).toBe(120);
    expect(wip.sealedOutputUnits).toBe(100);
    expect(wip.packagedOutputUnits).toBe(10);
  });
});

describe("FLOW-OVERLAP-2A · sealing overlap readiness", () => {
  it("STARTED with no blister output: overlap cannot begin (no WIP); pickup now allowed under updated serial rules", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({ globalStage: "STARTED", laneWip: { blisterOutputUnits: 0, sealedOutputUnits: 0, packagedOutputUnits: 0 } }),
    );
    expect(r.sealingLane.canBeginOverlapWork).toBe(false);
    // PRODUCTION-OVERLAP-1: SEALING now accepts STARTED in STATION_PICKUP_FROM_STAGE
    expect(r.sealingLane.canBeginUnderCurrentSerialRules).toBe(true);
    expect(r.dataGaps.some((g) => g.includes("STARTED"))).toBe(true);
  });

  it("STARTED with explicit partial blister signal: may begin overlap but not complete", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "STARTED",
        hasPartialBlisterSignal: true,
        laneWip: { blisterOutputUnits: 40, sealedOutputUnits: 0, packagedOutputUnits: 0 },
      }),
    );
    expect(r.sealingLane.canBeginOverlapWork).toBe(true);
    // PRODUCTION-OVERLAP-1: pickup now allowed from STARTED
    expect(r.sealingLane.canBeginUnderCurrentSerialRules).toBe(true);
    expect(r.sealingLane.canCompleteStation).toBe(false);
    expect(r.sealingLane.canCompleteUnderCurrentSerialRules).toBe(false);
    expect(r.bag.globalStage).toBe("STARTED");
  });

  it("BLISTERED bag: sealing may begin under current serial semantics", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "BLISTERED",
        laneWip: { blisterOutputUnits: 200, sealedOutputUnits: 0, packagedOutputUnits: 0 },
      }),
    );
    expect(r.sealingLane.canBeginUnderCurrentSerialRules).toBe(true);
    expect(r.sealingLane.canBeginOverlapWork).toBe(true);
    expect(r.sealingLane.canCompleteStation).toBe(true);
  });

  it("completing sealing is stricter than beginning when only partial blister exists", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "STARTED",
        hasPartialBlisterSignal: true,
        laneWip: { blisterOutputUnits: 15, sealedOutputUnits: 0, packagedOutputUnits: 0 },
      }),
    );
    expect(r.sealingLane.canBeginOverlapWork).toBe(true);
    expect(r.sealingLane.canCompleteStation).toBe(false);
  });
});

describe("FLOW-OVERLAP-2A · packaging overlap readiness", () => {
  it("BLISTERED with no sealed output: packaging cannot begin", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "BLISTERED",
        laneWip: { blisterOutputUnits: 100, sealedOutputUnits: 0, packagedOutputUnits: 0 },
      }),
    );
    expect(r.packagingLane.canBeginOverlapWork).toBe(false);
    expect(r.packagingLane.canBeginUnderCurrentSerialRules).toBe(false);
  });

  it("sealing in progress (partial sealed signal) at BLISTERED: packaging may begin only with sealed output", () => {
    const without = evaluateFlowOverlapReadiness(
      snap({ globalStage: "BLISTERED", laneWip: { blisterOutputUnits: 100, sealedOutputUnits: 0, packagedOutputUnits: 0 } }),
    );
    expect(without.packagingLane.canBeginOverlapWork).toBe(false);

    const withPartial = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "BLISTERED",
        hasPartialSealedSignal: true,
        laneWip: { blisterOutputUnits: 100, sealedOutputUnits: 25, packagedOutputUnits: 0 },
      }),
    );
    expect(withPartial.packagingLane.canBeginOverlapWork).toBe(true);
    expect(withPartial.packagingLane.canCompleteStation).toBe(false);
    expect(withPartial.packagingLane.canBeginUnderCurrentSerialRules).toBe(false);
  });

  it("SEALED bag: packaging may begin under current serial semantics", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "SEALED",
        laneWip: { blisterOutputUnits: 200, sealedOutputUnits: 180, packagedOutputUnits: 0 },
      }),
    );
    expect(r.packagingLane.canBeginUnderCurrentSerialRules).toBe(true);
    expect(r.packagingLane.canBeginOverlapWork).toBe(true);
    expect(r.packagingLane.canCompleteStation).toBe(true);
  });

  it("packaging complete stricter than begin when only partial sealed at BLISTERED", () => {
    const r = evaluateFlowOverlapReadiness(
      snap({
        globalStage: "BLISTERED",
        hasPartialSealedSignal: true,
        laneWip: { blisterOutputUnits: 200, sealedOutputUnits: 50, packagedOutputUnits: 0 },
      }),
    );
    expect(r.packagingLane.canBeginOverlapWork).toBe(true);
    expect(r.packagingLane.canCompleteStation).toBe(false);
  });
});

describe("FLOW-OVERLAP-2A · insufficient data from events alone while STARTED", () => {
  it("event fold cannot produce blister wip without advancing stage in current model", () => {
    const wip = deriveLaneWipFromEvents([
      { eventType: "CARD_ASSIGNED", payload: {} },
      { eventType: "BAG_PICKED_UP", payload: {} },
    ]);
    expect(wip.blisterOutputUnits).toBe(0);
    const r = evaluateFlowOverlapReadiness(
      snap({ globalStage: "STARTED", laneWip: wip }),
    );
    expect(r.sealingLane.canBeginOverlapWork).toBe(false);
    expect(r.dataGaps.length).toBeGreaterThan(0);
  });
});

describe("FLOW-OVERLAP-2A · pause model note", () => {
  it("documents global pause assumption", () => {
    const r = evaluateFlowOverlapReadiness(snap({ globalStage: "BLISTERED", isPaused: true }));
    expect(r.sealingLane.canBeginOverlapWork).toBe(false);
    expect(r.pauseModelAssumption).toMatch(/global per bag/);
  });
});
