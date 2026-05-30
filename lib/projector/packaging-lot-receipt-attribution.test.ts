import { describe, it, expect, vi } from "vitest";
import {
  planPendingConsumptionAttribution,
  loadPendingEstimatedEventsForAttribution,
  applyReceiptAttribution,
  type PendingEstimatedEvent,
  type ReceivedLot,
} from "./packaging-lot-receipt-attribution";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<PendingEstimatedEvent> & Pick<PendingEstimatedEvent, "id">,
): PendingEstimatedEvent {
  return {
    packagingMaterialId: "mat-a",
    qtyConsumed: 50,
    occurredAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeLot(overrides?: Partial<ReceivedLot>): ReceivedLot {
  return {
    id: "lot-1",
    packagingMaterialId: "mat-a",
    qtyAvailableToAttribute: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Full attribution — all events covered
// ---------------------------------------------------------------------------

describe("planPendingConsumptionAttribution", () => {
  it("Test 1: fully attributes all events when lot is large enough", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", qtyConsumed: 50, occurredAt: new Date("2026-01-01") }),
      makeEvent({ id: "e2", qtyConsumed: 60, occurredAt: new Date("2026-01-02") }),
      makeEvent({ id: "e3", qtyConsumed: 40, occurredAt: new Date("2026-01-03") }),
    ];
    const lot = makeLot({ qtyAvailableToAttribute: 200 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(3);
    expect(plan.rows.every((r) => r.fullyAttributed)).toBe(true);
    expect(plan.remainingLotQty).toBe(50); // 200 - (50+60+40)
    expect(plan.skipped).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 2: Partial attribution — lot smaller than total pending
  // -------------------------------------------------------------------------

  it("Test 2: partially attributes when lot is smaller than total pending", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", qtyConsumed: 100, occurredAt: new Date("2026-01-01") }),
      makeEvent({ id: "e2", qtyConsumed: 100, occurredAt: new Date("2026-01-02") }),
    ];
    const lot = makeLot({ qtyAvailableToAttribute: 150 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]).toMatchObject({
      sourceEstimatedEventId: "e1",
      qtyToAttribute: 100,
      fullyAttributed: true,
      remainingPendingQty: 0,
    });
    expect(plan.rows[1]).toMatchObject({
      sourceEstimatedEventId: "e2",
      qtyToAttribute: 50,
      fullyAttributed: false,
      remainingPendingQty: 50,
    });
    expect(plan.remainingLotQty).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Cross-material isolation
  // -------------------------------------------------------------------------

  it("Test 3: skips events for different materials with material_mismatch", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", packagingMaterialId: "mat-a", qtyConsumed: 50 }),
      makeEvent({ id: "e2", packagingMaterialId: "mat-b", qtyConsumed: 50 }),
    ];
    const lot = makeLot({ packagingMaterialId: "mat-a", qtyAvailableToAttribute: 200 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.sourceEstimatedEventId).toBe("e1");
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toBe("material_mismatch");
    expect(plan.skipped[0]!.eventId).toBe("e2");
  });

  // -------------------------------------------------------------------------
  // Test 4: FIFO ordering
  // -------------------------------------------------------------------------

  it("Test 4: attributes in FIFO (oldest first) even when input is reverse-chronological", () => {
    // Input in reverse order: T3 > T2 > T1
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e3", qtyConsumed: 40, occurredAt: new Date("2026-01-03") }),
      makeEvent({ id: "e2", qtyConsumed: 60, occurredAt: new Date("2026-01-02") }),
      makeEvent({ id: "e1", qtyConsumed: 50, occurredAt: new Date("2026-01-01") }),
    ];
    // Lot covers e1 + e2 (50+60=110) but not e3
    const lot = makeLot({ qtyAvailableToAttribute: 110 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]!.sourceEstimatedEventId).toBe("e1");
    expect(plan.rows[1]!.sourceEstimatedEventId).toBe("e2");
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.eventId).toBe("e3");
    expect(plan.skipped[0]!.reason).toBe("lot_exhausted");
  });

  // -------------------------------------------------------------------------
  // Test 5: Deterministic tie-break — same occurredAt
  // -------------------------------------------------------------------------

  it("Test 5: tie-breaks by id ASC (lexicographic) when occurredAt is identical", () => {
    const sameTime = new Date("2026-01-01T12:00:00Z");
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e-bbb", qtyConsumed: 50, occurredAt: sameTime }),
      makeEvent({ id: "e-aaa", qtyConsumed: 50, occurredAt: sameTime }),
    ];
    // Lot only covers one event
    const lot = makeLot({ qtyAvailableToAttribute: 50 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.sourceEstimatedEventId).toBe("e-aaa"); // lex first
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.eventId).toBe("e-bbb");
    expect(plan.skipped[0]!.reason).toBe("lot_exhausted");
  });

  // -------------------------------------------------------------------------
  // Test 6: Zero lot qty — returns empty plan
  // -------------------------------------------------------------------------

  it("Test 6: returns empty plan when lot qtyAvailableToAttribute is 0", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", qtyConsumed: 50 }),
    ];
    const lot = makeLot({ qtyAvailableToAttribute: 0 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toEqual([]);
    expect(plan.remainingLotQty).toBe(0);
    expect(plan.skipped).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 7: Negative lot qty — returns empty plan
  // -------------------------------------------------------------------------

  it("Test 7: returns empty plan when lot qtyAvailableToAttribute is negative", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", qtyConsumed: 50 }),
    ];
    const lot = makeLot({ qtyAvailableToAttribute: -5 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toEqual([]);
    expect(plan.remainingLotQty).toBe(0);
    expect(plan.skipped).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 8: Invalid event qty ignored
  // -------------------------------------------------------------------------

  it("Test 8: skips events with qtyConsumed <= 0 as invalid_qty", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", qtyConsumed: 0 }),
      makeEvent({ id: "e2", qtyConsumed: -10 }),
      makeEvent({ id: "e3", qtyConsumed: 50 }),
    ];
    const lot = makeLot({ qtyAvailableToAttribute: 200 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.sourceEstimatedEventId).toBe("e3");
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.every((s) => s.reason === "invalid_qty")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9: Empty pending events — returns empty plan with full lot qty remaining
  // -------------------------------------------------------------------------

  it("Test 9: returns full lot qty remaining when pendingEvents is empty", () => {
    const lot = makeLot({ qtyAvailableToAttribute: 100 });

    const plan = planPendingConsumptionAttribution([], lot);

    expect(plan.rows).toEqual([]);
    expect(plan.remainingLotQty).toBe(100);
    expect(plan.skipped).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 10: Single event exactly fills lot
  // -------------------------------------------------------------------------

  it("Test 10: single event exactly fills the lot — fullyAttributed true, remainingLotQty 0", () => {
    const events: PendingEstimatedEvent[] = [
      makeEvent({ id: "e1", qtyConsumed: 100 }),
    ];
    const lot = makeLot({ qtyAvailableToAttribute: 100 });

    const plan = planPendingConsumptionAttribution(events, lot);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.fullyAttributed).toBe(true);
    expect(plan.rows[0]!.remainingPendingQty).toBe(0);
    expect(plan.remainingLotQty).toBe(0);
    expect(plan.skipped).toEqual([]);
  });
});

// ─── PACKAGING-RECONCILIATION-SLICE-B — DB loader + write helper tests ───────

// ---------------------------------------------------------------------------
// Mock tx builder helpers
// ---------------------------------------------------------------------------

/** Build a stub tx that returns given rows from execute() and captures inserts. */
function makeStubTx(executeRows: Array<Record<string, unknown>>) {
  const insertedValues: Array<{ into: string; values: unknown }> = [];

  const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  const tx = {
    execute: vi.fn().mockResolvedValue(executeRows),
    insert: mockInsert,
    _insertedValues: insertedValues,
    _mockValues: mockValues,
    _mockInsert: mockInsert,
    _mockOnConflictDoNothing: mockOnConflictDoNothing,
  };

  return tx;
}

// ---------------------------------------------------------------------------
// loadPendingEstimatedEventsForAttribution
// ---------------------------------------------------------------------------

describe("loadPendingEstimatedEventsForAttribution", () => {
  it("Test 11: maps raw SQL rows to PendingEstimatedEvent shape", async () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const rows = [
      {
        id: "42",
        packaging_material_id: "mat-uuid-1",
        qty_consumed: 80,
        occurred_at: now,
      },
      {
        id: "43",
        packaging_material_id: "mat-uuid-1",
        qty_consumed: 30,
        occurred_at: new Date("2026-01-16T10:00:00Z"),
      },
    ];
    const tx = makeStubTx(rows);

    // Cast: loadPendingEstimatedEventsForAttribution accepts a Tx; stub satisfies duck-typing
    const result = await loadPendingEstimatedEventsForAttribution(
      tx as unknown as Parameters<typeof loadPendingEstimatedEventsForAttribution>[0],
      "mat-uuid-1",
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "42",
      packagingMaterialId: "mat-uuid-1",
      qtyConsumed: 80,
    });
    expect(result[0]!.occurredAt).toBeInstanceOf(Date);
    expect(result[1]!.id).toBe("43");
  });

  it("Test 12: returns empty array when no pending rows exist", async () => {
    const tx = makeStubTx([]);

    const result = await loadPendingEstimatedEventsForAttribution(
      tx as unknown as Parameters<typeof loadPendingEstimatedEventsForAttribution>[0],
      "mat-uuid-1",
    );

    expect(result).toEqual([]);
  });

  it("Test 13: converts occurred_at string to Date when not already a Date", async () => {
    const rows = [
      {
        id: "99",
        packaging_material_id: "mat-uuid-2",
        qty_consumed: 10,
        occurred_at: "2026-03-01T00:00:00Z", // string, not Date
      },
    ];
    const tx = makeStubTx(rows);

    const result = await loadPendingEstimatedEventsForAttribution(
      tx as unknown as Parameters<typeof loadPendingEstimatedEventsForAttribution>[0],
      "mat-uuid-2",
    );

    expect(result[0]!.occurredAt).toBeInstanceOf(Date);
    expect(result[0]!.occurredAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// applyReceiptAttribution
// ---------------------------------------------------------------------------

describe("applyReceiptAttribution", () => {
  it("Test 14: returns 0 immediately when qtyAvailable is 0", async () => {
    const tx = makeStubTx([]);

    const count = await applyReceiptAttribution(
      tx as unknown as Parameters<typeof applyReceiptAttribution>[0],
      {
        lotId: "lot-new",
        packagingMaterialId: "mat-a",
        qtyAvailable: 0,
        actorUserId: "user-1",
      },
    );

    expect(count).toBe(0);
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("Test 15: returns 0 and does no inserts when no pending events", async () => {
    const tx = makeStubTx([]); // execute returns empty

    const count = await applyReceiptAttribution(
      tx as unknown as Parameters<typeof applyReceiptAttribution>[0],
      {
        lotId: "lot-new",
        packagingMaterialId: "mat-a",
        qtyAvailable: 500,
        actorUserId: "user-1",
      },
    );

    expect(count).toBe(0);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("Test 16: inserts ACTUAL + VOIDED pair for a single fully-attributed event", async () => {
    const rows = [
      {
        id: "10",
        packaging_material_id: "mat-a",
        qty_consumed: 100,
        occurred_at: new Date("2026-01-10T00:00:00Z"),
      },
    ];
    const tx = makeStubTx(rows);

    const count = await applyReceiptAttribution(
      tx as unknown as Parameters<typeof applyReceiptAttribution>[0],
      {
        lotId: "lot-new",
        packagingMaterialId: "mat-a",
        qtyAvailable: 500,
        actorUserId: "user-admin",
      },
    );

    expect(count).toBe(1);
    // insert should have been called twice (ACTUAL + VOIDED)
    expect(tx.insert).toHaveBeenCalledTimes(2);

    // Check first insert was MATERIAL_CONSUMED_ACTUAL
    const firstCallValues = tx._mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCallValues?.eventType).toBe("MATERIAL_CONSUMED_ACTUAL");
    expect(firstCallValues?.packagingMaterialId).toBe("mat-a");
    expect(firstCallValues?.packagingLotId).toBe("lot-new");
    expect(firstCallValues?.quantityUnits).toBe(100);
    expect(firstCallValues?.actorUserId).toBe("user-admin");
    const actualPayload = firstCallValues?.payload as Record<string, unknown>;
    expect(actualPayload?.source_estimated_event_id).toBe("10");
    expect(actualPayload?.fully_attributed).toBe(true);

    // Check second insert was MATERIAL_ESTIMATED_VOIDED
    const secondCallValues = tx._mockValues.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(secondCallValues?.eventType).toBe("MATERIAL_ESTIMATED_VOIDED");
    expect(secondCallValues?.packagingMaterialId).toBe("mat-a");
    expect(secondCallValues?.packagingLotId).toBe("lot-new");
    expect(secondCallValues?.quantityUnits).toBe(100);
    const voidedPayload = secondCallValues?.payload as Record<string, unknown>;
    expect(voidedPayload?.source_estimated_event_id).toBe("10");
    expect(voidedPayload?.voided_qty).toBe(100);
    expect(voidedPayload?.fully_attributed).toBe(true);
  });

  it("Test 17: inserts pairs for each plan row in partial attribution", async () => {
    // Two pending events; lot only covers first + part of second
    const rows = [
      {
        id: "20",
        packaging_material_id: "mat-b",
        qty_consumed: 60,
        occurred_at: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "21",
        packaging_material_id: "mat-b",
        qty_consumed: 80,
        occurred_at: new Date("2026-01-02T00:00:00Z"),
      },
    ];
    const tx = makeStubTx(rows);

    const count = await applyReceiptAttribution(
      tx as unknown as Parameters<typeof applyReceiptAttribution>[0],
      {
        lotId: "lot-partial",
        packagingMaterialId: "mat-b",
        qtyAvailable: 100, // covers 60 full + 40 partial of second
        actorUserId: null,
      },
    );

    // 2 plan rows → 4 inserts (2 × ACTUAL + VOIDED)
    expect(count).toBe(2);
    expect(tx.insert).toHaveBeenCalledTimes(4);

    // First pair: event 20 fully attributed with 60
    const call0 = tx._mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call0?.eventType).toBe("MATERIAL_CONSUMED_ACTUAL");
    expect(call0?.quantityUnits).toBe(60);
    const payload0 = call0?.payload as Record<string, unknown>;
    expect(payload0?.source_estimated_event_id).toBe("20");
    expect(payload0?.fully_attributed).toBe(true);

    // Second pair: event 21 partially attributed with 40
    const call2 = tx._mockValues.mock.calls[2]?.[0] as Record<string, unknown>;
    expect(call2?.eventType).toBe("MATERIAL_CONSUMED_ACTUAL");
    expect(call2?.quantityUnits).toBe(40);
    const payload2 = call2?.payload as Record<string, unknown>;
    expect(payload2?.source_estimated_event_id).toBe("21");
    expect(payload2?.fully_attributed).toBe(false);
    expect(payload2?.remaining_pending_qty).toBe(40);
  });

  it("Test 18: onConflictDoNothing is called for all inserts (idempotency)", async () => {
    const rows = [
      {
        id: "30",
        packaging_material_id: "mat-c",
        qty_consumed: 50,
        occurred_at: new Date("2026-02-01T00:00:00Z"),
      },
    ];
    const tx = makeStubTx(rows);

    await applyReceiptAttribution(
      tx as unknown as Parameters<typeof applyReceiptAttribution>[0],
      {
        lotId: "lot-idem",
        packagingMaterialId: "mat-c",
        qtyAvailable: 200,
        actorUserId: "user-x",
      },
    );

    // onConflictDoNothing should have been called twice (once per insert)
    expect(tx._mockOnConflictDoNothing).toHaveBeenCalledTimes(2);
  });
});
