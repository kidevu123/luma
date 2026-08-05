import { describe, it, expect } from "vitest";
import {
  deriveSystemRemainingFromOutput,
  pickDeepestOutput,
  labelSystemDerivedStage,
  SYSTEM_DERIVED_SOURCE,
  type SystemDerivedInput,
  pickFinalizedOutput,
} from "./system-derived-allocation";

const base: SystemDerivedInput = {
  sessionStatus: "OPEN",
  openSessionCount: 1,
  startingBalanceQty: 20000,
  tabletsPerUnit: 4,
  outputUnits: 3000, // sealed cards
  outputStage: "SEALING",
};

describe("deriveSystemRemainingFromOutput — happy path", () => {
  it("derives consumed and remaining from output × tabletsPerUnit", () => {
    const r = deriveSystemRemainingFromOutput(base);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.derivedConsumedTablets).toBe(12000); // 3000 * 4
      expect(r.derivedRemainingTablets).toBe(8000); // 20000 - 12000
      expect(r.startingTabletCount).toBe(20000);
      expect(r.outputStage).toBe("SEALING");
    }
  });

  it("remaining exactly 0 is eligible (bag fully consumed → depletes on close)", () => {
    const r = deriveSystemRemainingFromOutput({
      ...base,
      startingBalanceQty: 12000,
    });
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.derivedRemainingTablets).toBe(0);
  });

  it("rounds a fractional derived consumption", () => {
    const r = deriveSystemRemainingFromOutput({
      ...base,
      outputUnits: 2501,
      tabletsPerUnit: 3,
    });
    if (r.eligible) expect(r.derivedConsumedTablets).toBe(7503);
  });
});

describe("deriveSystemRemainingFromOutput — must NOT auto-resolve", () => {
  it("session already closed/depleted/returned", () => {
    for (const s of ["CLOSED", "DEPLETED", "RETURNED_TO_STOCK", "VOIDED"]) {
      const r = deriveSystemRemainingFromOutput({ ...base, sessionStatus: s });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.reason).toBe("SESSION_NOT_OPEN");
    }
  });

  it("multiple open sessions on the same bag", () => {
    const r = deriveSystemRemainingFromOutput({ ...base, openSessionCount: 2 });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("MULTIPLE_OPEN_SESSIONS");
  });

  it("starting count unknown (null / <= 0)", () => {
    for (const q of [null, 0, -1]) {
      const r = deriveSystemRemainingFromOutput({ ...base, startingBalanceQty: q });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.reason).toBe("STARTING_COUNT_UNKNOWN");
    }
  });

  it("missing production output counts", () => {
    for (const u of [null, 0]) {
      const r = deriveSystemRemainingFromOutput({
        ...base,
        outputUnits: u,
        outputStage: u == null ? null : base.outputStage,
      });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.reason).toBe("MISSING_OUTPUT_COUNTS");
    }
  });

  it("ambiguous conversion — no tablets-per-unit (e.g. variety pack)", () => {
    for (const t of [null, 0]) {
      const r = deriveSystemRemainingFromOutput({ ...base, tabletsPerUnit: t });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.reason).toBe("MISSING_TABLETS_PER_UNIT");
    }
  });

  it("calculated consumed exceeds starting → negative remaining", () => {
    const r = deriveSystemRemainingFromOutput({
      ...base,
      outputUnits: 6000, // 6000 * 4 = 24000 > 20000
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toBe("NEGATIVE_REMAINING");
      expect(r.message).toMatch(/exceeds the starting count/i);
    }
  });
});

describe("pickDeepestOutput — deepest recorded stage wins", () => {
  it("prefers finished > packaging > sealing", () => {
    expect(
      pickDeepestOutput({ finishedOutput: 10, packagedOutput: 20, sealedOutput: 30 }),
    ).toEqual({ units: 10, stage: "FINISHED" });
    expect(
      pickDeepestOutput({ finishedOutput: null, packagedOutput: 20, sealedOutput: 30 }),
    ).toEqual({ units: 20, stage: "PACKAGING" });
    expect(
      pickDeepestOutput({ finishedOutput: null, packagedOutput: null, sealedOutput: 30 }),
    ).toEqual({ units: 30, stage: "SEALING" });
  });

  it("returns null when nothing usable (blister-only / all null / zero)", () => {
    expect(
      pickDeepestOutput({ finishedOutput: null, packagedOutput: null, sealedOutput: null }),
    ).toBeNull();
    expect(
      pickDeepestOutput({ finishedOutput: 0, packagedOutput: 0, sealedOutput: 0 }),
    ).toBeNull();
  });
});

// Bug A tests — finalized count derivation.
describe("pickFinalizedOutput — prefer finalized packaging counts over stage-segment sums (Bug A)", () => {
  it(
    "bag 1890-29: 4906 units × 4 tabletsPerUnit = 19624 tablets → remaining 376 of 20000 (not phantom 14288)",
    () => {
      // Real bug: sealing segments only summed 1428 units → consumed 5712 → remaining 14288 (phantom).
      // Fix: use finalized counts → 4906 units → consumed 19624 → remaining 376 (correct).
      const result = pickFinalizedOutput({
        isFinalized: true,
        masterCases: 49,
        displaysMade: 0,
        looseCards: 6,
        unitsPerDisplay: 10,
        displaysPerCase: 10,
      });
      expect(result).not.toBeNull();
      expect(result?.units).toBe(4906); // 49 × 10 × 10 + 0 × 10 + 6
      expect(result?.stage).toBe("PACKAGING");
    },
  );

  it("returns null when not finalized (fall through to stage-segment path)", () => {
    const result = pickFinalizedOutput({
      isFinalized: false,
      masterCases: 49,
      displaysMade: 0,
      looseCards: 6,
      unitsPerDisplay: 10,
      displaysPerCase: 10,
    });
    expect(result).toBeNull();
  });

  it("returns null when packaging structure is incomplete (no unitsPerDisplay)", () => {
    const result = pickFinalizedOutput({
      isFinalized: true,
      masterCases: 10,
      displaysMade: 5,
      looseCards: 2,
      unitsPerDisplay: null,
      displaysPerCase: 10,
    });
    expect(result).toBeNull();
  });

  it("returns null when packaging structure is incomplete (no displaysPerCase)", () => {
    const result = pickFinalizedOutput({
      isFinalized: true,
      masterCases: 10,
      displaysMade: 5,
      looseCards: 2,
      unitsPerDisplay: 10,
      displaysPerCase: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when finalized but zero units produced (no data to derive from)", () => {
    const result = pickFinalizedOutput({
      isFinalized: true,
      masterCases: 0,
      displaysMade: 0,
      looseCards: 0,
      unitsPerDisplay: 10,
      displaysPerCase: 10,
    });
    expect(result).toBeNull();
  });
});

describe("labels", () => {
  it("source constant is the honest, non-physical-count label", () => {
    expect(SYSTEM_DERIVED_SOURCE).toBe("SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT");
  });
  it("stage labels are human-readable", () => {
    expect(labelSystemDerivedStage("SEALING")).toMatch(/sealing/);
    expect(labelSystemDerivedStage("PACKAGING")).toMatch(/packaging/);
    expect(labelSystemDerivedStage("FINISHED")).toMatch(/finished/);
  });
});
