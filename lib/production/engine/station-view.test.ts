import { describe, it, expect } from "vitest";
import {
  assembleStationView,
  buildNextAction,
  mapQueueRowsToUpNext,
} from "./station-view";
import type { QueueRowForUpNext, StationViewRows } from "./station-view";
import { evaluateChecks } from "./resolve-exceptions";
import type { RouteOperationView } from "@/lib/production/routes";
import type { CurrentWork, UpNextBag } from "./types";

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
  orderIndependentGroup: null,
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
    upNext: [],
    ...over,
  };
}

const NOW = new Date("2026-08-12T12:10:00Z");

function queueRow(over: Partial<QueueRowForUpNext> = {}): QueueRowForUpNext {
  return {
    workflowBagId: "bag-2",
    bagLabel: "PO 1234 - Chocolate Brown - Bag 13",
    productId: "prod-1",
    productName: "Chocolate Brown",
    readyState: "READY",
    claimedByStationId: null,
    upstreamStartedAt: null,
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

  it("passes the mapped queue through and leaves supervisor null", () => {
    const view = assembleStationView(rows());
    expect(view.upNext).toEqual([]);
    expect(view.supervisor).toBeNull();
  });

  it("carries the up-next list the loader mapped, unchanged", () => {
    const upNext: UpNextBag[] = [
      {
        workflowBagId: "bag-2",
        bagLabel: "PO 1234 - Chocolate Brown - Bag 13",
        productName: "Chocolate Brown",
        readyState: "READY",
        etaMinutes: null,
      },
    ];
    expect(assembleStationView(rows({ upNext })).upNext).toEqual(upNext);
  });

  it("offers the first queued bag as the expected scan when idle", () => {
    const upNext: UpNextBag[] = [
      {
        workflowBagId: "bag-2",
        bagLabel: "Bag 13",
        productName: "Chocolate Brown",
        readyState: "READY",
        etaMinutes: null,
      },
      {
        workflowBagId: "bag-3",
        bagLabel: "Bag 14",
        productName: "Chocolate Brown",
        readyState: "UPSTREAM_RUNNING",
        etaMinutes: 6,
      },
    ];
    const view = assembleStationView(rows({ current: null, operation: null, upNext }));
    expect(view.nextAction.kind).toBe("SCAN_TO_CLAIM");
    if (view.nextAction.kind === "SCAN_TO_CLAIM") {
      expect(view.nextAction.expected?.workflowBagId).toBe("bag-2");
    }
  });

  it("expects nothing when the queue is empty", () => {
    const view = assembleStationView(rows({ current: null, operation: null }));
    if (view.nextAction.kind === "SCAN_TO_CLAIM") {
      expect(view.nextAction.expected).toBeNull();
    }
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

describe("mapQueueRowsToUpNext", () => {
  it("sorts ready bags ahead of ones whose upstream is still running", () => {
    const out = mapQueueRowsToUpNext(
      [
        queueRow({
          workflowBagId: "running",
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: "blister-1",
          upstreamStartedAt: new Date("2026-08-12T12:00:00Z"),
        }),
        queueRow({ workflowBagId: "ready" }),
      ],
      new Map([["prod-1", 14]]),
      NOW,
    );
    expect(out.map((b) => b.workflowBagId)).toEqual(["ready", "running"]);
  });

  it("keeps the loader's order within a ready state", () => {
    // The SQL orders READY rows by ready_at. The mapper must not
    // re-shuffle them — a stable partition is the whole contract.
    const out = mapQueueRowsToUpNext(
      [
        queueRow({ workflowBagId: "first" }),
        queueRow({ workflowBagId: "second" }),
        queueRow({ workflowBagId: "third" }),
      ],
      new Map(),
      NOW,
    );
    expect(out.map((b) => b.workflowBagId)).toEqual(["first", "second", "third"]);
  });

  it("gives an ETA to a bag an upstream station is actively holding", () => {
    const out = mapQueueRowsToUpNext(
      [
        queueRow({
          workflowBagId: "running",
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: "blister-1",
          upstreamStartedAt: new Date("2026-08-12T12:00:00Z"),
        }),
      ],
      new Map([["prod-1", 14]]),
      NOW,
    );
    expect(out[0]?.etaMinutes).toBe(4);
  });

  it("says nothing for a bag released mid-work, rather than counting down to zero", () => {
    // A sealing handoff fires BAG_RELEASED, which UNCLAIMs the row but
    // leaves ready_state UPSTREAM_RUNNING and a stale upstream_started_at.
    // Nobody is working this bag; the elapsed clock is meaningless, and
    // the clamp would otherwise announce "any moment now" for a bag on a
    // cart.
    const out = mapQueueRowsToUpNext(
      [
        queueRow({
          workflowBagId: "released",
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: null,
          upstreamStartedAt: new Date("2026-08-12T11:00:00Z"),
        }),
      ],
      new Map([["prod-1", 14]]),
      NOW,
    );
    expect(out[0]?.readyState).toBe("UPSTREAM_RUNNING");
    expect(out[0]?.etaMinutes).toBeNull();
  });

  it("says nothing rather than guessing when the product has no median", () => {
    const out = mapQueueRowsToUpNext(
      [
        queueRow({
          workflowBagId: "running",
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: "blister-1",
          upstreamStartedAt: new Date("2026-08-12T12:00:00Z"),
        }),
      ],
      new Map(),
      NOW,
    );
    expect(out[0]?.etaMinutes).toBeNull();
  });

  it("says nothing when the bag has no product to match a median against", () => {
    const out = mapQueueRowsToUpNext(
      [
        queueRow({
          workflowBagId: "running",
          productId: null,
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: "blister-1",
          upstreamStartedAt: new Date("2026-08-12T12:00:00Z"),
        }),
      ],
      new Map([["prod-1", 14]]),
      NOW,
    );
    expect(out[0]?.etaMinutes).toBeNull();
  });

  it("never puts an ETA on a bag that is already ready", () => {
    // A READY bag is waiting on an operator, not on upstream. An ETA
    // there would read as "not yet available", which is false.
    const out = mapQueueRowsToUpNext(
      [queueRow({ upstreamStartedAt: new Date("2026-08-12T12:00:00Z") })],
      new Map([["prod-1", 14]]),
      NOW,
    );
    expect(out[0]?.readyState).toBe("READY");
    expect(out[0]?.etaMinutes).toBeNull();
  });

  it("treats an unknown ready_state as upstream running, not ready", () => {
    // Fail toward "not yours to grab yet" if the read model ever grows a
    // third state — the alternative invites a claim that will be refused.
    const out = mapQueueRowsToUpNext(
      [queueRow({ readyState: "SOMETHING_NEW" })],
      new Map(),
      NOW,
    );
    expect(out[0]?.readyState).toBe("UPSTREAM_RUNNING");
  });

  it("carries the label and product name the queue row already resolved", () => {
    const out = mapQueueRowsToUpNext([queueRow()], new Map(), NOW);
    expect(out[0]?.bagLabel).toBe("PO 1234 - Chocolate Brown - Bag 13");
    expect(out[0]?.productName).toBe("Chocolate Brown");
  });

  it("does not mutate the rows it was handed", () => {
    const input = [
      queueRow({
        workflowBagId: "running",
        readyState: "UPSTREAM_RUNNING",
        claimedByStationId: "blister-1",
      }),
      queueRow({ workflowBagId: "ready" }),
    ];
    mapQueueRowsToUpNext(input, new Map(), NOW);
    expect(input.map((r) => r.workflowBagId)).toEqual(["running", "ready"]);
  });
});
