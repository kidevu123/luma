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
    shiftActivity: {
      throughputDayKey: "2026-06-02",
      shiftStartUtc: "2026-06-02T10:00:00.000Z",
      bagsInFlow: inFlight.length,
      atStation: 0,
      blisteredShift: 0,
      sealedShift: 0,
      packagedShift: 0,
      finalizedShift: 0,
      unitsFinalizedShift: 0,
      displaysShift: 0,
      casesShift: 0,
      activeOnFloor: 0,
    },
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

  it("surfaces Report Problem's three events (P4b Task 4) — downtime/QA as crit, the catch-all as warn", () => {
    const items = buildActNowPanel(minimalSnapshot([]), [
      {
        type: "production_exception",
        label: "SEALING 2",
        detail: "Machine down — will not cycle.",
        exceptionEventType: "DOWNTIME_STARTED",
        receiptNumber: "R-1001",
      },
      {
        type: "production_exception",
        label: "PACKAGING 1",
        detail: "Quality hold — suspect foil seal.",
        exceptionEventType: "QA_HOLD_STARTED",
        receiptNumber: null,
      },
      {
        type: "production_exception",
        label: "BLISTER 3",
        detail: "MATERIAL — wrong PVC roll loaded.",
        exceptionEventType: "PRODUCTION_EXCEPTION_RAISED",
        receiptNumber: null,
      },
    ], emptyIntel);

    const exceptions = items.filter((i) => i.id.startsWith("exception-"));
    expect(exceptions).toHaveLength(3);
    expect(exceptions[0]).toMatchObject({
      severity: "crit",
      title: "SEALING 2",
      href: "/workflow-submissions?receipt=R-1001",
    });
    expect(exceptions[1]).toMatchObject({
      severity: "crit",
      title: "PACKAGING 1",
      href: "/workflow-submissions",
    });
    expect(exceptions[2]).toMatchObject({ severity: "warn", title: "BLISTER 3" });
  });

  it("caps production_exception rows at 3 (MED 2, fix round 1) — no dismissal path yet, must not monopolize the 6-slot rail", () => {
    const attention = Array.from({ length: 6 }, (_, i) => ({
      type: "production_exception" as const,
      label: `STATION ${i}`,
      detail: "Machine down.",
      exceptionEventType: "DOWNTIME_STARTED" as const,
      receiptNumber: null,
    }));
    const items = buildActNowPanel(minimalSnapshot([]), attention, emptyIntel);
    const exceptions = items.filter((i) => i.id.startsWith("exception-"));
    expect(exceptions).toHaveLength(3);
    expect(exceptions.map((i) => i.title)).toEqual([
      "STATION 0",
      "STATION 1",
      "STATION 2",
    ]);
  });
});
