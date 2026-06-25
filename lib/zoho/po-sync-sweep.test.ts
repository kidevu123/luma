import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  runPoSyncSweep,
  ZOHO_PO_SYNC_ENABLED_ENV,
} from "./po-sync-sweep";
import type { PoSyncResult } from "./po-sync";

function makeSyncResult(overrides: Partial<PoSyncResult> = {}): PoSyncResult {
  return {
    fetched: 2,
    poUpserted: 2,
    lineUpserted: 4,
    lineSkipped: 0,
    detailsFetched: 2,
    nonTabletFlagged: 0,
    errors: [],
    ...overrides,
  };
}

describe("runPoSyncSweep", () => {
  beforeEach(() => {
    vi.stubEnv(ZOHO_PO_SYNC_ENABLED_ENV, "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips when ZOHO_PO_SYNC_ENABLED is not true", async () => {
    const syncFn = vi.fn();
    const summary = await runPoSyncSweep({
      env: { [ZOHO_PO_SYNC_ENABLED_ENV]: "false" },
      syncFn,
    });
    expect(summary.status).toBe("skipped");
    expect(summary.enabled).toBe(false);
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("runs sync and persists a SUCCESS run when clean", async () => {
    const syncFn = vi.fn().mockResolvedValue(makeSyncResult());
    const persistRun = vi.fn().mockResolvedValue("run-1");

    const summary = await runPoSyncSweep({ syncFn, persistRun });

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe("success");
    expect(summary.syncRunId).toBe("run-1");
    expect(persistRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCESS",
        error: null,
        summary: expect.objectContaining({ fetched: 2, poUpserted: 2 }),
      }),
    );
  });

  it("persists PARTIAL when some POs fail but fetch succeeded", async () => {
    const persistRun = vi.fn().mockResolvedValue("run-2");
    const summary = await runPoSyncSweep({
      syncFn: vi.fn().mockResolvedValue(
        makeSyncResult({
          errors: ["Failed to upsert PO ZPO-123: boom"],
        }),
      ),
      persistRun,
    });

    expect(summary.status).toBe("partial");
    expect(persistRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PARTIAL" }),
    );
  });

  it("persists FAILED when the Zoho list fetch fails with zero upserts", async () => {
    const persistRun = vi.fn().mockResolvedValue("run-3");
    const summary = await runPoSyncSweep({
      syncFn: vi.fn().mockResolvedValue(
        makeSyncResult({
          fetched: 0,
          poUpserted: 0,
          errors: ["Zoho fetch failed: NEEDS_REAUTH"],
        }),
      ),
      persistRun,
    });

    expect(summary.status).toBe("failed");
    expect(persistRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        error: "Zoho fetch failed: NEEDS_REAUTH",
      }),
    );
  });
});
