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
        insertSpy(_vals);
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
          insertSpy(_vals);
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
  qrCards: {},
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

const VALID_VARIETY_CARD = {
  id: "00000000-0000-0000-0000-000000000020",
  cardType: "VARIETY_PACK",
  status: "IDLE",
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
    // slot 1 → QR card lookup (NEW)
    selectResults[1] = [VALID_VARIETY_CARD];
    // slot 2 → existing OPEN run check (.where().limit(1))
    selectResults[2] = [{ id: "existing-run-id" }];

    const result = await startOrResumeVarietyRunAction(validStartForm());

    expect(result).toEqual({ ok: true, runId: "existing-run-id", resumed: true });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("creates a new run when no OPEN run exists and returns resumed: false", async () => {
    // slot 0 → auth
    selectResults[0] = [VALID_STATION];
    // slot 1 → QR card lookup (NEW)
    selectResults[1] = [VALID_VARIETY_CARD];
    // slot 2 → no existing OPEN run
    selectResults[2] = [];
    // insert will return a new row
    insertResults = [{ id: "new-run-id" }];

    const result = await startOrResumeVarietyRunAction(validStartForm());

    expect(result).toEqual({ ok: true, runId: "new-run-id", resumed: false });
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it("same token returns existing run (not a second OPEN run)", async () => {
    // Calling start with an existing OPEN run must NOT insert a second run.
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_VARIETY_CARD];
    selectResults[2] = [{ id: "existing-run-id" }];

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

  // ── New QR card validation tests ──────────────────────────────────

  it("returns error when variety QR card is not found", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = []; // card not found
    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect("error" in result && result.error).toMatch(/not found/i);
  });

  it("returns error when token is a RAW_BAG card, not VARIETY_PACK", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ id: "xxx", cardType: "RAW_BAG", status: "IDLE" }];
    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect("error" in result && result.error).toBe("This is not a variety pack QR card.");
  });

  it("returns error when VARIETY_PACK card is RETIRED", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ id: "xxx", cardType: "VARIETY_PACK", status: "RETIRED" }];
    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect("error" in result && result.error).toBe("This variety pack QR card is retired.");
  });

  it("returns error when VARIETY_PACK card is already ASSIGNED (no open run for this token)", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ id: "xxx", cardType: "VARIETY_PACK", status: "ASSIGNED" }];
    selectResults[2] = []; // no open run
    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect("error" in result && result.error).toBe("This variety pack QR card is already in use by an open variety run.");
  });

  it("sets QR card to ASSIGNED when opening a new variety run", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_VARIETY_CARD];
    selectResults[2] = []; // no open run
    insertResults = [{ id: "new-run-id" }];
    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect(result).toEqual({ ok: true, runId: "new-run-id", resumed: false });
    // updateSetSpy should have been called with { status: "ASSIGNED" }
    expect(updateSetSpy).toHaveBeenCalledWith({ status: "ASSIGNED" });
  });

  it("does not change QR status when resuming an existing open run", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ ...VALID_VARIETY_CARD, status: "ASSIGNED" }]; // already assigned
    selectResults[2] = [{ id: "existing-run-id" }]; // open run exists
    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect(result).toEqual({ ok: true, runId: "existing-run-id", resumed: true });
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it("stores varietyQrCardId in the new run row", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_VARIETY_CARD]; // VARIETY_PACK, IDLE
    selectResults[2] = [];                   // no open run
    insertResults = [{ id: "new-run-id" }];

    const result = await startOrResumeVarietyRunAction(validStartForm());
    expect(result).toEqual({ ok: true, runId: "new-run-id", resumed: false });

    // The insert spy was called once (for the variety run insert + returning)
    expect(insertSpy).toHaveBeenCalledOnce();
    // Verify varietyQrCardId was passed in the insert values
    const insertVals = insertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertVals?.varietyQrCardId).toBe(VALID_VARIETY_CARD.id);
    // The update spy was called with ASSIGNED for the QR card
    expect(updateSetSpy).toHaveBeenCalledWith({ status: "ASSIGNED" });
  });
});

// ── closeVarietyRunAction ────────────────────────────────────────────

describe("closeVarietyRunAction", () => {
  it("closes a run with no open child sessions", async () => {
    // slot 0 → auth
    selectResults[0] = [VALID_STATION];
    // slot 1 → load run (OPEN) — must include parentScanToken
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN", parentScanToken: "VARIETY-CARD-001", varietyQrCardId: "00000000-0000-0000-0000-000000000020" },
    ];
    // slot 2 → count open child sessions = 0
    selectResults[2] = [{ count: 0 }];
    // slot 3 → QR card lookup inside tx (NEW)
    selectResults[3] = [{ id: "00000000-0000-0000-0000-000000000020", status: "ASSIGNED" }];

    const result = await closeVarietyRunAction(validCloseForm());

    expect(result).toEqual({ ok: true });

    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    const firstCall = updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.status).toBe("CLOSED");
    expect(firstCall.closedAt).toBeInstanceOf(Date);
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

  it("does not touch child sessions (rawBagAllocationSessions must NOT be updated)", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN", parentScanToken: "VARIETY-CARD-001", varietyQrCardId: "00000000-0000-0000-0000-000000000020" },
    ];
    selectResults[2] = [{ count: 0 }];
    // QR card found and ASSIGNED → triggers second update (qrCards, not rawBagAllocationSessions)
    selectResults[3] = [{ id: "00000000-0000-0000-0000-000000000020", status: "ASSIGNED" }];

    await closeVarietyRunAction(validCloseForm());

    // Two update calls: variety run + QR card. Neither is rawBagAllocationSessions.
    expect(updateSetSpy).toHaveBeenCalledTimes(2);
  });

  it("writes audit log when closing a variety run", async () => {
    const { writeAudit } = await import("@/lib/db/audit");

    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      { id: "00000000-0000-0000-0000-000000000010", status: "OPEN", parentScanToken: "VARIETY-CARD-001", varietyQrCardId: "00000000-0000-0000-0000-000000000020" },
    ];
    selectResults[2] = [{ count: 0 }];
    selectResults[3] = [{ id: "00000000-0000-0000-0000-000000000020", status: "ASSIGNED" }];

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

  // ── New QR card release tests ─────────────────────────────────────

  it("releases VARIETY_PACK QR card to IDLE when closing a run", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ id: "00000000-0000-0000-0000-000000000010", status: "OPEN", parentScanToken: "VARIETY-CARD-001", varietyQrCardId: "00000000-0000-0000-0000-000000000020" }];
    selectResults[2] = [{ count: 0 }];
    selectResults[3] = [{ id: "00000000-0000-0000-0000-000000000020", status: "ASSIGNED" }]; // QR card

    const result = await closeVarietyRunAction(validCloseForm());
    expect(result).toHaveProperty("ok", true);

    // First update: variety run → CLOSED; second update: QR card → IDLE
    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    const qrUpdate = updateSetSpy.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(qrUpdate.status).toBe("IDLE");
  });

  it("does not crash when VARIETY_PACK QR card is missing (legacy run)", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [{ id: "00000000-0000-0000-0000-000000000010", status: "OPEN", parentScanToken: "LEGACY-TOKEN", varietyQrCardId: null }];
    selectResults[2] = [{ count: 0 }];
    selectResults[3] = []; // QR card not found

    const result = await closeVarietyRunAction(validCloseForm());
    expect(result).toHaveProperty("ok", true);
    // Only one update (variety run), no QR update
    expect(updateSetSpy).toHaveBeenCalledOnce();
    const setArg = updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.status).toBe("CLOSED");
  });

  it("uses varietyQrCardId (FK) to look up QR card when available", async () => {
    const { writeAudit } = await import("@/lib/db/audit");

    selectResults[0] = [VALID_STATION];
    selectResults[1] = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        status: "OPEN",
        parentScanToken: "VARIETY-CARD-001",
        varietyQrCardId: "00000000-0000-0000-0000-000000000020",
      },
    ];
    selectResults[2] = [{ count: 0 }];
    // [3] QR card lookup by id (FK path)
    selectResults[3] = [{ id: "00000000-0000-0000-0000-000000000020", status: "ASSIGNED" }];

    const result = await closeVarietyRunAction(validCloseForm());
    expect(result).toHaveProperty("ok", true);
    // Variety run updated + QR card updated = 2 updates
    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "VARIETY_QR_RELEASED" }),
      expect.anything(),
    );
  });
});
