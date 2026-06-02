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

describe("PAUSE-ENDSHIFT-COPY-1 · counter snapshot copy helpers", () => {
  it("pause errors are reason-aware and do not always reference machine jam", async () => {
    const {
      pauseCounterSnapshotMissingError,
      pauseCounterSnapshotHelperText,
    } = await import("./blister-counter-snapshot");
    expect(pauseCounterSnapshotMissingError("shift_end")).toMatch(/end-shift/);
    expect(pauseCounterSnapshotMissingError("shift_end")).not.toMatch(/machine jam/i);
    expect(pauseCounterSnapshotMissingError("machine_jam")).toMatch(/machine-jam/);
    expect(pauseCounterSnapshotHelperText("shift_end")).toMatch(
      /physical machine counter reset/,
    );
  });

  it("roll change and blister close-out copy mention save-before-reset", async () => {
    const {
      rollChangeCounterHelperText,
      blisterCloseOutCounterHelperText,
    } = await import("./blister-counter-snapshot");
    expect(rollChangeCounterHelperText("PVC")).toMatch(/replacement roll starts after you save/);
    expect(rollChangeCounterHelperText("FOIL")).toMatch(/both active rolls \(PVC \+ foil\)/);
    expect(blisterCloseOutCounterHelperText()).toMatch(
      /Save before resetting the physical machine counter/,
    );
  });
});
