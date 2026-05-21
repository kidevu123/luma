// PO-SYNC-TESTS — Unit tests for lib/zoho/po-sync.ts
//
// All tests are pure-unit: no real DB, no real HTTP.
// The db is injected via dbOverride; listInventoryPurchaseOrders and
// getInventoryPurchaseOrder are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mock must appear before the module-under-test is imported ──────────
vi.mock("./inventory-service-client", () => ({
  listInventoryPurchaseOrders: vi.fn(),
  getInventoryPurchaseOrder: vi.fn(),
}));

import { syncPurchaseOrdersFromZoho } from "./po-sync";
import {
  listInventoryPurchaseOrders,
  getInventoryPurchaseOrder,
} from "./inventory-service-client";
import type { db } from "@/lib/db";

// ─── Typed mock refs ──────────────────────────────────────────────────────────
const mockList = vi.mocked(listInventoryPurchaseOrders);
const mockGetDetail = vi.mocked(getInventoryPurchaseOrder);

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

function makeZohoLine(overrides: Partial<{
  line_item_id: string;
  item_id: string;
  name: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_remaining: number;
  unit: string;
  status: string;
}> = {}) {
  return {
    line_item_id: "ZLINE-001",
    item_id: "ZITEM-001",
    name: "Vitamin C 500mg",
    quantity_ordered: 10000,
    quantity_received: 0,
    quantity_remaining: 10000,
    unit: "tabs",
    status: "to_be_received",
    ...overrides,
  };
}

function makePoDetail(
  purchaseorder_id: string,
  line_items: ReturnType<typeof makeZohoLine>[],
) {
  return {
    ok: true as const,
    data: {
      purchaseorder_id,
      purchaseorder_number: "PO-2026-001",
      vendor_name: "ACME Pharma",
      status: "issued",
      date: "2026-05-20",
      received_status: "to_be_received",
      line_items,
    },
    meta: META,
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
 *   - select → resolves given rows for ALL queries
 *   - insert → resolves with [{ id: "new-uuid" }] (for .returning() support)
 *   - update → resolves (captures calls via spy)
 */
function mockDbFull(rows: AnyRow[]) {
  const insertSpy = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
    }),
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
  // resetAllMocks clears call history AND the mockResolvedValueOnce queue, preventing
  // unconsumed Once values (e.g., from non-receivable status-mapping cases) from
  // polluting later tests.
  vi.resetAllMocks();
  // Default: getInventoryPurchaseOrder not called — suppress unhandled mock warnings
  mockGetDetail.mockResolvedValue({
    ok: false,
    httpStatus: null,
    body: null,
    message: "not configured",
  });
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
      dbOverride: mockDbSelect([]) as unknown as typeof db,
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
      dbOverride: mockDbSelect([]) as unknown as typeof db,
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

    // For an OPEN PO a detail fetch will also happen — mock it to return no lines
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", []));

    const mockDb = mockDbFull([]);

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as unknown as typeof db,
    });

    expect(result.fetched).toBe(1);
    expect(result.poUpserted).toBe(1);
    expect(result.errors).toHaveLength(0);
    // INSERT was called (at least for the PO)
    expect(mockDb._insertSpy).toHaveBeenCalled();
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

    // OPEN PO → detail fetch will happen; mock it with no lines
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", []));

    const mockDb = mockDbFull([existingPo]);

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as unknown as typeof db,
    });

    expect(result.fetched).toBe(1);
    expect(result.poUpserted).toBe(1);
    expect(result.errors).toHaveLength(0);
    // UPDATE was called (for the PO)
    expect(mockDb._updateSpy).toHaveBeenCalled();
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
    // Both runs: OPEN PO → detail fetch, no lines
    mockGetDetail.mockResolvedValue(makePoDetail("ZPOID-001", []));

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
    expect(mockDb1._insertSpy).toHaveBeenCalled();
    expect(mockDb1._updateSpy).not.toHaveBeenCalled();

    // Second call: row now exists → UPDATE
    const mockDb2 = mockDbFull([existingPo]);
    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb2 as never });
    expect(mockDb2._updateSpy).toHaveBeenCalled();
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

      // For non-terminal statuses OPEN/RECEIVING the detail endpoint will be called
      // For DRAFT/RECEIVED/CANCELLED it won't — mock it anyway to be safe
      mockGetDetail.mockResolvedValueOnce(
        makePoDetail("ZPOID-001", []),
      );

      // Capture values passed to insert
      let capturedValues: AnyRow | null = null;
      const insertSpy = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: AnyRow) => {
          capturedValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
          };
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

    // update MUST be called (to refresh vendorName/openedAt), and status MUST NOT be in the payload
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(capturedSet).not.toHaveProperty("status");
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

    // update MUST be called (to refresh vendorName/openedAt), and status MUST NOT be in the payload
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(capturedSet).not.toHaveProperty("status");
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

    // update MUST be called (to refresh vendorName/openedAt), and status MUST NOT be in the payload
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(capturedSet).not.toHaveProperty("status");
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

    // goodPo is OPEN → detail fetch; return no lines
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-GOOD", []));

    let callCount = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) {
              // First call: tabletTypes lookup (empty)
              return Promise.resolve([]);
            }
            if (callCount === 2) {
              // Second call: purchaseOrders lookup for badPo — throw
              return Promise.reject(new Error("DB connection reset"));
            }
            // Remaining calls: purchaseOrders lookup for goodPo → no row → INSERT
            return Promise.resolve([]);
          },
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
        }),
      }),
      update: vi.fn(),
    };

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(result.fetched).toBe(2);
    expect(result.poUpserted).toBe(1);   // goodPo succeeded
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ZPOID-BAD");
  });
});

// 9. Line counts — now non-zero for OPEN/RECEIVING POs
describe("line counts", () => {
  it("lineUpserted reflects upserted lines from receivable POs", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [
        makeZohoPo({ purchaseorder_id: "ZPOID-001", purchaseorder_number: "PO-001" }),
        makeZohoPo({ purchaseorder_id: "ZPOID-002", purchaseorder_number: "PO-002" }),
      ],
      meta: META,
    });

    // Both POs are OPEN and return 1 line each
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", [makeZohoLine()]));
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-002", [
        makeZohoLine({ line_item_id: "ZLINE-002", item_id: "ZITEM-002" }),
      ]),
    );

    // Selector order per call:
    // 1. tabletTypes → []
    // 2. purchaseOrders for ZPOID-001 → [] (insert → id "uuid-1")
    // 3. purchaseOrders for ZPOID-002 → [] (insert → id "uuid-2")
    // 4. poLines for ZLINE-001 → []
    // 5. poLines for ZLINE-002 → []
    let selectCall = 0;
    const insertSpy = vi.fn()
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "uuid-1" }]),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "uuid-2" }]),
        }),
      })
      .mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCall++;
            return Promise.resolve([]);
          },
        }),
      }),
      insert: insertSpy,
      update: vi.fn(),
    };

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(result.lineUpserted).toBe(2);
    expect(result.lineSkipped).toBe(0);
  });
});

// 10. Duplicate zohoPoId guard
describe("duplicate zohoPoId guard", () => {
  it("records an error when SELECT returns more than one row for the same zohoPoId", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo()],
      meta: META,
    });

    const row = {
      id: "uuid-1",
      poNumber: "PO-2026-001",
      parentPoNumber: null,
      vendorName: "ACME Pharma",
      status: "OPEN",
      zohoPoId: "ZPOID-001",
      openedAt: new Date("2026-05-20"),
      closedAt: null,
      notes: null,
    };

    let selectCall = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCall++;
            if (selectCall === 1) {
              // tabletTypes lookup
              return Promise.resolve([]);
            }
            // purchaseOrders lookup — return duplicate rows
            return Promise.resolve([row, { ...row, id: "uuid-2" }]);
          },
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(result.poUpserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Duplicate zohoPoId");
    expect(result.errors[0]).toContain("ZPOID-001");
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ─── New: line sync tests ─────────────────────────────────────────────────────

/**
 * Build a DB mock with explicit per-call control for line sync tests.
 *
 * selectSequence: array of rows to return in order for each .select()...where() call
 * insertReturns:  array of values to return from .returning() for each insert, in order
 */
function makeLineSyncDb(opts: {
  selectSequence: AnyRow[][];
  insertReturns?: Array<{ id: string } | undefined>;
  insertSpy?: ReturnType<typeof vi.fn>;
  updateSpy?: ReturnType<typeof vi.fn>;
}) {
  let selectIdx = 0;
  let insertIdx = 0;

  const insertSpy =
    opts.insertSpy ??
    vi.fn().mockImplementation(() => {
      const idx = insertIdx++;
      const ret = opts.insertReturns?.[idx];
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(ret ? [ret] : [{ id: "fallback-id" }]),
        }),
      };
    });

  // Wrap insertSpy in a version that also handles plain .values() without .returning()
  const wrappedInsert = vi.fn().mockImplementation((table: unknown) => {
    const idx = insertIdx++;
    const ret = opts.insertReturns?.[idx];
    const valuesResult = {
      returning: vi.fn().mockResolvedValue(ret ? [ret] : [{ id: "fallback-id" }]),
    };
    return {
      values: vi.fn().mockReturnValue(valuesResult),
      _table: table,
    };
  });

  const updateSpy =
    opts.updateSpy ??
    vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = opts.selectSequence[selectIdx] ?? [];
          selectIdx++;
          return Promise.resolve(rows);
        },
      }),
    }),
    insert: wrappedInsert,
    update: updateSpy,
    _insertSpy: wrappedInsert,
    _updateSpy: updateSpy,
  };
}

describe("line sync", () => {
  it("fetches detail for OPEN POs and upserts lines", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-001", status: "issued" })],
      meta: META,
    });
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-001", [
        makeZohoLine({ line_item_id: "ZLINE-001", item_id: "z-item-1" }),
        makeZohoLine({ line_item_id: "ZLINE-002", item_id: "z-item-2" }),
      ]),
    );

    // selectSequence:
    // [0] tabletTypes → [{ id: "tt-1", zohoItemId: "z-item-1" }]
    // [1] purchaseOrders for ZPOID-001 → [] (new PO)
    // [2] poLines for ZLINE-001 → []
    // [3] poLines for ZLINE-002 → []
    const mockDb = makeLineSyncDb({
      selectSequence: [
        [{ id: "tt-1", zohoItemId: "z-item-1" }],
        [],
        [],
        [],
      ],
      insertReturns: [{ id: "local-po-1" }, undefined, undefined],
    });

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as unknown as typeof db,
    });

    expect(result.lineUpserted).toBe(2);
    expect(result.detailsFetched).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("does not fetch detail for RECEIVED POs", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-001", status: "received" })],
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

    // selectSequence:
    // [0] tabletTypes → []
    // [1] purchaseOrders → [existingPo] (RECEIVED, terminal)
    const mockDb = makeLineSyncDb({
      selectSequence: [[], [existingPo]],
    });

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as unknown as typeof db,
    });

    expect(mockGetDetail).not.toHaveBeenCalled();
    expect(result.detailsFetched).toBe(0);
    expect(result.lineUpserted).toBe(0);
  });

  it("line sync is idempotent — re-run updates, not inserts", async () => {
    const line = makeZohoLine();
    const existingLine = {
      id: "line-uuid",
      poId: "local-po-1",
      zohoLineItemId: line.line_item_id,
      tabletTypeId: null,
      packagingMaterialId: null,
      qtyOrdered: line.quantity_ordered,
      notes: null,
    };

    // ── First run: INSERT ──
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-001", status: "issued" })],
      meta: META,
    });
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", [line]));

    const mockDb1 = makeLineSyncDb({
      selectSequence: [[], [], []],  // tabletTypes→[], poOrders→[], poLines→[]
      insertReturns: [{ id: "local-po-1" }, undefined],
    });

    const result1 = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb1 as unknown as typeof db,
    });
    expect(result1.lineUpserted).toBe(1);

    // ── Second run: UPDATE ──
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-001", status: "issued" })],
      meta: META,
    });
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", [line]));

    const existingPo = {
      id: "local-po-1",
      poNumber: "PO-2026-001",
      parentPoNumber: null,
      vendorName: "ACME Pharma",
      status: "OPEN",
      zohoPoId: "ZPOID-001",
      openedAt: new Date("2026-05-20"),
      closedAt: null,
      notes: null,
    };

    const updateSpy2 = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const mockDb2 = makeLineSyncDb({
      selectSequence: [[], [existingPo], [existingLine]],  // tabletTypes→[], poOrders→[existing], poLines→[existingLine]
      updateSpy: updateSpy2,
    });

    const result2 = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb2 as unknown as typeof db,
    });
    expect(result2.lineUpserted).toBe(1);
    // UPDATE was called (for the po_line)
    expect(updateSpy2).toHaveBeenCalled();
    // INSERT was NOT called (no returning() needed for updates)
    expect(mockDb2._insertSpy).not.toHaveBeenCalled();
  });

  it("links lines to the correct local purchase_order id", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-LINK", status: "issued" })],
      meta: META,
    });
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-LINK", [makeZohoLine()]),
    );

    // Capture INSERT values for po_lines
    let capturedLineInsertValues: AnyRow | null = null;
    let insertCallCount = 0;

    const insertSpy = vi.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        // First call: INSERT purchaseOrders
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "correct-local-id" }]),
          }),
        };
      }
      // Second call: INSERT poLines — capture the values
      return {
        values: vi.fn().mockImplementation((vals: AnyRow) => {
          capturedLineInsertValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([]),
          };
        }),
      };
    });

    let selectIdx = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            // [0] tabletTypes, [1] purchaseOrders→[], [2] poLines→[]
            selectIdx++;
            return Promise.resolve([]);
          },
        }),
      }),
      insert: insertSpy,
      update: vi.fn(),
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(capturedLineInsertValues).not.toBeNull();
    expect((capturedLineInsertValues as unknown as AnyRow)["poId"]).toBe("correct-local-id");
  });

  it("sets tabletTypeId when item_id matches a local tablet type", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-TT", status: "issued" })],
      meta: META,
    });
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-TT", [
        makeZohoLine({ item_id: "zoho-item-123" }),
      ]),
    );

    let capturedLineInsertValues: AnyRow | null = null;
    let insertCallCount = 0;

    const insertSpy = vi.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "local-po-tt" }]),
          }),
        };
      }
      return {
        values: vi.fn().mockImplementation((vals: AnyRow) => {
          capturedLineInsertValues = vals;
          return { returning: vi.fn().mockResolvedValue([]) };
        }),
      };
    });

    // selectSequence: tabletTypes → match, purchaseOrders → [], poLines → []
    let selectIdx = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectIdx++;
            if (selectIdx === 1) {
              // tabletTypes — return a match for zoho-item-123
              return Promise.resolve([{ id: "local-tt-uuid", zohoItemId: "zoho-item-123" }]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
      insert: insertSpy,
      update: vi.fn(),
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(capturedLineInsertValues).not.toBeNull();
    expect((capturedLineInsertValues as unknown as AnyRow)["tabletTypeId"]).toBe("local-tt-uuid");
  });

  it("sets tabletTypeId to null and notes to item name when no match", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-NOMATCH", status: "issued" })],
      meta: META,
    });
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-NOMATCH", [
        makeZohoLine({ item_id: "zoho-item-999", name: "Mystery Ingredient" }),
      ]),
    );

    let capturedLineInsertValues: AnyRow | null = null;
    let insertCallCount = 0;

    const insertSpy = vi.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "local-po-nm" }]),
          }),
        };
      }
      return {
        values: vi.fn().mockImplementation((vals: AnyRow) => {
          capturedLineInsertValues = vals;
          return { returning: vi.fn().mockResolvedValue([]) };
        }),
      };
    });

    // selectSequence: tabletTypes → empty (no match), purchaseOrders → [], poLines → []
    let selectIdx = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectIdx++;
            return Promise.resolve([]); // tabletTypes empty → no match
          },
        }),
      }),
      insert: insertSpy,
      update: vi.fn(),
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(capturedLineInsertValues).not.toBeNull();
    expect((capturedLineInsertValues as unknown as AnyRow)["tabletTypeId"]).toBeNull();
    expect((capturedLineInsertValues as unknown as AnyRow)["notes"]).toContain("Mystery Ingredient");
  });

  it("counts lineSkipped for lines with no line_item_id", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      data: [makeZohoPo({ purchaseorder_id: "ZPOID-SKIP", status: "issued" })],
      meta: META,
    });
    // One line with no line_item_id, one valid line
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-SKIP", [
        { ...makeZohoLine(), line_item_id: "" },  // empty → skipped
        makeZohoLine({ line_item_id: "ZLINE-VALID" }),
      ]),
    );

    const mockDb = makeLineSyncDb({
      selectSequence: [[], [], []],  // tabletTypes→[], poOrders→[], poLines for valid→[]
      insertReturns: [{ id: "local-po-skip" }, undefined],
    });

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as unknown as typeof db,
    });

    expect(result.lineSkipped).toBe(1);
    expect(result.lineUpserted).toBe(1);
  });

  it("detailsFetched matches number of receivable POs", async () => {
    const openPo1 = makeZohoPo({ purchaseorder_id: "ZPOID-A", purchaseorder_number: "PO-A", status: "issued" });
    const openPo2 = makeZohoPo({ purchaseorder_id: "ZPOID-B", purchaseorder_number: "PO-B", status: "partially_received" });
    const receivedPo = makeZohoPo({ purchaseorder_id: "ZPOID-C", purchaseorder_number: "PO-C", status: "received" });

    mockList.mockResolvedValueOnce({
      ok: true,
      data: [openPo1, openPo2, receivedPo],
      meta: META,
    });
    // Detail is fetched for ZPOID-A and ZPOID-B only
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-A", []));
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-B", []));

    // Existing RECEIVED PO for ZPOID-C (terminal)
    const existingReceivedPo = {
      id: "uuid-c",
      poNumber: "PO-C",
      parentPoNumber: null,
      vendorName: "ACME Pharma",
      status: "RECEIVED",
      zohoPoId: "ZPOID-C",
      openedAt: new Date("2026-05-20"),
      closedAt: null,
      notes: null,
    };

    let selectIdx = 0;
    const insertSpy = vi.fn()
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "uuid-a" }]),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "uuid-b" }]),
        }),
      });

    const updateSpy = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectIdx++;
            if (selectIdx === 1) return Promise.resolve([]); // tabletTypes
            if (selectIdx === 2) return Promise.resolve([]);  // poOrders for A → new
            if (selectIdx === 3) return Promise.resolve([]);  // poOrders for B → new
            if (selectIdx === 4) return Promise.resolve([existingReceivedPo]); // poOrders for C → terminal
            return Promise.resolve([]);
          },
        }),
      }),
      insert: insertSpy,
      update: updateSpy,
    };

    const result = await syncPurchaseOrdersFromZoho({
      dbOverride: mockDb as unknown as typeof db,
    });

    expect(result.detailsFetched).toBe(2);
    expect(result.poUpserted).toBe(3);
  });
});
