import { describe, expect, it } from "vitest";
import { buildActNowPanel } from "@/lib/floor-command/act-now";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";

const emptyIntel = {
  bottleneck: {
    stageKey: { value: null, confidence: "MISSING", label: null },
    oldestAgeMinutes: { value: null, confidence: "MISSING" },
    wip: { value: null, confidence: "MISSING" },
    reason: { value: null, confidence: "MISSING" },
  },
  dashboard: {
    pausedBagsOverThreshold: { value: 0, confidence: "OK" },
  },
} as unknown as FloorProductionIntelligence;

function minimalSnapshot(
  inFlight: FloorManagerSnapshot["inFlight"],
): FloorManagerSnapshot {
  return {
    shiftDayKey: "2026-06-02",
    plant: {
      bagsInFlow: inFlight.length,
      bagsFinalizedShift: 0,
      unitsYieldedShift: 0,
      avgCycleSecShift: null,
      avgYieldPctShift: null,
      damageRatePctShift: null,
      pauseCostUsdToday: 0,
      pauseMinutesToday: 0,
      materialRunwayDays: null,
      laneImbalanceLabel: null,
      damageClusterActive: false,
    },
    stationCommandRows: [],
    machines: [],
    stations: [],
    products: [],
    operators: [],
    downtimeToday: [],
    inFlight,
    recentFinalized: [],
    wipByStage: [],
    stageCycles: [],
    flavorToday: [],
    dataGaps: [],
  };
}

describe("buildActNowPanel", () => {
  it("aggregates many stale bags into one alert per stage", () => {
    const bags = Array.from({ length: 5 }, (_, i) => ({
      workflowBagId: `id-${i}`,
      receiptNumber: null,
      productName: "70H 4ct",
      stage: "BLISTERED",
      elapsedMinutes: 4000 + i,
      isPaused: false,
      isOnHold: false,
    }));
    const items = buildActNowPanel(
      minimalSnapshot(bags),
      [],
      emptyIntel,
    );
    const waiting = items.filter((i) => i.id.startsWith("waiting-group-"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.title).toContain("5 bags stuck");
  });
});
