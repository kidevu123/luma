// BAG-ALLOCATION tests — RAW_BAG QR card release invariants.
//
// Tests for closeAllocationSessionAction and markBagDepletedAction.
// DB is fully mocked via a call-counter approach; no real Postgres
// connection is used.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock state ─────────────────────────────────────────────────────
//
// selectResults[callIdx] drives successive .select() chains.
// Some chains end at .where() (authStation), others chain .limit()
// after .where(). Both paths drain callIdx.

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
      // markBagDepletedAction calls tx.insert(...).values({...}) without
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

    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(mockTx);
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  stations: {},
  inventoryBags: {},
  rawBagAllocationSessions: {},
  rawBagAllocationEvents: {},
  qrCards: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values }),
  desc: (a: unknown) => ({ desc: a }),
}));

vi.mock("@/lib/production/station-operator-session", () => ({
  resolveStationAccountability: vi.fn().mockResolvedValue({
    enteredByUserId: "test-operator-id",
    accountableEmployeeId: null,
    accountabilitySource: null,
    accountableEmployeeNameSnapshot: null,
    isStable: false,
  }),
  withAccountabilityPayload: vi.fn((payload: unknown) => payload),
}));

vi.mock("@/lib/production/bag-allocation", () => ({
  resolveReopenStartingBalance: vi.fn().mockReturnValue(1000),
  checkOverAllocation: vi.fn().mockReturnValue(null),
  deriveBagStatusAfterClose: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

// ── Import actions AFTER mocks ────────────────────────────────────────
import {
  closeAllocationSessionAction,
  markBagDepletedAction,
} from "./bag-allocation-actions";
import { deriveBagStatusAfterClose } from "@/lib/production/bag-allocation";

// ── Fixtures ──────────────────────────────────────────────────────────

const VALID_STATION = {
  id: "00000000-0000-0000-0000-000000000002",
  scanToken: "00000000-0000-0000-0000-000000000001",
  label: "Test Station",
  kind: "PACKAGING",
  machineId: null,
};

const VALID_SESSION = {
  id: "00000000-0000-0000-0000-000000000010",
  inventoryBagId: "00000000-0000-0000-0000-000000000011",
  allocationStatus: "OPEN",
  startingBalanceQty: 1000,
  poId: null,
  productId: null,
  routeId: null,
  workflowBagId: null,
  componentRole: null,
  finishedLotId: null,
  endingBalanceQty: null,
};

function validCloseForm(overrides?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("token", "00000000-0000-0000-0000-000000000001");
  fd.set("stationId", "00000000-0000-0000-0000-000000000002");
  fd.set("sessionId", "00000000-0000-0000-0000-000000000010");
  if (overrides) Object.entries(overrides).forEach(([k, v]) => fd.set(k, v));
  return fd;
}

function validDepletedForm(overrides?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("token", "00000000-0000-0000-0000-000000000001");
  fd.set("stationId", "00000000-0000-0000-0000-000000000002");
  fd.set("sessionId", "00000000-0000-0000-0000-000000000010");
  if (overrides) Object.entries(overrides).forEach(([k, v]) => fd.set(k, v));
  return fd;
}

// ── Shared beforeEach ─────────────────────────────────────────────────

beforeEach(() => {
  callIdx = 0;
  selectResults.length = 0;
  insertResults = [];
  insertSpy = vi.fn();
  updateSetSpy = vi.fn();
  vi.mocked(deriveBagStatusAfterClose).mockReset();
  vi.mocked(deriveBagStatusAfterClose).mockReturnValue(null);
});

// ── closeAllocationSessionAction ──────────────────────────────────────

describe("closeAllocationSessionAction — RAW_BAG QR card release", () => {
  it("does not release RAW_BAG QR when bag still has remaining quantity", async () => {
    // deriveBagStatusAfterClose returns "AVAILABLE" → not EMPTIED → no QR release
    vi.mocked(deriveBagStatusAfterClose).mockReturnValueOnce("AVAILABLE");

    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_SESSION];
    selectResults[2] = [{ bagQrCode: "bag-qr-001" }]; // bagQrCode loaded

    const fd = validCloseForm({ endingBalanceQty: "500" });
    const result = await closeAllocationSessionAction(fd);

    expect(result).toHaveProperty("ok", true);
    // The update calls: rawBagAllocationSessions + inventoryBags (from "AVAILABLE")
    // No qrCards update because AVAILABLE ≠ EMPTIED
    const allUpdateCalls = updateSetSpy.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const qrUpdate = allUpdateCalls.find((c: Record<string, unknown>) => c.status === "IDLE");
    expect(qrUpdate).toBeUndefined();
  });

  it("releases RAW_BAG QR to IDLE when bag is depleted (endingBalanceQty=0)", async () => {
    vi.mocked(deriveBagStatusAfterClose).mockReturnValueOnce("EMPTIED");

    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_SESSION];
    selectResults[2] = [{ bagQrCode: "bag-qr-001" }];
    // [3] inside tx — the qrCards lookup
    selectResults[3] = [{ id: "qr-card-id-001", cardType: "RAW_BAG", status: "ASSIGNED" }];

    const fd = validCloseForm({ endingBalanceQty: "0" });
    const result = await closeAllocationSessionAction(fd);

    expect(result).toHaveProperty("ok", true);
    const allUpdateCalls = updateSetSpy.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const qrUpdate = allUpdateCalls.find((c: Record<string, unknown>) => c.status === "IDLE");
    expect(qrUpdate).toBeDefined();
    expect(qrUpdate?.status).toBe("IDLE");
  });

  it("does not release a non-RAW_BAG card type", async () => {
    vi.mocked(deriveBagStatusAfterClose).mockReturnValueOnce("EMPTIED");

    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_SESSION];
    selectResults[2] = [{ bagQrCode: "bag-qr-002" }];
    // card exists but is VARIETY_PACK
    selectResults[3] = [{ id: "qr-card-id-002", cardType: "VARIETY_PACK", status: "ASSIGNED" }];

    const fd = validCloseForm({ endingBalanceQty: "0" });
    const result = await closeAllocationSessionAction(fd);

    expect(result).toHaveProperty("ok", true);
    const allUpdateCalls = updateSetSpy.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const qrUpdate = allUpdateCalls.find((c: Record<string, unknown>) => c.status === "IDLE");
    expect(qrUpdate).toBeUndefined();
  });
});

// ── markBagDepletedAction ─────────────────────────────────────────────

describe("markBagDepletedAction — RAW_BAG QR card release", () => {
  it("releases RAW_BAG QR to IDLE when marking bag as depleted", async () => {
    selectResults[0] = [VALID_STATION];
    selectResults[1] = [VALID_SESSION];
    selectResults[2] = [{ bagQrCode: "bag-qr-001" }];
    // [3] inside tx — qrCards lookup
    selectResults[3] = [{ id: "qr-card-id-001", cardType: "RAW_BAG", status: "ASSIGNED" }];

    const result = await markBagDepletedAction(validDepletedForm());

    expect(result).toHaveProperty("ok", true);
    const allUpdateCalls = updateSetSpy.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const qrUpdate = allUpdateCalls.find((c: Record<string, unknown>) => c.status === "IDLE");
    expect(qrUpdate).toBeDefined();
    expect(qrUpdate?.status).toBe("IDLE");
  });
});
