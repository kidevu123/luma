import { describe, it, expect } from "vitest";
import {
  isSelectableIdleRollLot,
  filterSelectableIdleRollLots,
  filterIdleRollLotsForRole,
  idleRollLotMatchesRole,
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

describe("idle-roll-lots — role-first mount filtering", () => {
  const lots = [
    { id: "pvc1", status: "AVAILABLE", materialKind: "PVC_ROLL" },
    { id: "foil1", status: "AVAILABLE", materialKind: "FOIL_ROLL" },
    { id: "foil2", status: "AVAILABLE", materialKind: "BLISTER_FOIL" },
    { id: "pvc2", status: "AVAILABLE", materialKind: "PVC_ROLL" },
  ];

  it("idleRollLotMatchesRole maps material kinds to PVC/FOIL", () => {
    expect(idleRollLotMatchesRole({ materialKind: "PVC_ROLL" }, "PVC")).toBe(true);
    expect(idleRollLotMatchesRole({ materialKind: "PVC_ROLL" }, "FOIL")).toBe(false);
    expect(idleRollLotMatchesRole({ materialKind: "FOIL_ROLL" }, "FOIL")).toBe(true);
    expect(idleRollLotMatchesRole({ materialKind: "BLISTER_FOIL" }, "FOIL")).toBe(true);
  });

  it("filterIdleRollLotsForRole returns only matching rolls", () => {
    expect(filterIdleRollLotsForRole(lots, "PVC").map((l) => l.id)).toEqual([
      "pvc1",
      "pvc2",
    ]);
    expect(filterIdleRollLotsForRole(lots, "FOIL").map((l) => l.id)).toEqual([
      "foil1",
      "foil2",
    ]);
  });
});
