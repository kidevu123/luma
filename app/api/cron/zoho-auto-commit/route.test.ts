// Route-level contract tests for the cron endpoint. We exercise the
// auth gate end-to-end and the success path with mocked DB + sweep
// internals. The sweep itself has its own dedicated test file in
// lib/zoho/auto-commit-sweep.test.ts.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/zoho/auto-commit-sweep", () => ({
  runAutoCommitSweep: vi.fn(),
}));

import { POST, GET } from "./route";
import { runAutoCommitSweep } from "@/lib/zoho/auto-commit-sweep";
import { writeAudit } from "@/lib/db/audit";

const SECRET = "the-correct-secret-1234567890";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/cron/zoho-auto-commit", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LUMA_CRON_SECRET", SECRET);
  vi.mocked(runAutoCommitSweep).mockResolvedValue({
    gates: {
      autoCommitEnabled: false,
      rawBagWritesAllowed: false,
      productionOutputWritesAllowed: false,
      reasons: {},
    },
    startedAt: "2026-06-15T12:00:00.000Z",
    finishedAt: "2026-06-15T12:00:00.001Z",
    rawBagEligibleConsidered: 0,
    productionOutputEligibleConsidered: 0,
    rows: [],
    totals: {
      committed: 0,
      needs_review: 0,
      needs_mapping: 0,
      transport_retryable: 0,
      permanent_failure: 0,
      state_blocked: 0,
      skipped_guard_blocked: 0,
      skipped_master_off: 0,
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/zoho-auto-commit — auth", () => {
  it("rejects with 401 when no Authorization header is sent", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(runAutoCommitSweep).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the bearer token is wrong", async () => {
    const res = await POST(makeReq({ authorization: `Bearer not-${SECRET}` }));
    expect(res.status).toBe(401);
    expect(runAutoCommitSweep).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the scheme is not Bearer", async () => {
    const res = await POST(makeReq({ authorization: `Basic ${SECRET}` }));
    expect(res.status).toBe(401);
    expect(runAutoCommitSweep).not.toHaveBeenCalled();
  });

  it("rejects with 503 when LUMA_CRON_SECRET is not configured (infra problem)", async () => {
    vi.stubEnv("LUMA_CRON_SECRET", "");
    const res = await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(503);
    expect(runAutoCommitSweep).not.toHaveBeenCalled();
  });

  it("accepts and runs the sweep when the bearer matches", async () => {
    const res = await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(runAutoCommitSweep).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cron/zoho-auto-commit — successful sweep", () => {
  it("returns the sweep summary in the response body", async () => {
    const res = await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.startedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(body.summary.totals.committed).toBe(0);
  });

  it("writes a sweep-ran audit row with totals and gates", async () => {
    await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const auditEntry = vi.mocked(writeAudit).mock.calls[0]![0];
    expect(auditEntry.action).toBe("zoho_auto_commit.sweep_ran");
    expect(auditEntry.actorId).toBeNull();
    expect(auditEntry.actorRole).toBeNull();
    // Totals + gates are inside the audit payload
    const after = auditEntry.after as Record<string, unknown>;
    expect(after).toHaveProperty("totals");
    expect(after).toHaveProperty("gates");
    expect((after.gates as Record<string, unknown>).autoCommitEnabled).toBe(false);
  });
});

describe("POST /api/cron/zoho-auto-commit — sweep error", () => {
  it("returns 500 with the error message when the sweep throws", async () => {
    vi.mocked(runAutoCommitSweep).mockRejectedValueOnce(new Error("Boom"));
    const res = await POST(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe("Boom");
  });
});

describe("GET /api/cron/zoho-auto-commit", () => {
  it("returns 405 — the cron is POST-only", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
