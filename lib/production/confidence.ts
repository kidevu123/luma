// MetricResult constructors. Every metric in lib/production/metrics.ts
// goes through one of these helpers — there's no manual struct
// literal in the metric code, so the shape stays consistent.

import type { Confidence, MetricResult } from "./types";

/** A real measurement with all inputs present. */
export function ok(
  value: number | string,
  unit: string | null,
  opts: { explanation?: string; confidence?: Confidence } = {},
): MetricResult {
  const m: MetricResult = {
    value,
    unit,
    confidence: opts.confidence ?? "HIGH",
    missingInputs: [],
  };
  if (opts.explanation !== undefined) m.explanation = opts.explanation;
  return m;
}

/** A measurement we're computing but flagging as estimated — for
 *  example, material reconciliation against legacy/imported data. */
export function estimated(
  value: number | string,
  unit: string | null,
  opts: { explanation?: string; missingInputs?: string[] } = {},
): MetricResult {
  const m: MetricResult = {
    value,
    unit,
    confidence: "LOW",
    missingInputs: opts.missingInputs ?? [],
  };
  if (opts.explanation !== undefined) m.explanation = opts.explanation;
  return m;
}

/** A measurement based on incomplete data — fewer than expected
 *  inputs, but enough to compute meaningfully. */
export function partial(
  value: number | string,
  unit: string | null,
  opts: { explanation?: string; missingInputs: string[] },
): MetricResult {
  const m: MetricResult = {
    value,
    unit,
    confidence: "MEDIUM",
    missingInputs: opts.missingInputs,
  };
  if (opts.explanation !== undefined) m.explanation = opts.explanation;
  return m;
}

/** Refuse to compute — a required input is missing. The UI
 *  renders the label as the canonical empty-state copy. */
export function missing(
  unit: string | null,
  missingInputs: string[],
  label: string,
  explanation?: string,
): MetricResult {
  const m: MetricResult = {
    value: null,
    unit,
    confidence: "MISSING",
    missingInputs,
    label,
  };
  if (explanation !== undefined) m.explanation = explanation;
  return m;
}

/** Convenience for the common "no data captured today" case where
 *  zero is the honest answer (not missing). */
export function zero(unit: string, explanation?: string): MetricResult {
  return ok(0, unit, explanation !== undefined ? { explanation } : {});
}

/** Worst-of confidence — if any sub-metric is MISSING, the
 *  composite is MISSING; otherwise lowest available rank wins.
 *  Useful when an aggregator needs a single rollup status. */
export function combineConfidence(
  parts: ReadonlyArray<Confidence>,
): Confidence {
  const rank: Record<Confidence, number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
    MISSING: 3,
  };
  let worst: Confidence = "HIGH";
  for (const p of parts) {
    if (rank[p] > rank[worst]) worst = p;
  }
  return worst;
}

/** Clamp a percentage 0–100. OEE-family metrics use this — true
 *  OEE never exceeds 100; a value over 100 means the input data
 *  is inconsistent (counter typo, bad standard, clock drift) and
 *  must surface as a warning, never as the headline number. */
export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
