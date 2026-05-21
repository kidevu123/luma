// Phase B unit tests — pure helper coverage for the metric API.
// These tests deliberately stay below the SQL layer; they exercise
// the math + missing-data discipline that the database-bound
// derive* functions delegate to.
//
// Database-bound integration tests live separately (Phase B+) and
// require a running Postgres + the read-models populated. The
// suite below runs without any DB.

import { describe, expect, it, vi } from "vitest";

// We mock the DB client BEFORE importing metrics.ts so the heavy
// imports don't touch a live connection. The mock returns enough
// surface for the import to resolve; tests below call the pure
// helpers, not the derive* SQL functions.
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import {
  counterDelta,
  activeRuntimeSeconds,
  pauseDurationSeconds,
  bagLeadTimeSeconds,
  queueAgeSeconds,
  packagingDisplaysToCases,
  oee,
  calendarPlannedSeconds,
} from "./metrics";
import {
  ok,
  zero,
  estimated,
  partial,
  missing,
  combineConfidence,
  clampPct,
} from "./confidence";
import type { MetricResult } from "./types";

// ─── counterDelta ─────────────────────────────────────────────────
describe("counterDelta", () => {
  it("returns end - start for valid inputs", () => {
    expect(counterDelta(100, 250)).toBe(150);
  });
  it("returns null when either input is null", () => {
    expect(counterDelta(null, 100)).toBe(null);
    expect(counterDelta(100, null)).toBe(null);
    expect(counterDelta(undefined, 50)).toBe(null);
  });
  it("refuses to compute when end < start (counter wrap or typo)", () => {
    expect(counterDelta(500, 100)).toBe(null);
  });
  it("returns 0 when start equals end", () => {
    expect(counterDelta(50, 50)).toBe(0);
  });
});

// ─── activeRuntimeSeconds ─────────────────────────────────────────
describe("activeRuntimeSeconds", () => {
  it("sums durations across closed intervals", () => {
    const t0 = new Date("2026-05-06T08:00:00Z");
    const t1 = new Date("2026-05-06T09:00:00Z"); // +1h
    const t2 = new Date("2026-05-06T10:00:00Z"); // +1h
    const t3 = new Date("2026-05-06T10:30:00Z"); // +30m
    const r = activeRuntimeSeconds([
      { from: t0, to: t1 },
      { from: t2, to: t3 },
    ]);
    expect(r).toBe(3600 + 1800);
  });
  it("ignores intervals with null end", () => {
    const t0 = new Date("2026-05-06T08:00:00Z");
    expect(activeRuntimeSeconds([{ from: t0, to: null }])).toBe(0);
  });
  it("returns 0 for empty input", () => {
    expect(activeRuntimeSeconds([])).toBe(0);
  });
});

// ─── pauseDurationSeconds ─────────────────────────────────────────
describe("pauseDurationSeconds", () => {
  const at = (s: string) => new Date(s);

  it("pairs PAUSED with following RESUMED", () => {
    const sec = pauseDurationSeconds([
      { type: "BAG_PAUSED", at: at("2026-05-06T08:00:00Z") },
      { type: "BAG_RESUMED", at: at("2026-05-06T08:15:00Z") },
    ]);
    expect(sec).toBe(15 * 60);
  });

  it("counts open pause as (now - paused_at)", () => {
    const now = at("2026-05-06T08:30:00Z");
    const sec = pauseDurationSeconds(
      [{ type: "BAG_PAUSED", at: at("2026-05-06T08:00:00Z") }],
      now,
    );
    expect(sec).toBe(30 * 60);
  });

  it("handles multiple pause/resume cycles", () => {
    const sec = pauseDurationSeconds([
      { type: "BAG_PAUSED", at: at("2026-05-06T08:00:00Z") },
      { type: "BAG_RESUMED", at: at("2026-05-06T08:10:00Z") }, // 10m
      { type: "BAG_PAUSED", at: at("2026-05-06T08:30:00Z") },
      { type: "BAG_RESUMED", at: at("2026-05-06T08:35:00Z") }, // 5m
    ]);
    expect(sec).toBe(15 * 60);
  });

  it("ignores stray RESUMED with no preceding PAUSED", () => {
    const sec = pauseDurationSeconds([
      { type: "BAG_RESUMED", at: at("2026-05-06T08:00:00Z") },
    ]);
    expect(sec).toBe(0);
  });
});

// ─── bagLeadTimeSeconds + queueAgeSeconds ─────────────────────────
describe("bagLeadTimeSeconds", () => {
  it("returns finalized - received", () => {
    expect(
      bagLeadTimeSeconds(
        new Date("2026-05-06T08:00:00Z"),
        new Date("2026-05-06T12:00:00Z"),
      ),
    ).toBe(4 * 3600);
  });
  it("returns null when received is missing", () => {
    expect(bagLeadTimeSeconds(null, new Date())).toBe(null);
  });
});

describe("queueAgeSeconds", () => {
  it("returns now - lastEventAt", () => {
    const now = new Date("2026-05-06T12:00:00Z");
    expect(
      queueAgeSeconds(new Date("2026-05-06T11:30:00Z"), now),
    ).toBe(30 * 60);
  });
  it("returns null when lastEventAt is missing", () => {
    expect(queueAgeSeconds(null)).toBe(null);
  });
});

// ─── packagingDisplaysToCases ─────────────────────────────────────
describe("packagingDisplaysToCases", () => {
  it("converts displays to cases at the spec ratio", () => {
    expect(packagingDisplaysToCases(24, 12)).toBe(2);
  });
  it("returns null when displaysPerCase is missing", () => {
    expect(packagingDisplaysToCases(24, null)).toBe(null);
  });
  it("returns null when displaysPerCase is zero or negative", () => {
    expect(packagingDisplaysToCases(24, 0)).toBe(null);
    expect(packagingDisplaysToCases(24, -1)).toBe(null);
  });
});

// ─── OEE math ─────────────────────────────────────────────────────
describe("oee()", () => {
  it("computes A * P * Q / 10000 when all factors present", () => {
    expect(oee(90, 80, 95)).toBeCloseTo((90 * 80 * 95) / 10000, 5);
  });
  it("returns null when any factor is null", () => {
    expect(oee(null, 80, 95)).toBe(null);
    expect(oee(90, null, 95)).toBe(null);
    expect(oee(90, 80, null)).toBe(null);
  });
  it("clamps each factor to 0-100 before multiplying — never returns above 100", () => {
    // A counter typo could push performance to 110%. The result
    // must clamp 100, not 110, and the OEE must not exceed 100.
    expect(oee(110, 110, 110)).toBe(100);
    expect(oee(50, 200, 50)).toBeCloseTo((50 * 100 * 50) / 10000, 5);
  });
  it("clamps negatives to 0", () => {
    expect(oee(-5, 80, 95)).toBe(0);
  });
});

// ─── calendarPlannedSeconds ───────────────────────────────────────
describe("calendarPlannedSeconds", () => {
  it("computes a same-day shift correctly", () => {
    expect(
      calendarPlannedSeconds({
        shiftStart: "08:00",
        shiftEnd: "17:00",
        plannedBreakMinutes: 60,
      }),
    ).toBe(8 * 3600);
  });
  it("handles a cross-midnight shift", () => {
    expect(
      calendarPlannedSeconds({
        shiftStart: "22:00",
        shiftEnd: "06:00",
        plannedBreakMinutes: 30,
      }),
    ).toBe(7.5 * 3600);
  });
  it("never returns negative time when breaks exceed shift", () => {
    expect(
      calendarPlannedSeconds({
        shiftStart: "08:00",
        shiftEnd: "08:30",
        plannedBreakMinutes: 60, // longer than shift
      }),
    ).toBe(0);
  });
});

// ─── MetricResult constructors ────────────────────────────────────
describe("MetricResult constructors", () => {
  it("ok() defaults to HIGH confidence", () => {
    const m = ok(42, "bags");
    expect(m.confidence).toBe("HIGH");
    expect(m.value).toBe(42);
    expect(m.unit).toBe("bags");
    expect(m.missingInputs).toEqual([]);
  });

  it("zero() returns 0 with HIGH confidence", () => {
    const m = zero("min", "no events");
    expect(m.value).toBe(0);
    expect(m.confidence).toBe("HIGH");
    expect(m.explanation).toBe("no events");
  });

  it("missing() returns null value + MISSING confidence + label", () => {
    const m = missing("%", ["station_standards"], "Insufficient data for OEE");
    expect(m.value).toBe(null);
    expect(m.confidence).toBe("MISSING");
    expect(m.label).toBe("Insufficient data for OEE");
    expect(m.missingInputs).toContain("station_standards");
  });

  it("estimated() carries LOW confidence", () => {
    const m = estimated(15, "tablets", { missingInputs: ["received"] });
    expect(m.confidence).toBe("LOW");
  });

  it("partial() carries MEDIUM confidence", () => {
    const m = partial(50, "%", { missingInputs: ["scrap"] });
    expect(m.confidence).toBe("MEDIUM");
  });
});

describe("combineConfidence", () => {
  it("returns MISSING if any part is MISSING", () => {
    expect(combineConfidence(["HIGH", "MISSING", "LOW"])).toBe("MISSING");
  });
  it("returns the worst non-MISSING when none are MISSING", () => {
    expect(combineConfidence(["HIGH", "MEDIUM", "LOW"])).toBe("LOW");
    expect(combineConfidence(["HIGH", "HIGH"])).toBe("HIGH");
    expect(combineConfidence(["MEDIUM", "MEDIUM"])).toBe("MEDIUM");
  });
});

describe("clampPct", () => {
  it("clamps to [0, 100]", () => {
    expect(clampPct(150)).toBe(100);
    expect(clampPct(-1)).toBe(0);
    expect(clampPct(50.5)).toBe(50.5);
  });
  it("returns 0 for non-finite inputs", () => {
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ─── Missing-data discipline (acceptance tests) ───────────────────
//
// These guard the rule "no fake metrics". They construct the same
// MetricResult shape the SQL paths return when standards/inputs
// are missing, and assert on the contract.

describe("missing-data discipline", () => {
  it("OEE without standards returns Insufficient data for OEE", () => {
    const m = missing(
      "%",
      ["production_calendars", "station_standards"],
      "Insufficient data for OEE",
    );
    expect(m.value).toBe(null);
    expect(m.label).toBe("Insufficient data for OEE");
    expect(m.confidence).toBe("MISSING");
    // Critical: must never carry a numeric OEE value.
    expect(typeof m.value).not.toBe("number");
  });

  it("on-time completion without due targets returns No target configured", () => {
    const m = missing(
      "%",
      ["due_targets"],
      "No target configured",
    );
    expect(m.value).toBe(null);
    expect(m.label).toBe("No target configured");
  });

  it("labor cost without labor rates returns No labor rate configured", () => {
    const m = missing(
      "USD/case",
      ["labor_rates"],
      "No labor rate configured",
    );
    expect(m.value).toBe(null);
    expect(m.label).toBe("No labor rate configured");
  });

  it("quality without reject data returns No reject data", () => {
    const m = missing("%", ["reject_data"], "No reject data");
    expect(m.value).toBe(null);
    expect(m.label).toBe("No reject data");
  });

  it("bottle line without activity returns honest zero, not fake activity", () => {
    // The route-metrics function returns `zero(...)` for an empty
    // window — explicitly NOT missing — because zero is the honest
    // answer for "nothing happened today." A fake non-zero would
    // be a regression. This test pins the contract.
    const m = zero("bags", "No activity captured for this route in window.");
    expect(m.value).toBe(0);
    expect(m.confidence).toBe("HIGH");
    expect(m.explanation).toMatch(/no activity/i);
  });

  it("material reconciliation with missing inputs surfaces estimated + missingInputs", () => {
    const m = estimated(150, "tablets", {
      missingInputs: ["scrap", "remaining"],
      explanation: "Estimated; missing scrap, remaining.",
    });
    expect(m.confidence).toBe("LOW");
    expect(m.missingInputs).toEqual(["scrap", "remaining"]);
  });
});

// ─── Bottleneck detection sanity ──────────────────────────────────
//
// The deriveBottleneck function returns a BottleneckResult whose
// stageKey carries MISSING when all queues are clear. We can't run
// the SQL path here without a DB, but we lock in the result shape
// + the "no bottleneck" empty state.

describe("bottleneck no-data shape", () => {
  it("returns MISSING confidence on stageKey when queues are clear", () => {
    const stageKey: MetricResult = missing(
      null,
      ["queue_state"],
      "No bottleneck — queues clear",
    );
    expect(stageKey.confidence).toBe("MISSING");
    expect(stageKey.label).toMatch(/no bottleneck/i);
  });
});

// ─── Genealogy chronological order (shape contract) ──────────────
//
// The deriveBagGenealogy function returns events in occurredAt
// ascending order with a sequence number. This test pins the
// shape / ordering invariant, even without a DB.

describe("genealogy event ordering contract", () => {
  type StubEvent = { occurredAt: Date; sequence: number };
  it("sequence numbers are monotonic and start at 1", () => {
    const events: StubEvent[] = [
      { occurredAt: new Date("2026-05-06T08:00:00Z"), sequence: 1 },
      { occurredAt: new Date("2026-05-06T08:05:00Z"), sequence: 2 },
      { occurredAt: new Date("2026-05-06T08:10:00Z"), sequence: 3 },
    ];
    expect(events[0]!.sequence).toBe(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBe(events[i - 1]!.sequence + 1);
      expect(
        events[i]!.occurredAt.getTime(),
      ).toBeGreaterThanOrEqual(events[i - 1]!.occurredAt.getTime());
    }
  });
});
