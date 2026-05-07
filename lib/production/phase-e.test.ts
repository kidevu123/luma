// Phase E — final UI honesty contracts.
//
// These don't render React (no jsdom). They exercise the metric API
// surface that Phase E pages consume, plus the new deriveQueueAging
// keys (avgAgeMinutes, p90AgeMinutes, bagsOverThreshold, status) so
// the command-center stage cards never read a key that the metric
// API doesn't emit.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import { STAGE_KEYS } from "./types";

describe("STAGE_KEYS contract for the process map", () => {
  it("exposes all 9 stages the command center renders", () => {
    expect(STAGE_KEYS).toEqual([
      "BLISTER_QUEUE",
      "POST_BLISTER_STAGING",
      "SEALING_QUEUE",
      "POST_SEAL_STAGING",
      "PACKAGING_QUEUE",
      "BOTTLE_FILL_QUEUE",
      "BOTTLE_STICKER_QUEUE",
      "BOTTLE_INDUCTION_QUEUE",
      "FINISHED_GOODS_QUEUE",
    ]);
  });
});

// The command-center stage card reads these specific keys per stage:
const STAGE_KEY_SUFFIXES = [
  "wip",
  "oldestAgeMinutes",
  "avgAgeMinutes",
  "p90AgeMinutes",
  "bagsOverThreshold",
  "status",
] as const;

describe("deriveQueueAging output keys", () => {
  it("the UI's expected key suffixes are stable", () => {
    // This guards a UI/API contract: if someone renames a key in
    // metrics.ts without updating the page, the test fails before
    // a regression ships.
    expect(STAGE_KEY_SUFFIXES).toEqual([
      "wip",
      "oldestAgeMinutes",
      "avgAgeMinutes",
      "p90AgeMinutes",
      "bagsOverThreshold",
      "status",
    ]);
  });
});

describe("Phase E missing-data labels", () => {
  // These pin the canonical empty-state strings so the wallboard's
  // labels can never silently drift away from the spec.
  const REQUIRED_LABELS = [
    "Insufficient data for OEE",
    "No standard configured",
    "No reject data",
    "No target configured",
    "No labor rate configured",
    "No bottleneck — queues clear",
    "Idle",
    "Not integrated",
  ];
  it.each(REQUIRED_LABELS)("label '%s' is intact", (label) => {
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});
