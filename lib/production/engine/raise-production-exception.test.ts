// P4b Task 2 fix round 1 (F3) — WRONG-BAG-GUARD-1 behavioral coverage.
//
// projectEvent's read_station_live upsert re-pins current_workflow_bag_id
// for ANY stationed event that isn't BAG_FINALIZED/BAG_RELEASED
// (lib/projector/index.ts:402-424). raiseProductionException must refuse
// to emit — rather than silently hijacking the station's pin — when a
// caller-supplied workflowBagId disagrees with the station's actual
// current bag. This file exercises that guard through mocked db/
// projector/accountability layers, following the pattern established by
// lib/production/qc-actions.test.ts.

import { describe, expect, it, vi, beforeEach } from "vitest";

const STATION_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_BAG_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_BAG_ID = "44444444-4444-4444-8444-444444444444";

type Captured = {
  events: Array<Record<string, unknown>>;
};

const captured: Captured = { events: [] };

// FIFO queue of `db.select().from().where()` results. The source calls
// this exactly twice before any branch decision: stations (existence),
// then readStationLive (current pin) — in that order.
let selectQueue: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selectQueue.shift() ?? []),
      }),
    }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({}),
  },
}));

vi.mock("@/lib/projector", () => ({
  projectEvent: vi.fn(async (_tx: unknown, ev: Record<string, unknown>) => {
    captured.events.push(ev);
  }),
}));

vi.mock("@/lib/production/station-operator-session", () => ({
  resolveStationAccountability: vi.fn(async () => ({
    enteredByUserId: null,
    accountableEmployeeId: "employee-1",
    accountabilitySource: "STATION_OPERATOR_SESSION",
    accountableEmployeeNameSnapshot: "Jordan Operator",
  })),
}));

import { raiseProductionException } from "./raise-production-exception";

function queueStationExists(): void {
  selectQueue.push([{ id: STATION_ID }]);
}

function queueCurrentBag(workflowBagId: string | null): void {
  selectQueue.push([{ currentWorkflowBagId: workflowBagId }]);
}

beforeEach(() => {
  selectQueue = [];
  captured.events = [];
  vi.clearAllMocks();
});

describe("raiseProductionException — WRONG-BAG-GUARD-1", () => {
  it("refuses a supplied workflowBagId that disagrees with the station's current bag", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseProductionException({
      stationId: STATION_ID,
      workflowBagId: OTHER_BAG_ID,
      category: "MATERIAL",
      detail: "Wrong PVC roll loaded.",
      clientEventId: "cid-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("PRODUCTION_EXCEPTION_WRONG_BAG");
      // supervisorDetail names both ids so a supervisor can tell exactly
      // what disagreed.
      expect(result.blocker.supervisorDetail).toContain(OTHER_BAG_ID);
      expect(result.blocker.supervisorDetail).toContain(CURRENT_BAG_ID);
    }
    // The whole point of the guard: no event reaches projectEvent, so
    // read_station_live is never touched by this call.
    expect(captured.events).toHaveLength(0);
  });

  it("accepts a supplied workflowBagId that matches the station's current bag", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseProductionException({
      stationId: STATION_ID,
      workflowBagId: CURRENT_BAG_ID,
      category: "PRODUCT",
      detail: "Wrong SKU on the card.",
    });

    expect(result.ok).toBe(true);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]?.workflowBagId).toBe(CURRENT_BAG_ID);
  });

  it("accepts a supplied workflowBagId when the station has no current bag pinned — nothing to hijack", () => {
    queueStationExists();
    queueCurrentBag(null);

    return raiseProductionException({
      stationId: STATION_ID,
      workflowBagId: OTHER_BAG_ID,
      category: "OTHER",
      detail: "Line is stopped, cause unclear.",
    }).then((result) => {
      expect(result.ok).toBe(true);
      expect(captured.events).toHaveLength(1);
      expect(captured.events[0]?.workflowBagId).toBe(OTHER_BAG_ID);
    });
  });

  it("falls back to the station's current bag when workflowBagId is omitted", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseProductionException({
      stationId: STATION_ID,
      category: "MATERIAL",
      detail: "Foil roll jammed.",
    });

    expect(result.ok).toBe(true);
    expect(captured.events[0]?.workflowBagId).toBe(CURRENT_BAG_ID);
  });

  it("returns PRODUCTION_EXCEPTION_NO_BAG when neither a supplied nor a pinned bag exists", async () => {
    queueStationExists();
    queueCurrentBag(null);

    const result = await raiseProductionException({
      stationId: STATION_ID,
      category: "OTHER",
      detail: "Nothing at this station right now.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("PRODUCTION_EXCEPTION_NO_BAG");
    }
    expect(captured.events).toHaveLength(0);
  });
});
