import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared state shared between db mock and tx mock ─────────────────────────

let selectIdx = 0;
const selectResults: unknown[][] = [];

const txUpdates: Array<{ table: unknown; set: unknown }> = [];
const txInserts: Array<{ table: unknown; values: unknown }> = [];
const auditWrites: unknown[] = [];

// ─── Helper: build a chainable select that resolves a selectResults slot ─────
//
// The actual Drizzle query chains used in bag-edits.ts vary in shape:
//   - .from().leftJoin().where()           (getBagForEdit bag row)
//   - .from().where().limit()              (getBagForEdit in-prod check)
//   - .from().where()                      (tx: old/new qr card lookup)
//   - .from().leftJoin().leftJoin().where().limit()   (tx: existing bag check)
//   - .from().where().limit()              (tx: receipt# conflict, batch lookup)
//
// We implement a fluent proxy so that ANY terminal await returns the next slot
// regardless of which intermediate method was called last.

function makeSelectChain(resolveSlot: () => Promise<unknown[]>): unknown {
  const thenable = {
    then: (res: (v: unknown[]) => void, rej: (e: unknown) => void) =>
      resolveSlot().then(res, rej),
    // Methods that return another chainable node
    from: (_t?: unknown) => makeSelectChain(resolveSlot),
    leftJoin: (_t?: unknown, _c?: unknown) => makeSelectChain(resolveSlot),
    where: (_c?: unknown) => makeSelectChain(resolveSlot),
    limit: (_n?: unknown) => resolveSlot(), // limit returns the raw Promise
  };
  return thenable;
}

function nextSlot(): Promise<unknown[]> {
  return Promise.resolve((selectResults[selectIdx++] ?? []) as unknown[]);
}

// ─── Transaction mock ─────────────────────────────────────────────────────────

const txMock = {
  select: (_fields?: unknown) => makeSelectChain(nextSlot),
  update: (table: unknown) => ({
    set: (values: unknown) => ({
      where: async (_cond?: unknown) => {
        txUpdates.push({ table, set: values });
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: (vals: unknown) => ({
      returning: async (_fields?: unknown) => {
        txInserts.push({ table, values: vals });
        return [{ id: "new-batch-id" }];
      },
    }),
  }),
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: (_fields?: unknown) => makeSelectChain(nextSlot),
    transaction: async (fn: (tx: typeof txMock) => Promise<unknown>) => {
      return fn(txMock);
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  inventoryBags: "inventoryBags",
  qrCards: "qrCards",
  workflowBags: "workflowBags",
  batches: "batches",
  smallBoxes: "smallBoxes",
  receives: "receives",
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: async (entry: unknown) => {
    auditWrites.push(entry);
  },
}));

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { editInventoryBag } from "./bag-edits";

// ─── Reset state before each test ────────────────────────────────────────────

beforeEach(() => {
  selectIdx = 0;
  selectResults.length = 0;
  txUpdates.length = 0;
  txInserts.length = 0;
  auditWrites.length = 0;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACTOR = { id: "user-001", role: "LEAD" as const, email: "lead@luma.local", employeeId: "emp-001" };
const BAG_ID = "bag-001";

function bagRow(
  overrides: Partial<{
    id: string;
    weightGrams: number | null;
    notes: string | null;
    internalReceiptNumber: string | null;
    bagQrCode: string | null;
    batchId: string | null;
    status: string;
    tabletTypeId: string;
    smallBoxId: string;
    bagNumber: number;
  }> = {},
) {
  return {
    id: BAG_ID,
    weightGrams: 1000,
    notes: null,
    internalReceiptNumber: "R-001",
    bagQrCode: "old-token",
    batchId: "batch-001",
    status: "AVAILABLE",
    tabletTypeId: "tt-001",
    smallBoxId: "sb-001",
    bagNumber: 1,
    ...overrides,
  };
}

/**
 * Seeds the first two selectResults slots that getBagForEdit consumes:
 *   slot 0 → bag row query (leftJoin batches, no limit)
 *   slot 1 → in-production check (workflowBags, with limit)
 */
function setupGetBagForEdit(
  bag: ReturnType<typeof bagRow>,
  batchNumber: string | null = "LOT-A",
  inProd = false,
) {
  selectResults.push([{ bag, batchNumber, tabletTypeId: bag.tabletTypeId }]);
  selectResults.push(inProd ? [{ id: "wfb-001" }] : []);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("editInventoryBag — no-op same QR assignment", () => {
  it("skips the QR swap block when new QR equals current QR", async () => {
    setupGetBagForEdit(bagRow({ bagQrCode: "same-token" }));
    // No extra selects needed — QR swap is skipped entirely.

    const result = await editInventoryBag(
      BAG_ID,
      { bagQrCode: "same-token", editReason: "no-op test" },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    expect(auditWrites).toHaveLength(1);
    expect(txUpdates).toHaveLength(1);
  });
});

describe("editInventoryBag — QR conflict message with receive context", () => {
  it("throws with receive name in message when QR is on another bag", async () => {
    setupGetBagForEdit(bagRow());
    // slot 2 → old card lookup (tx.select from qrCards where scanToken = old)
    //   bag.bagQrCode is "old-token" so the old-card branch runs
    selectResults.push([
      {
        id: "qr-old",
        cardType: "RAW_BAG",
        status: "IDLE",
        assignedWorkflowBagId: null,
        scanToken: "old-token",
      },
    ]);
    // slot 3 → new card lookup (tx.select from qrCards where scanToken = new)
    selectResults.push([
      {
        id: "qr-002",
        cardType: "RAW_BAG",
        status: "IDLE",
        assignedWorkflowBagId: null,
        scanToken: "new-token",
      },
    ]);
    // slot 4 → existing bag conflict check (leftJoin smallBoxes, leftJoin receives)
    selectResults.push([{ id: "bag-999", bagNumber: 3, receiveName: "PO-001-R2" }]);

    const result = await editInventoryBag(
      BAG_ID,
      { bagQrCode: "new-token", editReason: "test" },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/bag 3/);
      expect(result.error).toMatch(/PO-001-R2/);
      expect(result.error).toMatch(/Choose another QR/i);
    }
  });

  it("error message works when receive name is null (no PO linked)", async () => {
    setupGetBagForEdit(bagRow());
    selectResults.push([
      {
        id: "qr-old",
        cardType: "RAW_BAG",
        status: "IDLE",
        assignedWorkflowBagId: null,
        scanToken: "old-token",
      },
    ]);
    selectResults.push([
      {
        id: "qr-002",
        cardType: "RAW_BAG",
        status: "IDLE",
        assignedWorkflowBagId: null,
        scanToken: "new-token",
      },
    ]);
    selectResults.push([{ id: "bag-999", bagNumber: 5, receiveName: null }]);

    const result = await editInventoryBag(
      BAG_ID,
      { bagQrCode: "new-token", editReason: "test" },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/bag 5/);
      expect(result.error).not.toMatch(/undefined/);
      expect(result.error).not.toMatch(/null/);
    }
  });
});

describe("editInventoryBag — receipt# uniqueness pre-check", () => {
  it("throws friendly error when receipt# is used by another bag", async () => {
    setupGetBagForEdit(bagRow({ internalReceiptNumber: "R-OLD" }));
    // No QR change so no QR selects.
    // slot 2 → receipt# conflict check
    selectResults.push([{ id: "bag-999" }]);

    const result = await editInventoryBag(
      BAG_ID,
      { internalReceiptNumber: "R-TAKEN", editReason: "test" },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/R-TAKEN/);
      expect(result.error).toMatch(/already used/i);
    }
  });

  it("allows changing to a receipt# not used by any other bag", async () => {
    setupGetBagForEdit(bagRow({ internalReceiptNumber: "R-OLD" }));
    // slot 2 → receipt# conflict check returns empty
    selectResults.push([]);

    const result = await editInventoryBag(
      BAG_ID,
      { internalReceiptNumber: "R-NEW", editReason: "correction" },
      ACTOR,
    );

    expect(result.ok).toBe(true);
  });
});

describe("editInventoryBag — old QR released only when intake-reserved", () => {
  it("releases old QR when it is intake-reserved (ASSIGNED + null workflowBagId)", async () => {
    // bag.status must be non-AVAILABLE for the release branch to fire —
    // shouldReleaseQrAtBagEdit guards against releasing the QR for bags
    // that are still AVAILABLE for floor-start (intake-reserved bags
    // about to be picked up). The release path is only taken once the
    // bag has been moved out of AVAILABLE (e.g. an admin correcting a
    // bag that's already in IN_USE).
    setupGetBagForEdit(bagRow({ bagQrCode: "old-token", status: "IN_USE" }));
    // slot 2 → old card: ASSIGNED, no workflowBagId → shouldRelease = true
    selectResults.push([
      {
        id: "qr-old",
        cardType: "RAW_BAG",
        status: "ASSIGNED",
        assignedWorkflowBagId: null,
        scanToken: "old-token",
      },
    ]);
    // slot 3 → new card: IDLE, valid for assignment
    selectResults.push([
      {
        id: "qr-new",
        cardType: "RAW_BAG",
        status: "IDLE",
        assignedWorkflowBagId: null,
        scanToken: "new-token",
      },
    ]);
    // slot 4 → existing bag conflict check: no conflict
    selectResults.push([]);

    await editInventoryBag(
      BAG_ID,
      { bagQrCode: "new-token", editReason: "replacement" },
      ACTOR,
    );

    expect(
      txUpdates.some(
        (u) => (u.set as Record<string, unknown>).status === "IDLE",
      ),
    ).toBe(true);
    expect(
      txUpdates.some(
        (u) => (u.set as Record<string, unknown>).status === "ASSIGNED",
      ),
    ).toBe(true);
    expect(
      auditWrites.some(
        (a) =>
          (a as Record<string, unknown>).action === "qr_card.released_at_bag_edit",
      ),
    ).toBe(true);
  });

  it("does NOT release old QR when it is mid-production (ASSIGNED + workflowBagId)", async () => {
    setupGetBagForEdit(bagRow({ bagQrCode: "old-token" }));
    // slot 2 → old card: ASSIGNED with a live workflowBagId → shouldRelease = false
    selectResults.push([
      {
        id: "qr-old",
        cardType: "RAW_BAG",
        status: "ASSIGNED",
        assignedWorkflowBagId: "wfb-123",
        scanToken: "old-token",
      },
    ]);
    // slot 3 → new card: IDLE
    selectResults.push([
      {
        id: "qr-new",
        cardType: "RAW_BAG",
        status: "IDLE",
        assignedWorkflowBagId: null,
        scanToken: "new-token",
      },
    ]);
    // slot 4 → existing bag conflict check: no conflict
    selectResults.push([]);

    await editInventoryBag(
      BAG_ID,
      { bagQrCode: "new-token", editReason: "replacement" },
      ACTOR,
    );

    expect(
      txUpdates.filter(
        (u) => (u.set as Record<string, unknown>).status === "IDLE",
      ),
    ).toHaveLength(0);
    expect(
      auditWrites.some(
        (a) =>
          (a as Record<string, unknown>).action === "qr_card.released_at_bag_edit",
      ),
    ).toBe(false);
  });
});

describe("editInventoryBag — audit log always written", () => {
  it("writes inventory_bag.edit audit entry on any successful edit", async () => {
    setupGetBagForEdit(bagRow());
    // slot 2 → receipt# conflict check: no conflict
    selectResults.push([]);

    await editInventoryBag(
      BAG_ID,
      { internalReceiptNumber: "R-NEW", editReason: "correction" },
      ACTOR,
    );

    const auditEntry = auditWrites.find(
      (a) => (a as Record<string, unknown>).action === "inventory_bag.edit",
    );
    expect(auditEntry).toBeDefined();
    const entry = auditEntry as Record<string, unknown>;
    expect(entry.targetId).toBe(BAG_ID);
    expect(entry.actorId).toBe("user-001");
  });
});
