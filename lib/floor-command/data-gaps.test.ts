import { describe, expect, it } from "vitest";
import { buildFloorDataGaps } from "./data-gaps";

describe("buildFloorDataGaps", () => {
  it("flags standards and schedule gaps without inventing OEE or plan metrics", () => {
    const gaps = buildFloorDataGaps({
      productionCalendars: 0,
      stationStandards: 0,
      laborRates: 0,
      dueTargets: 0,
      productsWithDailyGoals: 0,
      activeMachinesWithTargets: 0,
      activeStations: 9,
      stationLiveRows: 9,
      queueRows: 9,
      inFlightWithoutState: 0,
      readDailyUnits: 0,
      bagMetricUnits: 42_000,
      materialBurnRows7d: 0,
      readOperatorDailyRows: 12,
      damageEvents7d: 3,
      reworkEvents7d: 1,
      scrapEvents7d: 0,
      correctionEvents7d: 1,
    });

    expect(gaps.find((g) => g.id === "oee")?.status).toBe("missing");
    expect(gaps.find((g) => g.id === "schedule")?.status).toBe("missing");
    expect(gaps.find((g) => g.id === "throughput-units")?.status).toBe("warn");
    expect(gaps.find((g) => g.id === "scrap-qc")?.detail).toMatch(/scrap/i);
  });

  it("marks read-model health critical when live station or bag-state rows are missing", () => {
    const gaps = buildFloorDataGaps({
      productionCalendars: 1,
      stationStandards: 5,
      laborRates: 2,
      dueTargets: 1,
      productsWithDailyGoals: 0,
      activeMachinesWithTargets: 3,
      activeStations: 10,
      stationLiveRows: 8,
      queueRows: 0,
      inFlightWithoutState: 2,
      readDailyUnits: 100,
      bagMetricUnits: 100,
      materialBurnRows7d: 3,
      readOperatorDailyRows: 4,
      damageEvents7d: 0,
      reworkEvents7d: 0,
      scrapEvents7d: 0,
      correctionEvents7d: 0,
    });

    const live = gaps.find((g) => g.id === "live-read-models");
    expect(live?.status).toBe("crit");
    expect(live?.detail).toContain("2 WIP bags missing state");
  });
});
