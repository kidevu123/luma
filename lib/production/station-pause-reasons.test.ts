import { describe, it, expect } from "vitest";
import { getPauseReasonsForStation } from "./station-pause-reasons";

const MACHINE_KINDS = ["BLISTER", "SEALING", "COMBINED"] as const;
const HAND_KINDS = [
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "PACKAGING",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
] as const;
const ALL_KINDS = [...MACHINE_KINDS, ...HAND_KINDS];

describe("STATION-PAUSE-REASONS-1 · pause reason matrix", () => {
  it("machine-bound stations include pvc_swap and machine_jam", () => {
    for (const kind of MACHINE_KINDS) {
      const values = getPauseReasonsForStation(kind).map((r) => r.value);
      expect(values, kind).toContain("pvc_swap");
      expect(values, kind).toContain("machine_jam");
    }
  });

  it("hand-work stations do not include pvc_swap or machine_jam", () => {
    for (const kind of HAND_KINDS) {
      const values = getPauseReasonsForStation(kind).map((r) => r.value);
      expect(values, kind).not.toContain("pvc_swap");
      expect(values, kind).not.toContain("machine_jam");
    }
  });

  it("HANDPACK_BLISTER has no pvc_swap and no machine_jam", () => {
    const values = getPauseReasonsForStation("HANDPACK_BLISTER").map(
      (r) => r.value,
    );
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("machine_jam");
    expect(values).toContain("shift_end");
    expect(values).toContain("qa_check");
    expect(values).toContain("other");
  });

  it("shift_end, qa_check, and other are present for all station kinds", () => {
    for (const kind of ALL_KINDS) {
      const values = getPauseReasonsForStation(kind).map((r) => r.value);
      expect(values, `${kind}: shift_end`).toContain("shift_end");
      expect(values, `${kind}: qa_check`).toContain("qa_check");
      expect(values, `${kind}: other`).toContain("other");
    }
  });

  it("machine-bound default (first reason) is pvc_swap", () => {
    for (const kind of MACHINE_KINDS) {
      expect(
        getPauseReasonsForStation(kind)[0]?.value,
        kind,
      ).toBe("pvc_swap");
    }
  });

  it("hand-work default (first reason) is shift_end", () => {
    for (const kind of HAND_KINDS) {
      expect(
        getPauseReasonsForStation(kind)[0]?.value,
        kind,
      ).toBe("shift_end");
    }
  });

  it("unknown station kind falls back to hand-work reasons", () => {
    const values = getPauseReasonsForStation("UNKNOWN_KIND").map((r) => r.value);
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("machine_jam");
    expect(values).toContain("shift_end");
  });

  it("all reason labels are non-empty strings", () => {
    for (const kind of ALL_KINDS) {
      for (const r of getPauseReasonsForStation(kind)) {
        expect(r.label.length, `${kind}:${r.value}`).toBeGreaterThan(0);
      }
    }
  });
});
