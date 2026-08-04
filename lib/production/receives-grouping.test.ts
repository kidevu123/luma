import { describe, it, expect } from "vitest";
import {
  groupReceivesByPo,
  formatReceiveGroupSummary,
  groupPoReceivesByShipment,
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

// ---------------------------------------------------------------------------
// SHIPMENT-INTAKE-1 — second grouping tier
// ---------------------------------------------------------------------------

type ShipmentableReceive = GroupableReceive & {
  shipmentId: string | null;
  shipmentCarrier: string | null;
  shipmentTracking: string | null;
};

function rs(
  id: string,
  opts: {
    poId?: string | null;
    poNumber?: string | null;
    vendor?: string | null;
    bagCount?: number | null;
    receivedAt?: Date | string | null;
    closedAt?: Date | string | null;
    shipmentId?: string | null;
    shipmentCarrier?: string | null;
    shipmentTracking?: string | null;
  } = {},
): ShipmentableReceive {
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
    shipmentId: opts.shipmentId ?? null,
    shipmentCarrier: opts.shipmentCarrier ?? null,
    shipmentTracking: opts.shipmentTracking ?? null,
  };
}

describe("groupPoReceivesByShipment", () => {
  it("groups receives under their shipment, newest shipment first", () => {
    // S1: older shipment, 2 receives with bags 2+3=5
    // S2: newer shipment, 1 receive with 4 bags
    const rows = [
      rs("r1", { shipmentId: "S1", shipmentCarrier: "FedEx", shipmentTracking: "123", bagCount: 2, receivedAt: "2026-06-10T10:00:00Z" }),
      rs("r2", { shipmentId: "S1", shipmentCarrier: "FedEx", shipmentTracking: "123", bagCount: 3, receivedAt: "2026-06-11T10:00:00Z" }),
      rs("r3", { shipmentId: "S2", shipmentCarrier: "UPS",   shipmentTracking: "456", bagCount: 4, receivedAt: "2026-06-20T10:00:00Z" }),
    ];
    const groups = groupPoReceivesByShipment(rows);
    expect(groups).toHaveLength(2);
    // Newest shipment (S2, Jun 20) is first
    expect(groups[0]!.key).toBe("S2");
    expect(groups[0]!.totalBags).toBe(4);
    expect(groups[0]!.receives).toHaveLength(1);
    expect(groups[0]!.isLegacy).toBe(false);
    // S1 is second with 2 receives and 5 bags
    expect(groups[1]!.key).toBe("S1");
    expect(groups[1]!.totalBags).toBe(5);
    expect(groups[1]!.receives).toHaveLength(2);
    expect(groups[1]!.carrier).toBe("FedEx");
    expect(groups[1]!.trackingNumber).toBe("123");
    expect(groups[1]!.latestReceivedAt?.toISOString()).toBe("2026-06-11T10:00:00.000Z");
  });

  it("null-shipment receives collapse into one legacy group, sorted last", () => {
    const rows = [
      rs("r1", { shipmentId: "S1", bagCount: 2, receivedAt: "2026-06-10T10:00:00Z" }),
      rs("r2", { shipmentId: null,  bagCount: 3, receivedAt: "2026-06-08T10:00:00Z" }),
      rs("r3", { shipmentId: null,  bagCount: 4, receivedAt: "2026-06-09T10:00:00Z" }),
    ];
    const groups = groupPoReceivesByShipment(rows);
    expect(groups).toHaveLength(2);
    // Real shipment first
    expect(groups[0]!.key).toBe("S1");
    expect(groups[0]!.isLegacy).toBe(false);
    // Legacy group last
    const legacy = groups[1]!;
    expect(legacy.key).toBe("__no_shipment__");
    expect(legacy.isLegacy).toBe(true);
    expect(legacy.totalBags).toBe(7); // 3 + 4
    expect(legacy.receives).toHaveLength(2);
    expect(legacy.carrier).toBeNull();
    expect(legacy.trackingNumber).toBeNull();
  });

  it("preserves the generic row type (receiveName still accessible)", () => {
    type ExtendedReceive = ShipmentableReceive & { receiveName: string };
    const rows: ExtendedReceive[] = [
      { ...rs("r1", { shipmentId: "S1", bagCount: 5 }), receiveName: "PO123-R1" },
      { ...rs("r2", { shipmentId: "S1", bagCount: 2 }), receiveName: "PO123-R2" },
    ];
    const groups = groupPoReceivesByShipment(rows);
    expect(groups).toHaveLength(1);
    // TypeScript: receiveName is accessible on the generic row
    const firstName = groups[0]!.receives[0]!.receiveName;
    expect(typeof firstName).toBe("string");
    expect(groups[0]!.totalBags).toBe(7); // 5 + 2
  });
});
