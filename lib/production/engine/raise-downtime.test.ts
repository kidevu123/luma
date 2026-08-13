// P4b Task 4 — raiseDowntimeStarted. Same mocking pattern as
// raise-production-exception.test.ts's WRONG-BAG-GUARD-1 suite. Fix
// round 1 correction: the bag-resolution/wrong-bag-guard body now
// lives in emit-stationed-event.ts, but there is no
// emit-stationed-event.test.ts — that logic is exercised indirectly,
// through raise-production-exception.test.ts's WRONG-BAG-GUARD-1 suite
// (which calls raiseProductionException, a thin wrapper over the same
// shared function). This file only exercises what is specific to THIS
// wrapper — the detail-required gate, the machine_id/machine_name
// lookup (fix round 1, MED 3), and the DOWNTIME_STARTED event shape.
//
// Call order this wrapper produces: 1) the machine lookup below
// (stations LEFT JOIN machines), then emit-stationed-event.ts's own
// 2) station-exists and 3) current-bag selects.

import { describe, expect, it, vi, beforeEach } from "vitest";

const STATION_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_BAG_ID = "33333333-3333-4333-8333-333333333333";
const MACHINE_ID = "55555555-5555-4555-8555-555555555555";

type Captured = { events: Array<Record<string, unknown>> };
const captured: Captured = { events: [] };

let selectQueue: unknown[][] = [];
// Fix round 2 (nit) — lets one test make the machine lookup (the only
// caller of .leftJoin() in this file) reject, to prove
// raiseDowntimeStarted's own try/catch around it holds the total-
// function contract instead of rejecting the whole call.
let machineLookupShouldThrow = false;

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selectQueue.shift() ?? []),
        leftJoin: () => ({
          where: () => {
            if (machineLookupShouldThrow) {
              return Promise.reject(new Error("connection reset"));
            }
            return Promise.resolve(selectQueue.shift() ?? []);
          },
        }),
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

function queueMachineLookup(row: { machineId: string | null; machineName: string | null } | null): void {
  selectQueue.push(row ? [row] : []);
}

function queueStationExists(): void {
  selectQueue.push([{ id: STATION_ID }]);
}

function queueCurrentBag(workflowBagId: string | null): void {
  selectQueue.push([{ currentWorkflowBagId: workflowBagId }]);
}

beforeEach(() => {
  selectQueue = [];
  captured.events = [];
  machineLookupShouldThrow = false;
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

  it("emits DOWNTIME_STARTED pinned to the station's current bag, with machine_id/machine_name in the payload", async () => {
    queueMachineLookup({ machineId: MACHINE_ID, machineName: "Blister 2" });
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
      machine_id: MACHINE_ID,
      machine_name: "Blister 2",
    });
  });

  it("omits machine_id/machine_name when the station has no machine mounted", async () => {
    queueMachineLookup({ machineId: null, machineName: null });
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseDowntimeStarted({
      stationId: STATION_ID,
      detail: "No machine assigned but reporting anyway.",
    });

    expect(result.ok).toBe(true);
    expect(captured.events[0]?.payload).toEqual({
      detail: "No machine assigned but reporting anyway.",
    });
  });

  it("does not reject when the machine lookup itself throws — total-function contract holds, report still records", async () => {
    machineLookupShouldThrow = true;
    queueStationExists();
    queueCurrentBag(CURRENT_BAG_ID);

    const result = await raiseDowntimeStarted({
      stationId: STATION_ID,
      detail: "Machine down, and the lookup for its name also failed.",
    });

    expect(result.ok).toBe(true);
    expect(captured.events[0]?.payload).toEqual({
      detail: "Machine down, and the lookup for its name also failed.",
    });
  });

  it("returns PRODUCTION_EXCEPTION_NO_BAG when the station has no current bag pinned", async () => {
    queueMachineLookup({ machineId: MACHINE_ID, machineName: "Blister 2" });
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
