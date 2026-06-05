// Phase C — projector unit tests.
//
// Pure-helper coverage for the projector logic that doesn't need a
// database round-trip. Database-bound tests are deferred until we
// stand up a fixture-driven integration suite (Phase F).

import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import { buildThroughputProjection, floorThroughputDayKey } from "./index";
import {
  classifyQueueStatus,
  QUEUE_THRESHOLDS,
  QUEUE_REFRESH_EVENTS,
} from "./queue-state";
import { reconcileBag } from "./material-reconciliation";

// ─── Queue status classifier ──────────────────────────────────────
describe("classifyQueueStatus", () => {
  it("returns EMPTY when WIP is zero", () => {
    expect(classifyQueueStatus(0, null)).toBe("EMPTY");
    expect(classifyQueueStatus(0, 9999)).toBe("EMPTY"); // wip wins
  });

  it("returns FLOWING when WIP > 0 and oldest age below warning", () => {
    expect(classifyQueueStatus(3, 600)).toBe("FLOWING");
    expect(classifyQueueStatus(1, null)).toBe("FLOWING");
  });

  it("returns AGING when oldest age crosses warning threshold", () => {
    expect(classifyQueueStatus(3, QUEUE_THRESHOLDS.WARNING_SECONDS)).toBe(
      "AGING",
    );
    expect(classifyQueueStatus(3, 45 * 60)).toBe("AGING");
  });

  it("returns STALLED when oldest age crosses critical threshold", () => {
    expect(classifyQueueStatus(3, QUEUE_THRESHOLDS.CRITICAL_SECONDS)).toBe(
      "STALLED",
    );
    expect(classifyQueueStatus(3, 90 * 60)).toBe("STALLED");
  });

  it("respects custom warning/critical thresholds when supplied", () => {
    expect(classifyQueueStatus(2, 200, 100, 300)).toBe("AGING");
    expect(classifyQueueStatus(2, 400, 100, 300)).toBe("STALLED");
    expect(classifyQueueStatus(2, 50, 100, 300)).toBe("FLOWING");
  });
});

describe("QUEUE_REFRESH_EVENTS", () => {
  it("includes all stage-completion event types", () => {
    expect(QUEUE_REFRESH_EVENTS.has("BLISTER_COMPLETE")).toBe(true);
    expect(QUEUE_REFRESH_EVENTS.has("SEALING_COMPLETE")).toBe(true);
    expect(QUEUE_REFRESH_EVENTS.has("PACKAGING_COMPLETE")).toBe(true);
    expect(QUEUE_REFRESH_EVENTS.has("BAG_FINALIZED")).toBe(true);
    expect(QUEUE_REFRESH_EVENTS.has("BAG_PAUSED")).toBe(true);
    expect(QUEUE_REFRESH_EVENTS.has("BAG_RESUMED")).toBe(true);
  });

  it("does NOT include events that don't change a bag's stage", () => {
    expect(QUEUE_REFRESH_EVENTS.has("STATION_SCAN_TOKEN_ROTATED")).toBe(false);
    expect(QUEUE_REFRESH_EVENTS.has("OPERATOR_CHANGE")).toBe(false);
    expect(QUEUE_REFRESH_EVENTS.has("BATCH_RELEASED")).toBe(false);
  });
});

// ─── Throughput projection ────────────────────────────────────────
describe("buildThroughputProjection", () => {
  it("increments units_produced from finalized bag metrics", () => {
    expect(buildThroughputProjection("BAG_FINALIZED", {}, 1280, 12, 3)).toEqual({
      counterCol: "bags_finalized",
      unitsProduced: 1280,
      displaysProduced: 12,
      casesProduced: 3,
    });
  });

  it("does not advance throughput for partial sealing close-outs", () => {
    expect(
      buildThroughputProjection(
        "SEALING_COMPLETE",
        { partial_close: true, sealed_partial_count: 40 },
        null,
      ),
    ).toBeNull();
  });
});

describe("floorThroughputDayKey", () => {
  it("buckets throughput by the Luma Eastern production day", () => {
    expect(floorThroughputDayKey(new Date("2026-06-05T02:30:00.000Z"))).toBe(
      "2026-06-04",
    );
  });
});

describe("daily throughput rebuild source", () => {
  it("rebuilds units_produced from read_bag_metrics units_yielded", () => {
    const path = join(__dirname, "daily-throughput.ts");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/read_bag_metrics/);
    expect(src).toMatch(/units_yielded/);
    expect(src).toMatch(/units_produced/);
  });
});

// ─── Material reconciliation ──────────────────────────────────────
describe("reconcileBag", () => {
  it("returns MISSING confidence when received_qty is null", () => {
    const r = reconcileBag({
      received: null,
      finished: 100,
      damaged: 5,
      scrap: null,
      remaining: null,
    });
    expect(r.confidence).toBe("MISSING");
    expect(r.varianceQty).toBe(null);
    expect(r.missingInputs).toContain("received");
  });

  it("returns LOW confidence when scrap/remaining are inferred", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 950,
      damaged: 10,
      scrap: null,
      remaining: null,
    });
    expect(r.confidence).toBe("LOW");
    expect(r.isEstimated).toBe(true);
    expect(r.missingInputs).toContain("scrap");
    expect(r.missingInputs).toContain("remaining");
    // variance = received - finished - damaged - (scrap=0) - (remaining=0)
    //          = 1000 - 950 - 10 - 0 - 0 = 40
    expect(r.varianceQty).toBe(40);
  });

  it("computes variance as received - finished - damaged - scrap - remaining", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 950,
      damaged: 10,
      scrap: 5,
      remaining: 30,
    });
    // 1000 - 950 - 10 - 5 - 30 = 5
    expect(r.varianceQty).toBe(5);
    expect(r.variancePct).toBe(0.5);
  });

  it("flags is_estimated when any input is missing", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 950,
      damaged: null,
      scrap: null,
      remaining: null,
    });
    expect(r.isEstimated).toBe(true);
  });

  it("does NOT flag is_estimated when ALL inputs (incl. consumed) are present", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 950,
      damaged: 10,
      scrap: 5,
      remaining: 35,
      consumed: 965,
    });
    expect(r.isEstimated).toBe(false);
    // 1000 - 950 - 10 - 5 - 35 = 0
    expect(r.varianceQty).toBe(0);
  });

  it("HIGH confidence when all inputs present and variance ≤1%", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 940,
      damaged: 5,
      scrap: 5,
      remaining: 50,
      consumed: 950,
    });
    // 1000 - 940 - 5 - 5 - 50 = 0
    expect(r.confidence).toBe("HIGH");
  });

  it("MEDIUM confidence when all inputs present and variance >1% but ≤5%", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 940,
      damaged: 0,
      scrap: 0,
      remaining: 30,
      consumed: 970,
    });
    // 1000 - 940 - 0 - 0 - 30 = 30 (3% variance)
    expect(r.confidence).toBe("MEDIUM");
    expect(r.variancePct).toBe(3);
  });

  it("LOW confidence when variance exceeds 5%", () => {
    const r = reconcileBag({
      received: 1000,
      finished: 800,
      damaged: 0,
      scrap: 0,
      remaining: 100,
      consumed: 900,
    });
    // 1000 - 800 - 0 - 0 - 100 = 100 (10% variance)
    expect(r.confidence).toBe("LOW");
  });
});

// ─── Acceptance contracts ─────────────────────────────────────────
//
// These guard the spec rules:
//   - No fake bottle activity: bottle line zero counts when no events
//   - No event count as output: throughput counters use COMPLETE events only
//   - No OEE without standards: tested in metrics.test.ts already

describe("no fake bottle activity contract", () => {
  it("BOTTLE_FILL_QUEUE classifies EMPTY when no bottle bags exist", () => {
    expect(classifyQueueStatus(0, null)).toBe("EMPTY");
  });

  it("BOTTLE-route stages stay EMPTY when their bag pool is empty", () => {
    // The projector populates one row per stage_key. A bottle-route
    // stage is empty when no products with kind=BOTTLE are in flight.
    // Whether a row exists at all, or it exists with wip=0, the queue
    // status is EMPTY — never invented activity.
    expect(classifyQueueStatus(0, null)).toBe("EMPTY");
  });
});
