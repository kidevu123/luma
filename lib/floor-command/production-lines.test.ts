import { describe, expect, it } from "vitest";
import {
  groupStationCommandRowsByLine,
  sortStationCommandRowsByLine,
} from "./production-lines";
import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";

function row(
  label: string,
  kind: StationCommandRow["stationKind"],
): StationCommandRow {
  return {
    stationId: label,
    stationLabel: label,
    stationKind: kind,
    machineId: null,
    machineName: null,
    machineKind: null,
    cardsPerTurn: null,
    targetBagsPerHour: null,
    workflowBagId: null,
    operatorName: null,
    lastEventType: null,
    lastEventAt: null,
    elapsedSeconds: null,
    stage: null,
    isPaused: false,
    isOnHold: false,
    reworkPending: false,
    operatorCode: null,
    receiptNumber: null,
    startedAt: null,
    workflowBagNumber: null,
    productName: null,
    cardLabel: null,
    internalReceiptNumber: null,
    inventoryBagNumber: null,
    tabletTypeName: null,
    poNumber: null,
    activeOperatorName: null,
    activeOperatorSource: null,
    bagLabel: null,
    bagLabelSecondary: null,
    avgCycleSecShift: null,
    avgCycleSec7d: null,
    queueWip: null,
    queueOldestMinutes: null,
    queueStatus: null,
    todayFinalized: 0,
    todayUnits: 0,
    todayBlistered: 0,
    todaySealed: 0,
    todayPackaged: 0,
    activeRolls: [],
  };
}

describe("production-lines", () => {
  it("sorts card route blister → sealing → packaging", () => {
    const sorted = sortStationCommandRowsByLine([
      row("Packaging Station", "PACKAGING"),
      row("Sealing Station 3", "SEALING"),
      row("Blister Room", "BLISTER"),
    ]);
    expect(sorted.map((r) => r.stationLabel)).toEqual([
      "Blister Room",
      "Sealing Station 3",
      "Packaging Station",
    ]);
  });

  it("groups by line step", () => {
    const groups = groupStationCommandRowsByLine([
      row("Blister Room", "BLISTER"),
      row("Sealing Station 3", "SEALING"),
      row("Packaging Station", "PACKAGING"),
    ]);
    expect(groups.map((g) => g.step.key)).toEqual([
      "blister",
      "sealing",
      "packaging",
    ]);
  });
});
