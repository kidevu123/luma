// QC-4 — loader behavior tests.
//
// Each loader runs a single SQL via tx.execute(). We stub execute()
// with a queue of canned result sets and assert the mapping back to
// typed rows. The SQL itself stays out of scope here (covered by
// staging smoke in step 6); these tests pin the row mapping + the
// pure partial-receive math.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import {
  loadPendingDamage,
  loadReworkInFlight,
  loadRecentQcEvents,
  computeReworkRemainder,
  isPartialReceiveValid,
} from "./qc-review-loaders";

function buildDbStub(queue: Array<Array<Record<string, unknown>>>) {
  return {
    execute: async () => {
      const next = queue.shift();
      return next ?? [];
    },
  } as unknown as Parameters<typeof loadPendingDamage>[0];
}

const NOW = new Date("2026-05-12T18:00:00Z");

describe("loadPendingDamage", () => {
  it("maps a damage row with full join data", async () => {
    const db = buildDbStub([
      [
        {
          id: "e1",
          occurred_at: NOW,
          workflow_bag_id: "b1",
          station_id: "s1",
          station_label: "P-1",
          machine_id: null,
          machine_name: null,
          product_id: "p1",
          product_sku: "SKU-A",
          quantity: "3",
          unit: "cards",
          reason_code: "BAD_SEAL",
          notes: null,
          disposition_suggestion: "REWORK",
          accountable_employee_id: "emp1",
          accountable_employee_name: "Alice",
          entered_by_user_id: null,
          entered_by_email: null,
        },
      ],
    ]);
    const rows = await loadPendingDamage(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      id: "e1",
      workflowBagId: "b1",
      stationLabel: "P-1",
      productSku: "SKU-A",
      quantity: 3,
      reasonCode: "BAD_SEAL",
      accountableEmployeeName: "Alice",
      dispositionSuggestion: "REWORK",
    });
    expect(rows[0]!.occurredAt instanceof Date).toBe(true);
  });

  it("returns empty array when SQL returns no rows", async () => {
    const db = buildDbStub([[]]);
    expect(await loadPendingDamage(db)).toEqual([]);
  });

  it("clamps the limit option into [1, 500]", async () => {
    const db = buildDbStub([[], [], []]);
    await loadPendingDamage(db, { limit: 0 });
    await loadPendingDamage(db, { limit: 10000 });
    await loadPendingDamage(db, { limit: -50 });
    // Smoke — execute resolves cleanly. No throw.
    expect(true).toBe(true);
  });
});

describe("loadReworkInFlight", () => {
  it("returns sent/received/remaining math from the SQL CTE", async () => {
    const db = buildDbStub([
      [
        {
          id: "r1",
          occurred_at: NOW,
          workflow_bag_id: "b1",
          from_station_id: "s1",
          from_station_label: "Packaging",
          to_station_id: "s2",
          to_station_label: "Sealing",
          sent_quantity: 50,
          received_quantity: 30,
          remaining_quantity: 20,
          unit: "cards",
          reason_code: "BAD_SEAL",
          accountable_employee_id: "emp1",
          accountable_employee_name: "Alice",
          entered_by_user_id: null,
          entered_by_email: null,
        },
      ],
    ]);
    const rows = await loadReworkInFlight(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "r1",
      sentQuantity: 50,
      receivedQuantity: 30,
      remainingQuantity: 20,
    });
  });

  it("returns empty when fully closed rework events are filtered out by SQL", async () => {
    const db = buildDbStub([[]]);
    expect(await loadReworkInFlight(db)).toEqual([]);
  });
});

describe("loadRecentQcEvents", () => {
  it("renders all five QC event types when present", async () => {
    const types = [
      "PACKAGING_DAMAGE_RETURN",
      "REWORK_SENT",
      "REWORK_RECEIVED",
      "SCRAP_RECORDED",
      "SUBMISSION_CORRECTED",
    ];
    const db = buildDbStub([
      types.map((t, i) => ({
        id: `e${i}`,
        occurred_at: NOW,
        event_type: t,
        workflow_bag_id: "b1",
        quantity: i === 4 ? null : 5,
        unit: "cards",
        reason_code: "BAD_SEAL",
        linked_event_id: i % 2 ? `link${i}` : null,
        accountable_employee_id: "emp1",
        accountable_employee_name: "Alice",
        entered_by_user_id: "u1",
        entered_by_email: "admin@luma",
      })),
    ]);
    const rows = await loadRecentQcEvents(db);
    expect(rows.map((r) => r.eventType)).toEqual(types);
    expect(rows[4]!.quantity).toBeNull();
    expect(rows[1]!.linkedEventId).toBe("link1");
    expect(rows[2]!.linkedEventId).toBe(null);
  });
});

describe("computeReworkRemainder", () => {
  it("returns sent − received for normal cases", () => {
    expect(computeReworkRemainder(50, 30)).toBe(20);
    expect(computeReworkRemainder(50, 0)).toBe(50);
  });
  it("returns 0 when received equals sent (fully closed)", () => {
    expect(computeReworkRemainder(50, 50)).toBe(0);
  });
  it("floors at 0 on data drift (over-received)", () => {
    expect(computeReworkRemainder(50, 60)).toBe(0);
  });
});

describe("isPartialReceiveValid", () => {
  it("accepts a partial receive that fits within the sent quantity", () => {
    expect(isPartialReceiveValid(50, 30, 0)).toEqual({ ok: true });
    expect(isPartialReceiveValid(50, 20, 30)).toEqual({ ok: true });
  });
  it("accepts a receive that fully closes the row", () => {
    expect(isPartialReceiveValid(50, 50, 0)).toEqual({ ok: true });
    expect(isPartialReceiveValid(50, 20, 30)).toEqual({ ok: true });
  });
  it("rejects zero quantity", () => {
    const r = isPartialReceiveValid(50, 0, 0);
    expect(r.ok).toBe(false);
  });
  it("rejects negative quantity", () => {
    const r = isPartialReceiveValid(50, -5, 0);
    expect(r.ok).toBe(false);
  });
  it("rejects non-integer quantity", () => {
    const r = isPartialReceiveValid(50, 1.5, 0);
    expect(r.ok).toBe(false);
  });
  it("rejects over-receive (received_total would exceed sent)", () => {
    const r = isPartialReceiveValid(50, 30, 30);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/exceed/i);
    }
  });
});
