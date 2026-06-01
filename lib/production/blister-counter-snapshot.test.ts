import { describe, expect, it } from "vitest";
import {
  isBlisterCounterSnapshotStation,
  parseNonnegativeIntegerInput,
  stationRequiresBlisterCounterSnapshot,
} from "./blister-counter-snapshot";

describe("BLISTER-PAUSE-COUNT-SNAPSHOT-1 · counter snapshot station rules", () => {
  it("requires snapshots for BLISTER and COMBINED machine jams", () => {
    expect(stationRequiresBlisterCounterSnapshot("BLISTER", "machine_jam")).toBe(true);
    expect(stationRequiresBlisterCounterSnapshot("COMBINED", "machine_jam")).toBe(true);
  });

  it("requires snapshots for BLISTER and COMBINED shift end", () => {
    expect(stationRequiresBlisterCounterSnapshot("BLISTER", "shift_end")).toBe(true);
    expect(stationRequiresBlisterCounterSnapshot("COMBINED", "shift_end")).toBe(true);
  });

  it("does not require snapshots for SEALING or PACKAGING in this slice", () => {
    expect(isBlisterCounterSnapshotStation("SEALING")).toBe(false);
    expect(isBlisterCounterSnapshotStation("PACKAGING")).toBe(false);
    expect(stationRequiresBlisterCounterSnapshot("SEALING", "machine_jam")).toBe(false);
    expect(stationRequiresBlisterCounterSnapshot("PACKAGING", "shift_end")).toBe(false);
  });

  it("allows actual zero and rejects missing/non-numeric values", () => {
    expect(parseNonnegativeIntegerInput("0")).toBe(0);
    expect(parseNonnegativeIntegerInput("58")).toBe(58);
    expect(parseNonnegativeIntegerInput("")).toBeNull();
    expect(parseNonnegativeIntegerInput("1.5")).toBeNull();
    expect(parseNonnegativeIntegerInput("-1")).toBeNull();
    expect(parseNonnegativeIntegerInput("abc")).toBeNull();
  });
});
