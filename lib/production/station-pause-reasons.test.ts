import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  getDefaultPauseReasonForStation,
  getPauseReasonsForStation,
  STATION_PAUSE_REASON_MATRIX,
} from "./station-pause-reasons";

const BLISTER_ROLL_KINDS = ["BLISTER", "COMBINED"] as const;
const HAND_KINDS = [
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "PACKAGING",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
] as const;
const ALL_KINDS = [...BLISTER_ROLL_KINDS, "SEALING", ...HAND_KINDS] as const;

describe("STATION-PAUSE-2 · pause reason matrix", () => {
  it("matrix covers every StationKind with non-empty options", () => {
    for (const [kind, options] of Object.entries(STATION_PAUSE_REASON_MATRIX)) {
      expect(options.length, kind).toBeGreaterThan(0);
      expect(getPauseReasonsForStation(kind)).toEqual(options);
    }
  });

  it("blister roll-machine stations include pvc_swap, foil_swap, and machine_jam", () => {
    for (const kind of BLISTER_ROLL_KINDS) {
      const values = getPauseReasonsForStation(kind).map((r) => r.value);
      expect(values, kind).toContain("pvc_swap");
      expect(values, kind).toContain("foil_swap");
      expect(values, kind).toContain("machine_jam");
      expect(values, kind).toEqual([
        "shift_end",
        "pvc_swap",
        "foil_swap",
        "machine_jam",
        "qa_check",
        "other",
      ]);
    }
  });

  it("SEALING has machine_jam but not pvc_swap or foil_swap", () => {
    const values = getPauseReasonsForStation("SEALING").map((r) => r.value);
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("foil_swap");
    expect(values).toContain("machine_jam");
    expect(values).toEqual(["shift_end", "machine_jam", "qa_check", "other"]);
  });

  it("hand-work stations do not include pvc_swap, foil_swap, or machine_jam", () => {
    for (const kind of HAND_KINDS) {
      const values = getPauseReasonsForStation(kind).map((r) => r.value);
      expect(values, kind).not.toContain("pvc_swap");
      expect(values, kind).not.toContain("foil_swap");
      expect(values, kind).not.toContain("machine_jam");
    }
  });

  it("HANDPACK_BLISTER has no pvc_swap, no foil_swap, and no machine_jam", () => {
    const values = getPauseReasonsForStation("HANDPACK_BLISTER").map(
      (r) => r.value,
    );
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("foil_swap");
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

  it("blister roll-machine default is shift_end", () => {
    for (const kind of BLISTER_ROLL_KINDS) {
      expect(getDefaultPauseReasonForStation(kind), kind).toBe("shift_end");
    }
  });

  it("SEALING default is shift_end — not pvc_swap", () => {
    expect(getDefaultPauseReasonForStation("SEALING")).toBe("shift_end");
    expect(getDefaultPauseReasonForStation("SEALING")).not.toBe("pvc_swap");
  });

  it("hand-work default is shift_end via getDefaultPauseReasonForStation", () => {
    for (const kind of HAND_KINDS) {
      expect(getDefaultPauseReasonForStation(kind), kind).toBe("shift_end");
    }
  });

  it("default reason is always included in station options", () => {
    for (const kind of ALL_KINDS) {
      const options = getPauseReasonsForStation(kind).map((r) => r.value);
      expect(options).toContain(getDefaultPauseReasonForStation(kind));
    }
  });

  it("PACKAGING has no pvc_swap", () => {
    const values = getPauseReasonsForStation("PACKAGING").map((r) => r.value);
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("machine_jam");
  });

  it("BOTTLE_HANDPACK has no pvc_swap and no machine_jam", () => {
    const values = getPauseReasonsForStation("BOTTLE_HANDPACK").map(
      (r) => r.value,
    );
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("machine_jam");
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

describe("STATION-SEALING-TOOLS-1 · hard-stop scope", () => {
  it("pause reasons module does not import floor actions or scan form", () => {
    const pauseSrc = readFileSync(join(__dirname, "station-pause-reasons.ts"), "utf8");
    expect(pauseSrc).not.toMatch(/scan-card-form/);
    expect(pauseSrc).not.toMatch(/from.*actions/);
  });
});

describe("MATERIAL-ROLL-CHANGE-UX-1 · roll swap pause reasons remain wired", () => {
  it("BLISTER pause options include pvc_swap and foil_swap", () => {
    const values = getPauseReasonsForStation("BLISTER").map((r) => r.value);
    expect(values).toContain("pvc_swap");
    expect(values).toContain("foil_swap");
  });

  it("COMBINED pause options include pvc_swap and foil_swap", () => {
    const values = getPauseReasonsForStation("COMBINED").map((r) => r.value);
    expect(values).toContain("pvc_swap");
    expect(values).toContain("foil_swap");
  });

  it("SEALING pause options do not include pvc_swap or foil_swap", () => {
    const values = getPauseReasonsForStation("SEALING").map((r) => r.value);
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("foil_swap");
  });

  it("HANDPACK_BLISTER pause options do not include pvc_swap, foil_swap, or machine_jam", () => {
    const values = getPauseReasonsForStation("HANDPACK_BLISTER").map(
      (r) => r.value,
    );
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("foil_swap");
    expect(values).not.toContain("machine_jam");
  });
});

describe("BLISTER-MACHINE-COUNTER-1 · legacy pause schema values (server only)", () => {
  it("pause reasons type still includes pvc_swap and foil_swap for backward compatibility", () => {
    const pauseSrc = readFileSync(join(__dirname, "station-pause-reasons.ts"), "utf8");
    expect(pauseSrc).toMatch(/"pvc_swap"/);
    expect(pauseSrc).toMatch(/"foil_swap"/);
  });
});
