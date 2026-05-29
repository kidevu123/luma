import { describe, it, expect } from "vitest";
import {
  isSelectableIdleRollLot,
  filterSelectableIdleRollLots,
} from "./idle-roll-lots";

describe("idle-roll-lots — mount dropdown filter", () => {
  it("AVAILABLE PVC/foil rolls are selectable", () => {
    expect(
      isSelectableIdleRollLot({ status: "AVAILABLE", materialKind: "FOIL_ROLL" }),
    ).toBe(true);
    expect(
      isSelectableIdleRollLot({ status: "AVAILABLE", materialKind: "PVC_ROLL" }),
    ).toBe(true);
    expect(
      isSelectableIdleRollLot({
        status: "AVAILABLE",
        materialKind: "BLISTER_FOIL",
      }),
    ).toBe(true);
  });

  it("IN_USE mounted rolls are not in idle pickers", () => {
    expect(
      isSelectableIdleRollLot({ status: "IN_USE", materialKind: "FOIL_ROLL" }),
    ).toBe(false);
  });

  it("DEPLETED and SCRAPPED rolls are excluded", () => {
    expect(
      isSelectableIdleRollLot({ status: "DEPLETED", materialKind: "FOIL_ROLL" }),
    ).toBe(false);
    expect(
      isSelectableIdleRollLot({ status: "SCRAPPED", materialKind: "PVC_ROLL" }),
    ).toBe(false);
  });

  it("non-roll packaging kinds are excluded even when AVAILABLE", () => {
    expect(
      isSelectableIdleRollLot({ status: "AVAILABLE", materialKind: "LABEL" }),
    ).toBe(false);
  });

  it("filterSelectableIdleRollLots keeps only available roll kinds", () => {
    const lots = [
      { id: "1", status: "AVAILABLE", materialKind: "FOIL_ROLL" },
      { id: "2", status: "IN_USE", materialKind: "FOIL_ROLL" },
      { id: "3", status: "DEPLETED", materialKind: "PVC_ROLL" },
      { id: "4", status: "AVAILABLE", materialKind: "CAP" },
      { id: "5", status: "AVAILABLE", materialKind: "PVC_ROLL" },
    ];
    expect(filterSelectableIdleRollLots(lots).map((l) => l.id)).toEqual([
      "1",
      "5",
    ]);
  });
});
