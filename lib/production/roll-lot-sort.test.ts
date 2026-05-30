import { describe, it, expect } from "vitest";
import { rollNumberSortKey, sortRollLotsForPicker } from "./roll-lot-sort";

type Lot = { id: string; rollNumber: string | null };

function labels(lots: Lot[]): string[] {
  return lots.map((l) => l.rollNumber ?? l.id);
}

describe("roll-lot-sort — natural picker order", () => {
  it("sorts PVC rolls numerically, not lexically", () => {
    const lots: Lot[] = [
      { id: "1", rollNumber: "Legacy PVC-02" },
      { id: "2", rollNumber: "PVC-23" },
      { id: "3", rollNumber: "PVC-40" },
      { id: "4", rollNumber: "PVC-45" },
      { id: "5", rollNumber: "PVC-4" },
      { id: "6", rollNumber: "PVC-7" },
      { id: "7", rollNumber: "PVC-8" },
      { id: "8", rollNumber: "PVC-9" },
    ];
    expect(labels(sortRollLotsForPicker(lots))).toEqual([
      "PVC-4",
      "PVC-7",
      "PVC-8",
      "PVC-9",
      "PVC-23",
      "PVC-40",
      "PVC-45",
      "Legacy PVC-02",
    ]);
  });

  it("sorts FOIL rolls numerically", () => {
    const lots: Lot[] = [
      { id: "a", rollNumber: "FOIL-12" },
      { id: "b", rollNumber: "FOIL-2" },
      { id: "c", rollNumber: "FOIL-10" },
    ];
    expect(labels(sortRollLotsForPicker(lots))).toEqual([
      "FOIL-2",
      "FOIL-10",
      "FOIL-12",
    ]);
  });

  it("places legacy labels after standard numbered rolls", () => {
    const lots: Lot[] = [
      { id: "1", rollNumber: "Legacy PVC-02" },
      { id: "2", rollNumber: "PVC-23" },
      { id: "3", rollNumber: "PVC-4" },
    ];
    expect(labels(sortRollLotsForPicker(lots))).toEqual([
      "PVC-4",
      "PVC-23",
      "Legacy PVC-02",
    ]);
  });

  it("does not mutate the input array", () => {
    const lots: Lot[] = [
      { id: "2", rollNumber: "PVC-23" },
      { id: "1", rollNumber: "PVC-4" },
    ];
    const copy = [...lots];
    sortRollLotsForPicker(lots);
    expect(lots).toEqual(copy);
  });
});

describe("rollNumberSortKey", () => {
  it("treats legacy prefix as legacy bucket", () => {
    expect(rollNumberSortKey("Legacy PVC-02", "x").legacyBucket).toBe(1);
  });

  it("extracts trailing numeric suffix", () => {
    expect(rollNumberSortKey("PVC-40", "x").numericSuffix).toBe(40);
    expect(rollNumberSortKey("PVC-4", "x").numericSuffix).toBe(4);
  });
});
