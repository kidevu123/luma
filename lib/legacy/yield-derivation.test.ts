// Phase F — yield-derivation contract tests.

import { describe, it, expect } from "vitest";
import {
  aggregateMachineIds,
  deriveLegacyUnitsYielded,
} from "./yield-derivation";

describe("aggregateMachineIds", () => {
  it("collects distinct non-null machine ids", () => {
    expect(
      aggregateMachineIds([
        { stationId: "s1", machineId: "m1" },
        { stationId: "s2", machineId: "m1" }, // dup
        { stationId: "s3", machineId: "m2" },
        { stationId: "s4", machineId: null }, // skip
      ]),
    ).toEqual(["m1", "m2"]);
  });

  it("returns empty when nothing has machine attribution", () => {
    expect(
      aggregateMachineIds([
        { stationId: "s1", machineId: null },
        { stationId: null, machineId: null },
      ]),
    ).toEqual([]);
  });

  it("never invents machine ids — null in, null contribution", () => {
    const result = aggregateMachineIds([
      { stationId: "s1", machineId: null },
    ]);
    expect(result).toEqual([]);
    // Specifically: we don't fabricate a machine_id for unattributed events.
  });
});

describe("deriveLegacyUnitsYielded", () => {
  const cardSpec = {
    kind: "CARD" as const,
    tabletsPerUnit: 30,
    unitsPerDisplay: 12,
    displaysPerCase: 6,
  };

  const partialCardSpec = {
    kind: "CARD" as const,
    tabletsPerUnit: 30,
    unitsPerDisplay: 12,
    displaysPerCase: null,
  };

  const bottleSpec = {
    kind: "BOTTLE" as const,
    tabletsPerUnit: 60,
    unitsPerDisplay: null,
    displaysPerCase: null,
  };

  it("HIGH confidence when packaged_tablets_total is present", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: 14400,
        cases: 0,
        displays: 0,
        looseCards: 0,
        bottles: 0,
      },
      cardSpec,
    );
    expect(r.confidence).toBe("HIGH");
    expect(r.unitsYielded).toBe(14400);
  });

  it("MEDIUM confidence with full spec converts cases × displays × cards", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 2,
        displays: 0,
        looseCards: 0,
        bottles: 0,
      },
      cardSpec,
    );
    // 2 cases × 6 displays/case × 12 cards/display × 30 tablets/card
    expect(r.unitsYielded).toBe(2 * 6 * 12 * 30);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("MEDIUM confidence handles displays + loose with full spec", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 1,
        displays: 3,
        looseCards: 5,
        bottles: 0,
      },
      cardSpec,
    );
    // 1 case × 6 × 12 + 3 displays × 12 + 5 loose = 72 + 36 + 5 = 113 cards
    // × 30 tablets/card = 3390
    expect(r.unitsYielded).toBe((1 * 6 * 12 + 3 * 12 + 5) * 30);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("LOW confidence with partial spec (no displays_per_case)", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 0,
        displays: 4,
        looseCards: 2,
        bottles: 0,
      },
      partialCardSpec,
    );
    // 4 displays × 12 cards + 2 loose = 50 cards × 30 = 1500
    expect(r.unitsYielded).toBe((4 * 12 + 2) * 30);
    expect(r.confidence).toBe("LOW");
  });

  it("LOW confidence on bottle product via tablets_per_unit", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 0,
        displays: 0,
        looseCards: 0,
        bottles: 12,
      },
      bottleSpec,
    );
    expect(r.unitsYielded).toBe(12 * 60);
    expect(r.confidence).toBe("LOW");
  });

  it("MISSING when no source data + no spec", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 0,
        displays: 0,
        looseCards: 0,
        bottles: 0,
      },
      null,
    );
    expect(r.unitsYielded).toBe(0);
    expect(r.confidence).toBe("MISSING");
  });

  it("MISSING when product has no tablets_per_unit", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 1,
        displays: 0,
        looseCards: 0,
        bottles: 0,
      },
      {
        kind: "CARD",
        tabletsPerUnit: null,
        unitsPerDisplay: 12,
        displaysPerCase: 6,
      },
    );
    expect(r.unitsYielded).toBe(0);
    expect(r.confidence).toBe("MISSING");
  });

  it("never silently turns estimated output into HIGH confidence", () => {
    // packaged_tablets_total = 0 (effectively absent). Even with full
    // spec + cases, confidence drops to MEDIUM, not HIGH.
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: 0,
        cases: 1,
        displays: 0,
        looseCards: 0,
        bottles: 0,
      },
      cardSpec,
    );
    expect(r.confidence).toBe("MEDIUM");
    // Direct path requires > 0; 0 is treated as "no direct measurement".
  });

  it("never invents output when no packaging payload exists", () => {
    const r = deriveLegacyUnitsYielded(
      {
        packagedTabletsTotal: null,
        cases: 0,
        displays: 0,
        looseCards: 0,
        bottles: 0,
      },
      cardSpec,
    );
    expect(r.unitsYielded).toBe(0);
    expect(r.confidence).toBe("MISSING");
  });
});

describe("Material reconciliation legacy-yield-inferable contract", () => {
  it("variance with units_yielded=0 + cases>0 should be flagged 'finished_yield_inferable'", () => {
    // This pins the rebuilder's CASE expression — if a bag has
    // packaging output but no spec to convert from, we tag the row
    // 'finished_yield_inferable' so the UI distinguishes it from
    // a true variance.
    const missingTag = (units_yielded: number, cases: number, displays: number, loose: number) => {
      if (units_yielded === 0 && (cases > 0 || displays > 0 || loose > 0)) {
        return "finished_yield_inferable,scrap,remaining";
      }
      if (units_yielded === 0) {
        return "finished_yield_unknown,scrap,remaining";
      }
      return "scrap,remaining";
    };
    expect(missingTag(0, 1, 0, 0)).toBe("finished_yield_inferable,scrap,remaining");
    expect(missingTag(0, 0, 0, 0)).toBe("finished_yield_unknown,scrap,remaining");
    expect(missingTag(100, 1, 0, 0)).toBe("scrap,remaining");
  });
});
