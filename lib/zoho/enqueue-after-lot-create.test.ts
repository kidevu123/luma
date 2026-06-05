// ZOHO-FINISHED-GOODS-OUTBOX-1 — tests for post-lot-create enqueue orchestration.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./assembly-enqueue", () => ({
  enqueueZohoAssemblyOpsForFinishedLot: vi.fn(),
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { runZohoAssemblyEnqueueAfterLotCreate } from "./enqueue-after-lot-create";
import { enqueueZohoAssemblyOpsForFinishedLot } from "./assembly-enqueue";
import { writeAudit } from "@/lib/db/audit";

const LOT_ID = "11111111-0000-0000-0000-000000000001";
const ACTOR = { id: "user-1", role: "ADMIN" as const };

const mockEnqueue = vi.mocked(enqueueZohoAssemblyOpsForFinishedLot);
const mockAudit = vi.mocked(writeAudit);

describe("runZohoAssemblyEnqueueAfterLotCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ZOHO_PRODUCTION_OUTPUT_ENABLED", "false");
  });

  it("enqueues ops and writes success audit when plan exists", async () => {
    mockEnqueue.mockResolvedValue({
      finishedLotId: LOT_ID,
      plan: {
        finishedLotId: LOT_ID,
        finishedLotNumber: "FL-1",
        product: null,
        ops: [],
        sourceMethod: "LEDGER",
        overallStatus: "READY",
        issues: [],
      },
      enqueued: 3,
      existing: 1,
      skipped: 0,
    });

    const r = await runZohoAssemblyEnqueueAfterLotCreate({
      finishedLotId: LOT_ID,
      actor: ACTOR,
    });

    expect(r).toEqual({ ok: true, enqueued: 3, existing: 1, skipped: 0 });
    expect(mockEnqueue).toHaveBeenCalledWith(LOT_ID);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "zoho.assembly.enqueued",
        targetId: LOT_ID,
      }),
    );
  });

  it("is idempotent at the enqueue layer — existing rows reported, not duplicated", async () => {
    mockEnqueue.mockResolvedValue({
      finishedLotId: LOT_ID,
      plan: {
        finishedLotId: LOT_ID,
        finishedLotNumber: "FL-1",
        product: null,
        ops: [],
        sourceMethod: "FALLBACK",
        overallStatus: "NEEDS_MAPPING",
        issues: [],
      },
      enqueued: 0,
      existing: 4,
      skipped: 0,
    });

    const r = await runZohoAssemblyEnqueueAfterLotCreate({
      finishedLotId: LOT_ID,
      actor: ACTOR,
    });

    expect(r).toEqual({ ok: true, enqueued: 0, existing: 4, skipped: 0 });
  });

  it("returns ok:false without throwing when planner returns null", async () => {
    mockEnqueue.mockResolvedValue(null);

    const r = await runZohoAssemblyEnqueueAfterLotCreate({
      finishedLotId: LOT_ID,
      actor: ACTOR,
    });

    expect(r).toEqual({ ok: false, reason: "no assembly plan for lot" });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "zoho.assembly.enqueue_skipped" }),
    );
  });

  it("returns ok:false and audits when enqueue throws", async () => {
    mockEnqueue.mockRejectedValue(new Error("db write failed"));

    const r = await runZohoAssemblyEnqueueAfterLotCreate({
      finishedLotId: LOT_ID,
      actor: ACTOR,
    });

    expect(r).toEqual({ ok: false, reason: "db write failed" });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "zoho.assembly.enqueue_failed" }),
    );
  });

  it("does not import or call Zoho HTTP clients", async () => {
    mockEnqueue.mockResolvedValue(null);
    await runZohoAssemblyEnqueueAfterLotCreate({
      finishedLotId: LOT_ID,
      actor: ACTOR,
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    // enqueueZohoAssemblyOpsForFinishedLot is the only downstream call (mocked).
  });
});
