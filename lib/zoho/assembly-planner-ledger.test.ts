// ZOHO-FINISHED-GOODS-OUTBOX-1 — ledger lookup fallback via workflow_bag_id.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

import { fetchAllocationLedgerRows } from "./assembly-planner";

const LOT_ID = "11111111-0000-0000-0000-000000000001";
const BAG_ID = "22222222-0000-0000-0000-000000000002";

type QueryChain = {
  from: ReturnType<typeof vi.fn>;
};

function makeChain(rows: unknown[]): QueryChain {
  const chain: QueryChain = {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
  return chain;
}

describe("fetchAllocationLedgerRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rows linked by finished_lot_id without querying workflow_bag_id", async () => {
    const row = {
      inventoryBagId: BAG_ID,
      consumedQty: 1000,
      tabletTypeId: "tt-1",
      tabletZohoItemId: "ZTAB",
      tabletName: "DHA",
      receivePoLineId: "pl-1",
      zohoLineItemId: "ZLINE",
      zohoPoId: "ZPO",
      componentRole: null,
    };
    mockSelect.mockReturnValueOnce(makeChain([row]));

    const rows = await fetchAllocationLedgerRows(LOT_ID, BAG_ID);

    expect(rows).toEqual([row]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("falls back to workflow_bag_id when no finished_lot_id sessions exist", async () => {
    const row = {
      inventoryBagId: BAG_ID,
      consumedQty: 500,
      tabletTypeId: "tt-1",
      tabletZohoItemId: null,
      tabletName: "DHA",
      receivePoLineId: "pl-1",
      zohoLineItemId: null,
      zohoPoId: null,
      componentRole: null,
    };
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([row]));

    const rows = await fetchAllocationLedgerRows(LOT_ID, BAG_ID);

    expect(rows).toEqual([row]);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("returns empty when workflow_bag_id is null and lot-scoped query is empty", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));

    const rows = await fetchAllocationLedgerRows(LOT_ID, null);

    expect(rows).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("joins purchase_orders through receives.po_id (not session.po_id)", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/zoho/assembly-planner.ts"),
      "utf8",
    );
    expect(src).toMatch(/leftJoin\(purchaseOrders,\s*eq\(receives\.poId,\s*purchaseOrders\.id\)\)/);
    expect(src).not.toMatch(/eq\(rawBagAllocationSessions\.poId,\s*purchaseOrders\.id\)/);
  });

  it("returns zohoPoId from receive PO mapping when session po_id would be null", async () => {
    const row = {
      inventoryBagId: BAG_ID,
      consumedQty: 40,
      tabletTypeId: "tt-choco",
      tabletZohoItemId: "ZTAB-CHOCO",
      tabletName: "MIT B Chocolate Brown",
      receivePoLineId: "pl-receive",
      zohoLineItemId: "ZLINE-453535",
      zohoPoId: "ZPO-FROM-RECEIVE",
      componentRole: null,
    };
    mockSelect.mockReturnValueOnce(makeChain([row]));

    const rows = await fetchAllocationLedgerRows(LOT_ID, BAG_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.zohoPoId).toBe("ZPO-FROM-RECEIVE");
    expect(rows[0]?.zohoLineItemId).toBe("ZLINE-453535");
  });

  it("surfaces null zohoPoId when receive has no authoritative PO mapping", async () => {
    const row = {
      inventoryBagId: BAG_ID,
      consumedQty: 40,
      tabletTypeId: "tt-1",
      tabletZohoItemId: "ZTAB",
      tabletName: "DHA",
      receivePoLineId: null,
      zohoLineItemId: null,
      zohoPoId: null,
      componentRole: null,
    };
    mockSelect.mockReturnValueOnce(makeChain([row]));

    const rows = await fetchAllocationLedgerRows(LOT_ID, BAG_ID);

    expect(rows[0]?.zohoPoId).toBeNull();
    expect(rows[0]?.zohoLineItemId).toBeNull();
  });
});
