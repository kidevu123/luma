import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";

const ACTOR: CurrentUser = {
  id: "admin-1",
  role: "ADMIN",
  email: "admin@example.com",
} as CurrentUser;

const OP_ID = "44444444-4444-4444-8444-444444444444";

let selectIdx = 0;
const selectResults: unknown[][] = [];
const updateReturningQueue: unknown[][] = [];
let updateCallCount = 0;
const auditWrites: Array<{ action: string }> = [];

function makeSelectChain(resolveSlot: () => Promise<unknown[]>): unknown {
  return {
    then: (res: (v: unknown[]) => void, rej: (e: unknown) => void) =>
      resolveSlot().then(res, rej),
    from: () => makeSelectChain(resolveSlot),
    where: () => makeSelectChain(resolveSlot),
    limit: () => resolveSlot(),
  };
}

function nextSlot(): Promise<unknown[]> {
  return Promise.resolve((selectResults[selectIdx++] ?? []) as unknown[]);
}

function makeUpdateChain() {
  const returningFn = async () => {
    updateCallCount += 1;
    return updateReturningQueue.shift() ?? [];
  };
  return {
    set: () => ({
      where: () => ({
        returning: returningFn,
      }),
      returning: returningFn,
    }),
  };
}

const txMock = {
  select: () => makeSelectChain(nextSlot),
  update: () => makeUpdateChain(),
};

vi.mock("@/lib/db", () => ({
  db: {
    select: () => makeSelectChain(nextSlot),
    update: () => makeUpdateChain(),
    transaction: async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn(async (entry: { action: string }) => {
    auditWrites.push({ action: entry.action });
  }),
}));

vi.mock("@/lib/db/schema", () => ({
  finishedLots: "finishedLots",
  zohoAssemblyOps: "zohoAssemblyOps",
  zohoProductionOutputOps: "zohoProductionOutputOps",
  zohoPushes: "zohoPushes",
}));

import {
  claimZohoProductionOutputOpForCommit,
  completeZohoProductionOutputCommitFailure,
  completeZohoProductionOutputCommitSuccess,
  processQueuedZohoProductionOutputCommitWithMockGateway,
} from "./zoho-production-output";
import { mockCallZohoProductionOutputCommit } from "@/lib/zoho/production-output-commit-mock";

function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OP_ID,
    status: "QUEUED",
    voidedAt: null,
    lumaOperationId: "luma-op-1",
    approvedRequestHash: "hash-a",
    requestHash: "hash-a",
    requestPayload: { purchaseorder_id: "po-1", quantity_good: 5 },
    previewResponse: { preview: true },
    previewHttpStatus: 200,
    metricsState: "HIGH",
    genealogyState: "HIGH",
    finishedLotId: "11111111-1111-4111-8111-111111111111",
    commitIdempotencyKey: "luma-production-output:luma-op-1:hash-a",
    externalReferenceId: null,
    commitAttemptCount: 0,
    commitStartedAt: null,
    ...overrides,
  };
}

function primeClaimSelects(row: ReturnType<typeof queuedRow>) {
  selectResults.push(
    [row],
    [{ value: 1 }],
    [{ value: 0 }],
    [{ value: 0 }],
    [{ value: 0 }],
  );
}

beforeEach(() => {
  selectIdx = 0;
  selectResults.length = 0;
  updateReturningQueue.length = 0;
  updateCallCount = 0;
  auditWrites.length = 0;
  vi.clearAllMocks();
});

describe("claimZohoProductionOutputOpForCommit", () => {
  it("transitions QUEUED to COMMITTING and writes audit", async () => {
    const row = queuedRow();
    primeClaimSelects(row);
    updateReturningQueue.push([
      {
        ...row,
        status: "COMMITTING",
        commitAttemptCount: 1,
        commitStartedAt: new Date("2026-06-01T12:00:00Z"),
      },
    ]);

    const result = await claimZohoProductionOutputOpForCommit(OP_ID, ACTOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op.status).toBe("COMMITTING");
    expect(result.op.commitAttemptCount).toBe(1);
    expect(
      auditWrites.some((a) => a.action === "zoho_production_output_op.commit_started"),
    ).toBe(true);
  });

  it("fails when legacy assembly ops exist before claim", async () => {
    const row = queuedRow();
    selectResults.push(
      [row],
      [{ value: 1 }],
      [{ value: 0 }],
      [{ value: 1 }],
      [{ value: 0 }],
    );

    const result = await claimZohoProductionOutputOpForCommit(OP_ID, ACTOR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Legacy Zoho assembly");
    expect(updateCallCount).toBe(0);
  });

  it("fails when already committing", async () => {
    const row = queuedRow();
    primeClaimSelects(row);
    selectResults.push([{ status: "COMMITTING" }]);
    updateReturningQueue.push([]);

    const result = await claimZohoProductionOutputOpForCommit(OP_ID, ACTOR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already being committed");
  });
});

describe("completeZohoProductionOutputCommitSuccess", () => {
  it("marks COMMITTING as COMMITTED with external reference", async () => {
    updateReturningQueue.push([
      {
        ...queuedRow({ status: "COMMITTING" }),
        status: "COMMITTED",
        externalReferenceId: "zoho-ref-1",
        committedAt: new Date(),
      },
    ]);

    const result = await completeZohoProductionOutputCommitSuccess(OP_ID, ACTOR, {
      commitResponse: { ok: true },
      externalReferenceId: "zoho-ref-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op.status).toBe("COMMITTED");
    expect(
      auditWrites.some((a) => a.action === "zoho_production_output_op.commit_succeeded"),
    ).toBe(true);
  });

  it("rejects completion from non-COMMITTING status", async () => {
    updateReturningQueue.push([]);
    const result = await completeZohoProductionOutputCommitSuccess(OP_ID, ACTOR, {
      commitResponse: {},
    });
    expect(result.ok).toBe(false);
  });
});

describe("completeZohoProductionOutputCommitFailure", () => {
  it("marks COMMITTING as FAILED without committed_at", async () => {
    updateReturningQueue.push([
      {
        ...queuedRow({ status: "COMMITTING" }),
        status: "FAILED",
        commitError: "validation failed",
        committedAt: null,
        externalReferenceId: null,
      },
    ]);

    const result = await completeZohoProductionOutputCommitFailure(OP_ID, ACTOR, {
      commitError: "validation failed",
      commitResponse: { error: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op.status).toBe("FAILED");
    expect(result.op.committedAt).toBeNull();
    expect(
      auditWrites.some((a) => a.action === "zoho_production_output_op.commit_failed"),
    ).toBe(true);
  });
});

describe("processQueuedZohoProductionOutputCommitWithMockGateway", () => {
  it("claim → mock success → COMMITTED using stored request_payload", async () => {
    const row = queuedRow();
    primeClaimSelects(row);
    updateReturningQueue.push(
      [{ ...row, status: "COMMITTING", commitAttemptCount: 1 }],
      [
        {
          ...row,
          status: "COMMITTED",
          externalReferenceId: "zoho-mock-1",
          committedAt: new Date(),
        },
      ],
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await processQueuedZohoProductionOutputCommitWithMockGateway(
      OP_ID,
      ACTOR,
      { outcome: "success", externalReferenceId: "zoho-mock-1" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op.status).toBe("COMMITTED");
    expect(result.gateway.ok).toBe(true);
    if (result.gateway.ok) {
      expect(result.gateway.requestPayload).toEqual(row.requestPayload);
      expect(result.gateway.idempotencyKey).toBe(row.commitIdempotencyKey);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("claim → mock failure → FAILED", async () => {
    const row = queuedRow();
    primeClaimSelects(row);
    updateReturningQueue.push(
      [{ ...row, status: "COMMITTING", commitAttemptCount: 1 }],
      [
        {
          ...row,
          status: "FAILED",
          commitError: "mock validation failed",
          committedAt: null,
        },
      ],
    );

    const result = await processQueuedZohoProductionOutputCommitWithMockGateway(
      OP_ID,
      ACTOR,
      { outcome: "failure", message: "mock validation failed" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.phase).toBe("gateway");
    expect(result.error).toContain("mock validation failed");
  });
});

describe("mockCallZohoProductionOutputCommit", () => {
  it("passes idempotency key and payload through", () => {
    const payload = { purchaseorder_id: "po-1" };
    const gateway = mockCallZohoProductionOutputCommit({
      requestPayload: payload,
      commitIdempotencyKey: "idem-key",
      fixture: { outcome: "success" },
    });
    expect(gateway.idempotencyKey).toBe("idem-key");
    expect(gateway.requestPayload).toBe(payload);
  });
});
