// PO-SYNC-TESTS — Unit tests for lib/zoho/po-sync.ts
//
// All tests are pure-unit: no real DB, no real HTTP.
// The db is injected via dbOverride; listInventoryPurchaseOrders is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mock must appear before the module-under-test is imported ──────────
vi.mock("./inventory-service-client", () => ({
  listInventoryPurchaseOrders: vi.fn(),
}));

import { syncPurchaseOrdersFromZoho } from "./po-sync";
import { listInventoryPurchaseOrders } from "./inventory-service-client";

// ─── Typed mock ref ───────────────────────────────────────────────────────────
const mockList = vi.mocked(listInventoryPurchaseOrders);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const META = {
  request_id: "req-1",
  brand: "haute_brands",
  service: "inventory",
  action: "list",
};

function makeZohoPo(overrides: Partial<{
  purchaseorder_id: string;
  purchaseorder_number: string;
  vendor_name: string;
  status: string;
  date: string;
  total: number;
  received_status: string;
  quantity_yet_to_receive: number;
}> = {}) {
  return {
    purchaseorder_id: "ZPOID-001",
    purchaseorder_number: "PO-2026-001",
    vendor_name: "ACME Pharma",
    status: "issued",
    date: "2026-05-20",
    total: 50000,
    received_status: "to_be_received",
    quantity_yet_to_receive: 1000,
    ...overrides,
  };
}

// ─── Minimal chainable DB mock helpers ───────────────────────────────────────

type AnyRow = Record<string, unknown>;

/**
 * Returns a mock db that resolves SELECT queries with the given rows.
 * Supports: db.select().from(table).where(cond) -> Promise<rows>
 */
function mockDbSelect(rows: AnyRow[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

/**
 * Returns a mock db with:
 *   - select → resolves given rows
 *   - insert → resolves (captures calls via spy)
 *   - update → resolves (captures calls via spy)
 */
function mockDbFull(rows: AnyRow[]) {
  const insertSpy = vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
  });
  const updateSpy = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    insert: insertSpy,
    update: updateSpy,
    _insertSpy: insertSpy,
    _updateSpy: updateSpy,
  };

  return db;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// 1. Fetch failure
describe("fetch failure", () => {
  it("returns 0 counts and one error containing 'Zoho fetch failed'", async () => {
    mockList.mockResolvedValueOnce({
      ok: false,
      httpStatus: 503,
      body: null,
      message: "Service unavailable",
    });

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDbSelect([]) as Parameters<typeof syncPurchaseOrdersFromZoho>[0] extends { dbOverride?: infer D } ? D : never,
    });

    expect(result.fetched).toBe(0);
    expect(result.poUpserted).toBe(0);
    expect(result.lineUpserted).toBe(0);
    expect(result.lineSkipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Zoho fetch failed");
  });
});

// 2. Empty list
describe("empty list", () => {
  it("returns all zeros when Zoho returns empty array", async () => {
    mockList.mockResolvedValueOnce({ ok: true, data: [], meta: META });

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDbSelect([]) as never,
    });

    expect(result.fetched).toBe(0);
    expect(result.poUpserted).toBe(0);
    expect(result.lineUpserted).toBe(0);
    expect(result.lineSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// 3. New PO insert
describe("new PO insert", () => {
  it("calls insert when SELECT returns no match, poUpserted = 1", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo()],
      meta: META,
    });

    const mockDb = mockDbFull([]);

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as never,
    });

    expect(result.fetched).toBe(1);
    expect(result.poUpserted).toBe(1);
    expect(result.errors).toHaveLength(0);
    // INSERT was called
    expect(mockDb._insertSpy).toHaveBeenCalledTimes(1);
    // UPDATE was NOT called
    expect(mockDb._updateSpy).not.toHaveBeenCalled();
  });
});

// 4. Existing PO update
describe("existing PO update", () => {
  it("calls update when SELECT returns a match, poUpserted = 1", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo()],
      meta: META,
    });

    const existingPo = {
      id: "existing-uuid",
      poNumber: "PO-2026-001",
      parentPoNumber: null,
      vendorName: "Old Vendor",
      status: "OPEN",
      zohoPoId: "ZPOID-001",
      openedAt: new Date("2026-01-01"),
      closedAt: null,
      notes: null,
    };

    const mockDb = mockDbFull([existingPo]);

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as never,
    });

    expect(result.fetched).toBe(1);
    expect(result.poUpserted).toBe(1);
    expect(result.errors).toHaveLength(0);
    // UPDATE was called
    expect(mockDb._updateSpy).toHaveBeenCalledTimes(1);
    // INSERT was NOT called
    expect(mockDb._insertSpy).not.toHaveBeenCalled();
  });
});

// 5. Idempotency — second call finds row and does UPDATE, not another INSERT
describe("idempotency", () => {
  it("second sync call updates not inserts when row already exists", async () => {
    const po = makeZohoPo();
    mockList.mockResolvedValue({
      ok: true,
      data: [po],
      meta: META,
    });

    const existingPo = {
      id: "existing-uuid",
      poNumber: po.purchaseorder_number,
      parentPoNumber: null,
      vendorName: po.vendor_name,
      status: "OPEN",
      zohoPoId: po.purchaseorder_id,
      openedAt: new Date(po.date),
      closedAt: null,
      notes: null,
    };

    // First call: no match → INSERT
    const mockDb1 = mockDbFull([]);
    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb1 as never });
    expect(mockDb1._insertSpy).toHaveBeenCalledTimes(1);
    expect(mockDb1._updateSpy).not.toHaveBeenCalled();

    // Second call: row now exists → UPDATE
    const mockDb2 = mockDbFull([existingPo]);
    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb2 as never });
    expect(mockDb2._updateSpy).toHaveBeenCalledTimes(1);
    expect(mockDb2._insertSpy).not.toHaveBeenCalled();
  });
});

// 6. Status mapping
describe("status mapping", () => {
  const cases: Array<[string, string]> = [
    ["issued", "OPEN"],
    ["partially_received", "RECEIVING"],
    ["received", "RECEIVED"],
    ["draft", "DRAFT"],
    ["cancelled", "CANCELLED"],
    ["unknown_future_status", "OPEN"], // safe default
  ];

  for (const [zohoStatus, expectedLocal] of cases) {
    it(`Zoho "${zohoStatus}" → local "${expectedLocal}"`, async () => {
      mockList.mockResolvedValueOnce({
        ok: true,
        data: [makeZohoPo({ status: zohoStatus })],
        meta: META,
      });

      // Capture values passed to insert
      let capturedValues: AnyRow | null = null;
      const insertSpy = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: AnyRow) => {
          capturedValues = vals;
          return Promise.resolve([{ id: "new-uuid" }]);
        }),
      });

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: insertSpy,
        update: vi.fn(),
      };

      await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as never });

      expect(capturedValues).not.toBeNull();
      expect((capturedValues as unknown as AnyRow)["status"]).toBe(expectedLocal);
    });
  }
});

// 7. Terminal status guard — locally RECEIVED PO does not get status downgraded
describe("terminal status guard", () => {
  it("does not update status of locally RECEIVED PO even when Zoho says 'issued'", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ status: "issued" })],
      meta: META,
    });

    const existingPo = {
      id: "existing-uuid",
      poNumber: "PO-2026-001",
      parentPoNumber: null,
      vendorName: "ACME Pharma",
      status: "RECEIVED", // terminal
      zohoPoId: "ZPOID-001",
      openedAt: new Date("2026-05-20"),
      closedAt: null,
      notes: null,
    };

    // Capture the set() call to inspect what fields were updated
    let capturedSet: AnyRow | null = null;
    const updateSpy = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((vals: AnyRow) => {
        capturedSet = vals;
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    });

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([existingPo]),
        }),
      }),
      insert: vi.fn(),
      update: updateSpy,
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as never });

    // Either update was not called at all, OR the status field was NOT changed to OPEN
    if (updateSpy.mock.calls.length > 0) {
      expect((capturedSet as AnyRow | null)?.["status"]).not.toBe("OPEN");
    }
    // INSERT was definitely not called
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("does not update status of locally CLOSED PO", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ status: "issued" })],
      meta: META,
    });

    const existingPo = {
      id: "existing-uuid",
      poNumber: "PO-2026-001",
      parentPoNumber: null,
      vendorName: "ACME Pharma",
      status: "CLOSED",
      zohoPoId: "ZPOID-001",
      openedAt: new Date("2026-05-20"),
      closedAt: new Date("2026-05-21"),
      notes: null,
    };

    let capturedSet: AnyRow | null = null;
    const updateSpy = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((vals: AnyRow) => {
        capturedSet = vals;
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    });

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([existingPo]),
        }),
      }),
      insert: vi.fn(),
      update: updateSpy,
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as never });

    if (updateSpy.mock.calls.length > 0) {
      expect((capturedSet as AnyRow | null)?.["status"]).not.toBe("OPEN");
    }
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("does not update status of locally CANCELLED PO", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ status: "issued" })],
      meta: META,
    });

    const existingPo = {
      id: "existing-uuid",
      poNumber: "PO-2026-001",
      parentPoNumber: null,
      vendorName: "ACME Pharma",
      status: "CANCELLED",
      zohoPoId: "ZPOID-001",
      openedAt: new Date("2026-05-20"),
      closedAt: null,
      notes: null,
    };

    let capturedSet: AnyRow | null = null;
    const updateSpy = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((vals: AnyRow) => {
        capturedSet = vals;
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    });

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([existingPo]),
        }),
      }),
      insert: vi.fn(),
      update: updateSpy,
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as never });

    if (updateSpy.mock.calls.length > 0) {
      expect((capturedSet as AnyRow | null)?.["status"]).not.toBe("OPEN");
    }
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

// 8. Error isolation — one bad PO doesn't abort others
describe("error isolation", () => {
  it("captures error for one PO and still processes the others", async () => {
    const goodPo = makeZohoPo({ purchaseorder_id: "ZPOID-GOOD", purchaseorder_number: "PO-GOOD" });
    const badPo = makeZohoPo({ purchaseorder_id: "ZPOID-BAD", purchaseorder_number: "PO-BAD" });

    mockList.mockResolvedValueOnce({
      ok: true,
      data: [badPo, goodPo],
      meta: META,
    });

    let callCount = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) {
              // First PO (badPo) — throw during select
              return Promise.reject(new Error("DB connection reset"));
            }
            // Second PO (goodPo) — no existing row → INSERT
            return Promise.resolve([]);
          },
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
      }),
      update: vi.fn(),
    };

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as never });

    expect(result.fetched).toBe(2);
    expect(result.poUpserted).toBe(1);   // goodPo succeeded
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ZPOID-BAD");
  });
});

// 9. Line counts are always zero
describe("line counts always zero", () => {
  it("lineUpserted and lineSkipped are always 0", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo(), makeZohoPo({ purchaseorder_id: "ZPOID-002", purchaseorder_number: "PO-002" })],
      meta: META,
    });

    const mockDb = mockDbFull([]);

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as never });

    expect(result.lineUpserted).toBe(0);
    expect(result.lineSkipped).toBe(0);
  });
});
