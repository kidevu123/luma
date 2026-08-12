import { describe, it, expect } from "vitest";
import { assembleStationView, buildNextAction } from "./station-view";
import type { StationViewRows } from "./station-view";
import { evaluateChecks } from "./resolve-exceptions";
import type { RouteOperationView } from "@/lib/production/routes";
import type { CurrentWork } from "./types";

const OP: RouteOperationView = {
  routeCode: "CARD_BLISTER",
  routeName: "Card blister",
  sequence: 4,
  operationCode: "HEAT_SEAL",
  operationName: "Heat seal",
  stageKey: "SEALING_QUEUE",
  nextStageKey: "POST_SEAL_STAGING",
  reworkStageKey: null,
  allowedStationKind: "SEALING",
  allowedMachineKind: "SEALING",
  requiresScan: true,
  requiresCounter: true,
  requiresTimer: true,
  outputUnit: "cards",
};

const CURRENT: CurrentWork = {
  workflowBagId: "bag-1",
  bagLabel: "1042",
  bagSubLabel: null,
  productName: "Chocolate Brown",
  statusLine: "Ready to seal",
  progress: null,
};

const ALL_PASS = evaluateChecks({
  bagRecognized: true,
  productResolved: true,
  operationResolved: true,
  materialsAvailable: true,
  upstreamStageComplete: true,
  bagPaused: false,
  bagFinalized: false,
  bagOnHold: false,
  waitingForLabel: null,
});

describe("buildNextAction", () => {
  it("asks for a shift before anything else", () => {
    const action = buildNextAction({
      hasOperatorSession: false,
      current: CURRENT,
      operation: OP,
      checks: ALL_PASS,
      bagStage: "BLISTERED",
      expected: null,
    });
    expect(action.kind).toBe("OPEN_SHIFT");
  });

  it("asks the operator to scan when no bag is at the station", () => {
    const action = buildNextAction({
      hasOperatorSession: true,
      current: null,
      operation: null,
      checks: ALL_PASS,
      bagStage: null,
      expected: null,
    });
    expect(action.kind).toBe("SCAN_TO_CLAIM");
  });

  it("blocks when a check fails, even with a bag present", () => {
    const checks = evaluateChecks({
      bagRecognized: true,
      productResolved: true,
      operationResolved: true,
      materialsAvailable: true,
      upstreamStageComplete: false,
      bagPaused: false,
      bagFinalized: false,
      bagOnHold: false,
      waitingForLabel: "Blister 1",
    });
    const action = buildNextAction({
      hasOperatorSession: true,
      current: CURRENT,
      operation: OP,
      checks,
      bagStage: "STARTED",
      expected: null,
    });
    expect(action.kind).toBe("BLOCKED");
    if (action.kind === "BLOCKED") {
      expect(action.blockers[0]?.code).toBe("UPSTREAM_INCOMPLETE");
    }
  });

  it("offers COMPLETE with counter input when the bag is ready to work", () => {
    const action = buildNextAction({
      hasOperatorSession: true,
      current: CURRENT,
      operation: OP,
      checks: ALL_PASS,
      bagStage: "BLISTERED",
      expected: null,
    });
    expect(action.kind).toBe("COMPLETE");
    if (action.kind === "COMPLETE") {
      expect(action.inputs.map((i) => i.key)).toContain("counter");
      expect(action.label).not.toMatch(/_COMPLETE/);
    }
  });

  it("never leaks an event or stage name into an action label", () => {
    const action = buildNextAction({
      hasOperatorSession: true,
      current: CURRENT,
      operation: OP,
      checks: ALL_PASS,
      bagStage: "BLISTERED",
      expected: null,
    });
    if (action.kind === "COMPLETE" || action.kind === "START") {
      expect(action.label).not.toMatch(/BLISTERED|SEALED|QUEUE|_COMPLETE/);
    }
  });
});

function rows(over: Partial<StationViewRows> = {}): StationViewRows {
  return {
    station: { id: "s1", label: "Sealing 2", kind: "SEALING", machineName: "Sealer 2" },
    session: { id: "sess1", employeeNameSnapshot: "Ana R." },
    current: {
      workflowBagId: "bag-1",
      bagLabel: "PO 1234 - Chocolate Brown - Bag 12",
      bagSubLabel: "1042",
      productName: "Chocolate Brown",
      productId: "prod-1",
      stage: "BLISTERED",
      isPaused: false,
      isFinalized: false,
      isOnHold: false,
    },
    operation: OP,
    ...over,
  };
}

describe("assembleStationView", () => {
  it("passes the station through unchanged", () => {
    expect(assembleStationView(rows()).station).toEqual({
      id: "s1",
      label: "Sealing 2",
      kind: "SEALING",
      machineName: "Sealer 2",
    });
  });

  it("reports OPEN_SHIFT and a null operator when no session is open", () => {
    const view = assembleStationView(rows({ session: null }));
    expect(view.operator).toBeNull();
    expect(view.nextAction.kind).toBe("OPEN_SHIFT");
  });

  it("falls back to a generic operator name when the snapshot is missing", () => {
    const view = assembleStationView(
      rows({ session: { id: "sess1", employeeNameSnapshot: null } }),
    );
    expect(view.operator?.name).toBe("Operator");
  });

  it("builds an operator-facing status line with no stage or event names", () => {
    const view = assembleStationView(rows());
    expect(view.current?.statusLine).toBe("Ready to sealing");
    expect(view.current?.statusLine).not.toMatch(/BLISTERED|SEALED|_COMPLETE|QUEUE/);
  });

  it("says Waiting when no operation resolves for this station", () => {
    const view = assembleStationView(rows({ operation: null }));
    expect(view.current?.statusLine).toBe("Waiting");
  });

  it("blocks on a paused bag and surfaces the paused blocker", () => {
    const base = rows();
    const view = assembleStationView(
      rows({ current: base.current ? { ...base.current, isPaused: true } : null }),
    );
    expect(view.nextAction.kind).toBe("BLOCKED");
    if (view.nextAction.kind === "BLOCKED") {
      expect(view.nextAction.blockers.map((b) => b.code)).toContain("BAG_PAUSED");
    }
  });

  it("blocks when the bag has no product mapping", () => {
    const base = rows();
    const view = assembleStationView(
      rows({ current: base.current ? { ...base.current, productId: null } : null }),
    );
    expect(view.nextAction.kind).toBe("BLOCKED");
  });

  it("asks the operator to scan when no bag is at the station", () => {
    const view = assembleStationView(rows({ current: null, operation: null }));
    expect(view.current).toBeNull();
    expect(view.nextAction.kind).toBe("SCAN_TO_CLAIM");
    expect(view.capabilities.canPause).toBe(false);
  });

  it("leaves upNext empty and supervisor null in phase 1", () => {
    const view = assembleStationView(rows());
    expect(view.upNext).toEqual([]);
    expect(view.supervisor).toBeNull();
  });

  it("carries both label lines so the rewire cannot drop the subline", () => {
    // page.tsx:980-984 renders primary as the heading and secondary as a
    // subline. Task 8 feeds that JSX from StationView, so losing either
    // here would be a visible change — which Phase 1 forbids.
    const view = assembleStationView(rows());
    expect(view.current?.bagLabel).toBe("PO 1234 - Chocolate Brown - Bag 12");
    expect(view.current?.bagSubLabel).toBe("1042");
  });

  it("tolerates a bag with no subline", () => {
    const base = rows();
    const view = assembleStationView(
      rows({ current: base.current ? { ...base.current, bagSubLabel: null } : null }),
    );
    expect(view.current?.bagSubLabel).toBeNull();
  });
});
