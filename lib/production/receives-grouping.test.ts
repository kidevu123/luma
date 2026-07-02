import { describe, it, expect } from "vitest";
import {
  groupReceivesByPo,
  formatReceiveGroupSummary,
  type GroupableReceive,
} from "./receives-grouping";

function r(
  id: string,
  opts: {
    poId?: string | null;
    poNumber?: string | null;
    vendor?: string | null;
    bagCount?: number | null;
    receivedAt?: Date | string | null;
    closedAt?: Date | string | null;
  } = {},
): GroupableReceive {
  return {
    receive: {
      id,
      poId: opts.poId ?? null,
      receivedAt: opts.receivedAt ?? null,
      closedAt: opts.closedAt ?? null,
    },
    poNumber: opts.poNumber ?? null,
    vendor: opts.vendor ?? null,
    bagCount: opts.bagCount ?? null,
  };
}

describe("groupReceivesByPo — grouping + totals", () => {
  const rows = [
    r("a1", { poId: "po-206", poNumber: "PO-00206", vendor: "Haute", bagCount: 10, receivedAt: "2026-06-12T10:00:00Z" }),
    r("a2", { poId: "po-206", poNumber: "PO-00206", vendor: "Haute", bagCount: 12, receivedAt: "2026-06-14T10:00:00Z" }),
    r("b1", { poId: "po-258", poNumber: "PO-00258", vendor: "Haute", bagCount: 8, receivedAt: "2026-06-20T10:00:00Z" }),
  ];

  it("groups receives by PO id/number", () => {
    const groups = groupReceivesByPo(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.poNumber).sort()).toEqual(["PO-00206", "PO-00258"]);
  });

  it("computes per-group totals (receives + bags)", () => {
    const groups = groupReceivesByPo(rows);
    const po206 = groups.find((g) => g.poNumber === "PO-00206")!;
    expect(po206.totalReceives).toBe(2);
    expect(po206.totalBags).toBe(22); // 10 + 12
    const po258 = groups.find((g) => g.poNumber === "PO-00258")!;
    expect(po258.totalReceives).toBe(1);
    expect(po258.totalBags).toBe(8);
  });

  it("keeps every individual receive visible under its group", () => {
    const po206 = groupReceivesByPo(rows).find((g) => g.poNumber === "PO-00206")!;
    expect(po206.receives.map((x) => x.receive.id).sort()).toEqual(["a1", "a2"]);
  });

  it("orders groups by latest received desc, receives within a group newest-first", () => {
    const groups = groupReceivesByPo(rows);
    // PO-00258 (Jun 20) is newer than PO-00206 (latest Jun 14) → first.
    expect(groups[0]!.poNumber).toBe("PO-00258");
    const po206 = groups.find((g) => g.poNumber === "PO-00206")!;
    expect(po206.receives.map((x) => x.receive.id)).toEqual(["a2", "a1"]); // Jun 14 before Jun 12
    expect(po206.latestReceivedAt?.toISOString()).toBe("2026-06-14T10:00:00.000Z");
  });
});

describe("groupReceivesByPo — status summary", () => {
  it("all-open → Open", () => {
    const g = groupReceivesByPo([r("x", { poId: "p", closedAt: null }), r("y", { poId: "p", closedAt: null })])[0]!;
    expect(g.status.label).toBe("Open");
    expect(g.status.openCount).toBe(2);
    expect(g.status.closedCount).toBe(0);
  });
  it("all-closed → Closed", () => {
    const g = groupReceivesByPo([r("x", { poId: "p", closedAt: "2026-06-12T10:00:00Z" })])[0]!;
    expect(g.status.label).toBe("Closed");
  });
  it("differing statuses → Mixed with counts", () => {
    const g = groupReceivesByPo([
      r("x", { poId: "p", closedAt: "2026-06-12T10:00:00Z" }),
      r("y", { poId: "p", closedAt: null }),
    ])[0]!;
    expect(g.status.label).toBe("Mixed");
    expect(g.status.openCount).toBe(1);
    expect(g.status.closedCount).toBe(1);
  });
});

describe("groupReceivesByPo — null / edge cases don't crash", () => {
  it("PO-less receives collapse into one group with null poNumber", () => {
    const groups = groupReceivesByPo([
      r("n1", { poId: null, poNumber: null, bagCount: null }),
      r("n2", { poId: null, poNumber: null, bagCount: 3 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.poNumber).toBeNull(); // page renders "Unknown PO"
    expect(groups[0]!.totalBags).toBe(3); // null bagCount treated as 0
    expect(groups[0]!.totalReceives).toBe(2);
  });

  it("null vendor / receivedAt / bagCount are tolerated", () => {
    const g = groupReceivesByPo([
      r("m", { poId: "p", vendor: null, receivedAt: null, bagCount: null }),
    ])[0]!;
    expect(g.vendor).toBeNull();
    expect(g.latestReceivedAt).toBeNull();
    expect(g.totalBags).toBe(0);
    expect(g.status.label).toBe("Open");
  });

  it("unparseable received timestamp does not throw and sorts last", () => {
    const groups = groupReceivesByPo([
      r("bad", { poId: "p1", poNumber: "PO-1", receivedAt: "not-a-date" }),
      r("good", { poId: "p2", poNumber: "PO-2", receivedAt: "2026-06-20T10:00:00Z" }),
    ]);
    expect(groups[0]!.poNumber).toBe("PO-2"); // valid date first
    expect(groups[1]!.latestReceivedAt).toBeNull(); // bad date → null
  });

  it("a single-receive PO still forms a valid group", () => {
    const g = groupReceivesByPo([r("only", { poId: "p", poNumber: "PO-9", bagCount: 5 })]);
    expect(g).toHaveLength(1);
    expect(g[0]!.totalReceives).toBe(1);
  });

  it("empty input → empty groups", () => {
    expect(groupReceivesByPo([])).toEqual([]);
  });
});

describe("formatReceiveGroupSummary", () => {
  it("pluralizes and joins the rollup", () => {
    expect(
      formatReceiveGroupSummary({ totalReceives: 5, totalBags: 46, status: { label: "Open", openCount: 5, closedCount: 0 } }),
    ).toBe("5 receives · 46 bags · Open");
  });
  it("singular receive / bag", () => {
    expect(
      formatReceiveGroupSummary({ totalReceives: 1, totalBags: 1, status: { label: "Closed", openCount: 0, closedCount: 1 } }),
    ).toBe("1 receive · 1 bag · Closed");
  });
});
