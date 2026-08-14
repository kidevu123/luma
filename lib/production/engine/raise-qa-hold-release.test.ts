// P4b Task 4 fix round 2 (N1) — raiseQaHoldRelease. Same mocking
// pattern as raise-qa-hold.test.ts / raise-downtime.test.ts; the
// shared bag-resolution/wrong-bag-guard body is exercised indirectly
// via raise-production-exception.test.ts's WRONG-BAG-GUARD-1 suite
// (no dedicated emit-stationed-event.test.ts exists). This file only
// exercises what is specific to this wrapper: the optional-detail
// default and the QA_HOLD_RELEASED event shape.

import { describe, expect, it, vi, beforeEach } from "vitest";

const STATION_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_BAG_ID = "33333333-3333-4333-8333-333333333333";

type Captured = { events: Array<Record<string, unknown>> };
const captured: Captured = { events: [] };

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

import { raiseQaHoldRelease } from "./raise-qa-hold-release";

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

describe("raiseQaHoldRelease", () => {
  it("does NOT require a detail — unlike raiseQaHoldStarted, an omitted note still records the release (N1: releasing must be at least as easy as raising)", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseQaHoldRelease({
      stationId: STATION_ID,
      workflowBagId: CURRENT_BAG_ID,
    });

    expect(result.ok).toBe(true);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]?.eventType).toBe("QA_HOLD_RELEASED");
    expect(captured.events[0]?.payload).toEqual({ detail: "Hold released." });
  });

  it("uses the supplied detail when one is given", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseQaHoldRelease({
      stationId: STATION_ID,
      workflowBagId: CURRENT_BAG_ID,
      detail: "Re-inspected, seal is fine.",
      clientEventId: "cid-qa-release-1",
    });

    expect(result.ok).toBe(true);
    expect(captured.events[0]?.payload).toEqual({
      detail: "Re-inspected, seal is fine.",
    });
  });

  it("treats a whitespace-only detail the same as omitted", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseQaHoldRelease({
      stationId: STATION_ID,
      workflowBagId: CURRENT_BAG_ID,
      detail: "   ",
    });

    expect(result.ok).toBe(true);
    expect(captured.events[0]?.payload).toEqual({ detail: "Hold released." });
  });

  it("returns PRODUCTION_EXCEPTION_NO_BAG when the station has no current bag pinned and none was supplied", async () => {
    queueStationExists();
    queueCurrentBag(null);

    const result = await raiseQaHoldRelease({
      stationId: STATION_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("PRODUCTION_EXCEPTION_NO_BAG");
    }
    expect(captured.events).toHaveLength(0);
  });
});
