// P4b Task 4 — raiseDowntimeStarted. Same mocking pattern as
// raise-production-exception.test.ts's WRONG-BAG-GUARD-1 suite: the
// bag-resolution/wrong-bag-guard body now lives in
// emit-stationed-event.ts and is covered there directly, so this file
// only exercises what is specific to this wrapper — the detail-required
// gate and the DOWNTIME_STARTED event shape.

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

import { raiseDowntimeStarted } from "./raise-downtime";

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

describe("raiseDowntimeStarted", () => {
  it("refuses an empty detail before touching the database", async () => {
    const result = await raiseDowntimeStarted({
      stationId: STATION_ID,
      detail: "   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("PRODUCTION_EXCEPTION_DETAIL_REQUIRED");
    }
    expect(captured.events).toHaveLength(0);
  });

  it("emits DOWNTIME_STARTED pinned to the station's current bag", async () => {
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseDowntimeStarted({
      stationId: STATION_ID,
      detail: "Blister machine will not cycle.",
      clientEventId: "cid-downtime-1",
    });

    expect(result.ok).toBe(true);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]?.eventType).toBe("DOWNTIME_STARTED");
    expect(captured.events[0]?.workflowBagId).toBe(CURRENT_BAG_ID);
    expect(captured.events[0]?.payload).toEqual({
      detail: "Blister machine will not cycle.",
    });
  });

  it("returns PRODUCTION_EXCEPTION_NO_BAG when the station has no current bag pinned", async () => {
    queueStationExists();
    queueCurrentBag(null);

    const result = await raiseDowntimeStarted({
      stationId: STATION_ID,
      detail: "Machine dead before any bag arrived today.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("PRODUCTION_EXCEPTION_NO_BAG");
    }
    expect(captured.events).toHaveLength(0);
  });
});
