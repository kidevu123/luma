import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/zoho/po-sync-sweep", () => ({
  runPoSyncSweep: vi.fn(),
}));

import { POST, GET } from "./route";
import { runPoSyncSweep } from "@/lib/zoho/po-sync-sweep";
import { writeAudit } from "@/lib/db/audit";

const SECRET = "the-correct-secret-1234567890";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/cron/zoho-po-sync", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LUMA_CRON_SECRET", SECRET);
  vi.mocked(runPoSyncSweep).mockResolvedValue({
    startedAt: "2026-06-25T03:59:00.000Z",
    finishedAt: "2026-06-25T03:59:01.000Z",
    enabled: true,
    status: "success",
    syncRunId: "run-abc",
    result: {
      fetched: 3,
      poUpserted: 3,
      lineUpserted: 6,
      lineSkipped: 0,
      detailsFetched: 3,
      nonTabletFlagged: 0,
      errors: [],
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/zoho-po-sync — auth", () => {
  it("rejects with 401 when no Authorization header is sent", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(runPoSyncSweep).not.toHaveBeenCalled();
  });

  it("accepts and runs the sweep when the bearer matches", async () => {
    const res = await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(runPoSyncSweep).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cron/zoho-po-sync — successful sweep", () => {
  it("returns the sweep summary in the response body", async () => {
    const res = await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.status).toBe("success");
    expect(body.summary.result.fetched).toBe(3);
  });

  it("writes a sweep-ran audit row", async () => {
    await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const auditEntry = vi.mocked(writeAudit).mock.calls[0]![0];
    expect(auditEntry.action).toBe("zoho_po_sync.sweep_ran");
    expect(auditEntry.actorId).toBeNull();
  });
});

describe("GET /api/cron/zoho-po-sync", () => {
  it("returns 405 — the cron is POST-only", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
