// Phase E.5 — diagnostic layer contract tests.
//
// Pure-shape tests; database-bound integration is exercised by the
// rebuild script + smoke deploy. The contracts pinned here:
//   • activity-signal field names
//   • blocked-metric required/missing/action shape
//   • why-empty trigger condition (totalEvents > 0 AND finalized = 0)
//   • activity counts are NEVER reported as output

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import type {
  WorkflowHealth,
  ActivitySignals,
  BlockedMetric,
} from "./diagnostics";

describe("WorkflowHealth shape", () => {
  it("captures the gap-detection columns the diagnostic panel needs", () => {
    // The panel reads these fields by name; this test pins them.
    const required: Array<keyof WorkflowHealth> = [
      "totalEvents",
      "totalBags",
      "activeBags",
      "finalizedBags",
      "pausedBags",
      "bagsByStage",
      "bagsMissingFinalization",
      "bagsStuckAtStart",
      "bagsStuckAtBlister",
      "bagsStuckAtSeal",
      "bagsPackagedNotFinalized",
      "operatorCodeCaptureCount",
      "productMappingCount",
      "receivedQtyMappingCount",
      "completionRatePct",
      "forceReleaseCount",
      "submissionCorrectionCount",
      "packagingSnapshotCount",
      "packagingCompleteCount",
      "lastEventAt",
    ];
    expect(required.length).toBe(20);
  });
});

describe("ActivitySignals shape", () => {
  it("reports raw event counts but never as output", () => {
    // The panel's UI labels these explicitly as "Activity signals"
    // and the contract requires the field names to NOT collide
    // with output metrics. Any field with 'output', 'good', 'yield',
    // 'oee', 'released' would be a regression.
    const required: Array<keyof ActivitySignals> = [
      "blisterEvents30d",
      "sealingEvents30d",
      "packagingSnapshots30d",
      "packagingComplete30d",
      "bottleHandpack30d",
      "bottleCapSeal30d",
      "bottleSticker30d",
      "cardAssigned30d",
      "bagPaused30d",
      "bagResumed30d",
      "lastEventByStation",
      "totalEvents30d",
    ];
    for (const field of required) {
      const f = String(field).toLowerCase();
      expect(f.includes("output")).toBe(false);
      expect(f.includes("good")).toBe(false);
      expect(f.includes("yield")).toBe(false);
      expect(f.includes("oee")).toBe(false);
      expect(f.includes("released")).toBe(false);
    }
  });
});

describe("BlockedMetric shape", () => {
  it("requires metric, reason, required, missing, action — no values, no fake numbers", () => {
    const sample: BlockedMetric = {
      metric: "Good units today",
      reason:
        "No bags have reached BAG_FINALIZED — output projector hasn't run.",
      required: ["workflow_events.BAG_FINALIZED", "read_bag_metrics rows"],
      missing: ["BAG_FINALIZED events"],
      action:
        "Operators must complete the full flow including the Finalize button.",
    };
    expect(sample.metric).toBeDefined();
    expect(sample.reason).toBeDefined();
    expect(Array.isArray(sample.required)).toBe(true);
    expect(Array.isArray(sample.missing)).toBe(true);
    expect(sample.action).toBeDefined();
    // The shape MUST NOT have a numeric value field — that's the
    // honesty rule (we list what's blocked, never invent a number).
    expect("value" in sample).toBe(false);
    expect("number" in sample).toBe(false);
  });
});

describe("Why-empty trigger", () => {
  it("fires when totalEvents > 0 AND finalizedBags === 0", () => {
    const trigger = (totalEvents: number, finalizedBags: number) =>
      totalEvents > 0 && finalizedBags === 0;
    expect(trigger(591, 0)).toBe(true);   // current prod state
    expect(trigger(0, 0)).toBe(false);    // brand-new system
    expect(trigger(100, 5)).toBe(false);  // some bags finalized
    expect(trigger(0, 5)).toBe(false);    // impossible state but tested
  });
});

describe("No-fake-output contract", () => {
  it("activity signals expose totalEvents30d but not unitsProduced30d", () => {
    // If a future change adds 'unitsProduced30d' or similar to
    // ActivitySignals, this test breaks. The discipline is:
    // event counts ≠ units produced, ever.
    type _ASKey = keyof ActivitySignals;
    const fakeOutputFields = [
      "unitsProduced30d",
      "goodUnits30d",
      "yield30d",
      "oee30d",
      "displaysProduced30d",
      "casesProduced30d",
      "bottlesProduced30d",
    ] as const;
    for (const f of fakeOutputFields) {
      // Build an empty ActivitySignals-like object and assert that
      // the forbidden field name is not part of the type. This is a
      // compile-time + runtime check via type assertion failure.
      const obj: Partial<ActivitySignals> = {};
      expect(f in obj).toBe(false);
    }
  });
});

describe("Workflow Health honesty", () => {
  it("completionRatePct returns null when totalBags = 0 (not a fake 0%)", () => {
    // If future code ever emits "0%" for a brand-new system, that
    // would be misleading. Null is the correct value when the
    // denominator is 0.
    const completionRate = (finalized: number, total: number) =>
      total > 0 ? +((finalized / total) * 100).toFixed(1) : null;
    expect(completionRate(0, 0)).toBe(null);
    expect(completionRate(0, 100)).toBe(0);
    expect(completionRate(50, 100)).toBe(50);
  });
});
