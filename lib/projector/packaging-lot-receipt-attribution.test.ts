import { describe, it, expect } from "vitest";
import {
  planPendingConsumptionAttribution,
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
