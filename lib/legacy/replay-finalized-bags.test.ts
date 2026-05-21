// Phase E.6 — replay backfill decision contract tests.
//
// Pure-helper coverage for `decideBackfill`. Database-bound replay
// is exercised by the deploy verification.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { execute: () => [], transaction: () => Promise.resolve() },
}));

import { decideBackfill } from "./replay-finalized-bags";

describe("decideBackfill", () => {
  const eventAt = new Date("2026-05-06T17:00:00Z");

  it("returns ALREADY_FINALIZED when finalized_at already set", () => {
    const r = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: new Date("2026-05-05T00:00:00Z"),
      latestFinalizedEventAt: eventAt,
      hasBagFinalizedEvent: true,
    });
    expect(r.status).toBe("ALREADY_FINALIZED");
    expect(r.missingInputs).toEqual([]);
  });

  it("returns BACKFILLED when event exists and finalized_at is null", () => {
    const r = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: null,
      latestFinalizedEventAt: eventAt,
      hasBagFinalizedEvent: true,
    });
    expect(r.status).toBe("BACKFILLED");
    expect(r.missingInputs).toEqual([]);
    expect(r.reason).toContain(eventAt.toISOString());
  });

  it("returns SKIPPED with missingInputs when no BAG_FINALIZED event", () => {
    const r = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: null,
      latestFinalizedEventAt: null,
      hasBagFinalizedEvent: false,
    });
    expect(r.status).toBe("SKIPPED");
    expect(r.missingInputs).toContain("BAG_FINALIZED event");
  });

  it("returns SKIPPED when event flag set but occurred_at missing (defensive)", () => {
    // The schema has occurred_at NOT NULL so this shouldn't happen,
    // but the helper guards anyway.
    const r = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: null,
      latestFinalizedEventAt: null,
      hasBagFinalizedEvent: true,
    });
    expect(r.status).toBe("SKIPPED");
    expect(r.missingInputs).toContain("occurred_at on BAG_FINALIZED event");
  });

  it("never invents a finalized_at value when inputs are missing", () => {
    const r = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: null,
      latestFinalizedEventAt: null,
      hasBagFinalizedEvent: false,
    });
    // Status is SKIPPED → caller will not write a finalized_at
    expect(r.status).toBe("SKIPPED");
    // Reason must NOT contain a fabricated timestamp
    expect(r.reason).not.toMatch(/2026|2025|now/i);
  });
});

describe("Replay idempotency contract", () => {
  it("a second run after BACKFILLED converts to ALREADY_FINALIZED", () => {
    const eventAt = new Date("2026-05-06T17:00:00Z");
    // First call: would backfill
    const first = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: null,
      latestFinalizedEventAt: eventAt,
      hasBagFinalizedEvent: true,
    });
    expect(first.status).toBe("BACKFILLED");

    // Second call after side effect: row now has finalized_at
    const second = decideBackfill({
      workflowBagId: "abc",
      currentFinalizedAt: eventAt,
      latestFinalizedEventAt: eventAt,
      hasBagFinalizedEvent: true,
    });
    expect(second.status).toBe("ALREADY_FINALIZED");
  });
});
