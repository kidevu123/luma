// Phase F — pure helpers for legacy yield derivation. Mirrors the
// SQL CASE expression in lib/legacy/read-model-synthesizer.ts so
// vitest can exercise the math without standing up a database.
//
// Honest-data discipline:
//   • If no source field supports a number, return 0 with confidence
//     MISSING. Never invent.
//   • Confidence ladder:
//       HIGH    — directly measured: packaged_tablets_total set
//       MEDIUM  — converted via full product packaging spec
//                 (tabletsPerUnit + unitsPerDisplay + displaysPerCase)
//       LOW     — partial spec (only displays × unitsPerDisplay)
//                 OR bottle conversion via tabletsPerUnit on BOTTLE kind
//       MISSING — no source data + no spec

export interface YieldInputs {
  /** From PACKAGING_COMPLETE/SNAPSHOT payload. The most direct
   *  signal of finished tablets — usually present in "packaged"
   *  legacy submissions. */
  packagedTabletsTotal: number | null;
  cases: number | null;
  displays: number | null;
  looseCards: number | null;
  bottles: number | null;
}

export interface ProductSpec {
  kind: "CARD" | "BOTTLE" | "VARIETY";
  tabletsPerUnit: number | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
}

export interface YieldResult {
  unitsYielded: number;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  reason: string;
}

export function deriveLegacyUnitsYielded(
  inputs: YieldInputs,
  spec: ProductSpec | null,
): YieldResult {
  // 1. HIGH — direct counted output.
  if (inputs.packagedTabletsTotal != null && inputs.packagedTabletsTotal > 0) {
    return {
      unitsYielded: inputs.packagedTabletsTotal,
      confidence: "HIGH",
      reason: "packaged_tablets_total reported directly",
    };
  }

  // No spec → can't convert from cases/displays. Bottle direct
  // conversion happens via tabletsPerUnit even without unitsPerDisplay.
  if (!spec) {
    return {
      unitsYielded: 0,
      confidence: "MISSING",
      reason: "no product spec available for conversion",
    };
  }

  const cases = inputs.cases ?? 0;
  const displays = inputs.displays ?? 0;
  const loose = inputs.looseCards ?? 0;
  const bottles = inputs.bottles ?? 0;
  const tpu = spec.tabletsPerUnit;
  const upd = spec.unitsPerDisplay;
  const dpc = spec.displaysPerCase;

  // 2. MEDIUM — full card spec.
  if (tpu != null && upd != null && dpc != null && (cases > 0 || displays > 0 || loose > 0)) {
    const totalCards = cases * dpc * upd + displays * upd + loose;
    return {
      unitsYielded: totalCards * tpu,
      confidence: "MEDIUM",
      reason: "converted via tablets_per_unit × units_per_display × displays_per_case",
    };
  }

  // 3. LOW — partial spec (no case info).
  if (tpu != null && upd != null && (displays > 0 || loose > 0)) {
    const totalCards = displays * upd + loose;
    return {
      unitsYielded: totalCards * tpu,
      confidence: "LOW",
      reason: "converted via tablets_per_unit × units_per_display only",
    };
  }

  // 4. LOW — bottle conversion.
  if (tpu != null && spec.kind === "BOTTLE" && bottles > 0) {
    return {
      unitsYielded: bottles * tpu,
      confidence: "LOW",
      reason: "bottles × tablets_per_unit",
    };
  }

  return {
    unitsYielded: 0,
    confidence: "MISSING",
    reason:
      "no direct count, no convertible packaging output, or product lacks tablets_per_unit",
  };
}

/** Aggregate distinct machine_ids from a list of (station_id,
 *  machine_id) pairs collected from workflow_events JOIN stations.
 *  Pure helper — the SQL equivalent lives inline in
 *  read-model-synthesizer.ts. */
export function aggregateMachineIds(
  pairs: ReadonlyArray<{ stationId: string | null; machineId: string | null }>,
): string[] {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (p.machineId) seen.add(p.machineId);
  }
  return [...seen].sort();
}
