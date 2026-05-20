// VARIETY-RUNS-1 tests — action invariants + lifecycle.
//
// Tests for startOrResumeVarietyRunAction and closeVarietyRunAction.
// DB is fully mocked via a call-counter approach; no real Postgres
// connection is used.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock state ────────────────────────────────────────────────────
//
// selectResults[callIdx] drives successive .select() chains.
// Some chains end at .where() (authStation, count query),
// others chain .limit() after .where(). Both paths drain callIdx.

let callIdx = 0;
const selectResults: unknown[][] = [];

// Track insert and update calls for spy assertions.
let insertSpy: ReturnType<typeof vi.fn>;
let updateSetSpy: ReturnType<typeof vi.fn>;
let insertResults: unknown[] = [];

// A minimal tx object that mirrors the db mock shape, used inside
// db.transaction callbacks. It shares the same spies so assertions work.
const mockTx = {
  select: (_fields?: unknown) => ({
    from: (_table?: unknown) => ({
      where: (_cond?: unknown) => {
        const idx = callIdx++;
        const rows = (selectResults[idx] ?? []) as unknown[];
        return {
          then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) => {
            Promise.resolve(rows).then(resolve, reject);
          },
          limit: async (_n?: number) => rows,
        };
      },
    }),
  }),

  insert: (_table?: unknown) => ({
    values: (_vals?: unknown) => ({
      returning: async (_fields?: unknown) => {
        insertSpy();
        return insertResults;
      },
      // writeAudit calls tx.insert(auditLog).values(payload) without
      // .returning(), so we need a thenable on .values() itself too.
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        Promise.resolve(undefined).then(resolve, reject);
      },
    }),
  }),

  update: (_table?: unknown) => ({
    set: (vals: Record<string, unknown>) => ({
      where: async (_cond?: unknown) => {
        updateSetSpy(vals);
      },
    }),
  }),
};

vi.mock("@/lib/db", () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_cond?: unknown) => {
          // Capture the result index for THIS call before returning the
          // thenable / chainable object.  Both the plain `.where()` path
          // (authStation / count) and the `.where().limit()` path consume
          // one slot.
          const idx = callIdx++;
          const rows = (selectResults[idx] ?? []) as unknown[];
          return {
            // Makes the object directly awaitable (for .where() terminals).
            then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) => {
              Promise.resolve(rows).then(resolve, reject);
            },
            // For chains that call .limit() after .where().
            limit: async (_n?: number) => rows,
          };
        },
      }),
    }),

    insert: (_table?: unknown) => ({
      values: (_vals?: unknown) => ({
        returning: async (_fields?: unknown) => {
          insertSpy();
          return insertResults;
        },
      }),
    }),

    update: (_table?: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (_cond?: unknown) => {
          updateSetSpy(vals);
        },
      }),
    }),

    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(mockTx);
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  stations: {},
  varietyRuns: {},
  rawBagAllocationSessions: {},
  auditLog: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  count: () => "count()",
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/production/station-operator-session", () => ({
  resolveStationAccountability: vi.fn().mockResolvedValue({
    enteredByUserId: "test-operator-id",
    accountableEmployeeId: null,
    accountabilitySource: null,
    accountableEmployeeNameSnapshot: null,
    isStable: false,
  }),
}));

// ── Import actions AFTER mocks ────────────────────────────────────────
import {
  startOrResumeVarietyRunAction,
  closeVarietyRunAction,
} from "./variety-run-actions";

// ── Fixtures ──────────────────────────────────────────────────────────

const VALID_STATION = {
  id: "00000000-0000-0000-0000-000000000002",
  scanToken: "00000000-0000-0000-0000-000000000001",
  label: "Test Station",
  kind: "PACKAGING",
  machineId: null,
};

function validStartForm(overrides?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("token", "00000000-0000-0000-0000-000000000001");
  fd.set("stationId", "00000000-0000-0000-0000-000000000002");
  fd.set("parentScanToken", "VARIETY-CARD-001");
  fd.set("productId", "00000000-0000-0000-0000-000000000003");
  fd.set("clientEventId", "00000000-0000-0000-0000-000000000004");
  if (overrides) Object.entries(overrides).forEach(([k, v]) => fd.set(k, v));
  return fd;
}

function validCloseForm(
  varietyRunId = "00000000-0000-0000-0000-000000000010",
): FormData {
  const fd = new FormData();
  fd.set("token", "00000000-0000-0000-0000-000000000001");
  fd.set("stationId", "00000000-0000-0000-0000-000000000002");
  fd.set("varietyRunId", varietyRunId);
  fd.set("clientEventId", "00000000-0000-0000-0000-000000000005");
  return fd;
}

// ── Shared beforeEach ────────────────────────────────────────────────

beforeEach(() => {
  callIdx = 0;
  selectResults.length = 0;
  insertResults = [];
  insertSpy = vi.fn();
  updateSetSpy = vi.fn();
});

// ── startOrResumeVarietyRunAction ────────────────────────────────────

describe("startOrResumeVarietyRunAction", () => {
  it("returns error when parentScanToken is empty", async () => {
    const result = await startOrResumeVarietyRunAction(
      validStartForm({ parentScanToken: "   " }),
    );
    expect("error" in result && result.error).toBeTruthy();
  });

  it("resumes an existing OPEN run and returns resumed: true", async () => {
    // slot 0 → authStation (.where() terminal)
    selectResults[0] = [VALID_STATION];
    // slot 1 → existing OPEN run check (.where().limit(1))
    selectResults[1] = [{ id: "existing-run-id" }];

    const result = await startOrResumeVarietyRunAction(validStartForm());

    expect(result).toEqual({ ok: true, runId: "existing-run-id", resumed: true });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("creates a new run when no OPEN run exists and returns resumed: false", async () => {
    // slot 0 → auth
    selectResults[0] = [VALID_STATION];
    // slot 1 → no existing OPEN run
    selectResults[1] = [];
    // insert will return a new row
    insertResults = [{ id: "new-run-id" }];

    const result = await startOrResumeVarietyRunAction(validStartForm());

    expect(result).toEqual({ ok: true, runId: "new-run-id", resumed: false });
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it("same token returns existing run (not a second OPEN run)", async () => {
    // Calling start with an existing OPEN run must NOT insert a second run.
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ id: "existing-run-id" }];

    const result = await startOrResumeVarietyRunAction(validStartForm());

    expect(result).toEqual({ ok: true, runId: "existing-run-id", resumed: true });
    // Explicit assertion: insert must not be called.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns error when auth fails (invalid station)", async () => {
    // authStation: station not found → throws
    selectResults[0] = [];

    const result = await startOrResumeVarietyRunAction(validStartForm());

    expect("error" in result && result.error).toBeTruthy();
  });
});

// ── closeVarietyRunAction ────────────────────────────────────────────

describe("closeVarietyRunAction", () => {
  it("closes a run with no open child sessions", async () => {
    // slot 0 → auth
    selectResults[0] = [VALID_STATION];
    // slot 1 → load run (OPEN)
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN" },
    ];
    // slot 2 → count open child sessions = 0
    selectResults[2] = [{ count: 0 }];

    const result = await closeVarietyRunAction(validCloseForm());

    expect(result).toEqual({ ok: true });

    expect(updateSetSpy).toHaveBeenCalledOnce();
    const setArg = updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.status).toBe("CLOSED");
    expect(setArg.closedAt).toBeInstanceOf(Date);
  });

  it("blocks close when child sessions are still OPEN", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN" },
    ];
    // 2 open child sessions
    selectResults[2] = [{ count: 2 }];

    const result = await closeVarietyRunAction(validCloseForm());

    expect("error" in result && result.error).toMatch(
      /2 source bag session\(s\) still OPEN/,
    );
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it("returns error when run is already CLOSED", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "CLOSED" },
    ];

    const result = await closeVarietyRunAction(validCloseForm());

    expect("error" in result && result.error).toMatch(/already closed/i);
  });

  it("returns error when run is not found", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = []; // run not found

    const result = await closeVarietyRunAction(validCloseForm());

    expect("error" in result && result.error).toMatch(/not found/);
  });

  it("does not touch child sessions (only one update on varietyRuns)", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN" },
    ];
    selectResults[2] = [{ count: 0 }];

    await closeVarietyRunAction(validCloseForm());

    // Exactly one db.update() call — the variety run itself.
    // rawBagAllocationSessions must NOT be updated.
    expect(updateSetSpy).toHaveBeenCalledOnce();
  });

  it("writes audit log when closing a variety run", async () => {
    const { writeAudit } = await import("@/lib/db/audit");

    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN" },
    ];
    selectResults[2] = [{ count: 0 }];

    const result = await closeVarietyRunAction(validCloseForm());

    expect(result).toHaveProperty("ok", true);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CLOSE_VARIETY_RUN",
        targetType: "variety_run",
      }),
      expect.anything(), // tx
    );
  });
});
