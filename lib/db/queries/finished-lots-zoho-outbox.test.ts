// ZOHO-FINISHED-GOODS-OUTBOX-1 — createFinishedLot triggers Zoho outbox enqueue.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEnqueue = vi.fn();

vi.mock("@/lib/zoho/enqueue-after-lot-create", () => ({
  runZohoAssemblyEnqueueAfterLotCreate: (...args: unknown[]) => mockEnqueue(...args),
}));

vi.mock("@/lib/db", () => ({
  db: {
    transaction: vi.fn().mockResolvedValue({
      lot: { id: "11111111-0000-0000-0000-000000000001" },
      inputs: [],
    }),
  },
}));

import { createFinishedLot } from "./finished-lots";

const ACTOR = {
  id: "user-1",
  role: "ADMIN" as const,
  email: "admin@test.local",
  employeeId: null,
};

describe("createFinishedLot Zoho outbox hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueue.mockResolvedValue({ ok: true, enqueued: 2, existing: 0, skipped: 0 });
  });

  it("calls runZohoAssemblyEnqueueAfterLotCreate after the transaction commits", async () => {
    const r = await createFinishedLot(
      {
        productId: "dddddddd-0000-0000-0000-000000000001",
        finishedLotNumber: "FL-TEST-1",
        producedOn: "2026-05-29",
        expiryDate: "2027-05-29",
        unitsProduced: 100,
      },
      ACTOR,
    );

    expect(r.lot.id).toBe("11111111-0000-0000-0000-000000000001");
    expect(mockEnqueue).toHaveBeenCalledWith({
      finishedLotId: "11111111-0000-0000-0000-000000000001",
      actor: ACTOR,
    });
  });

  it("returns the lot even when enqueue rejects", async () => {
    mockEnqueue.mockResolvedValue({ ok: false, reason: "db write failed" });

    const r = await createFinishedLot(
      {
        productId: "dddddddd-0000-0000-0000-000000000001",
        finishedLotNumber: "FL-TEST-2",
        producedOn: "2026-05-29",
        expiryDate: "2027-05-29",
        unitsProduced: 100,
      },
      ACTOR,
    );

    expect(r.lot.id).toBeTruthy();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("returns the lot when enqueue throws unexpectedly", async () => {
    mockEnqueue.mockRejectedValue(new Error("unexpected"));

    const r = await createFinishedLot(
      {
        productId: "dddddddd-0000-0000-0000-000000000001",
        finishedLotNumber: "FL-TEST-3",
        producedOn: "2026-05-29",
        expiryDate: "2027-05-29",
        unitsProduced: 100,
      },
      ACTOR,
    );

    expect(r.lot.id).toBeTruthy();
  });
});
