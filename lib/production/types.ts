// Canonical metric result shape — every metric the API returns
// flows through this type so the UI never has to invent its own
// missing-data discipline. The contract is in the file header so
// future contributors can grep for it.
//
// Rules (locked):
//   • Every metric — scalar or aggregate — embeds a confidence tag.
//   • Missing data is honest: confidence "MISSING" + missingInputs
//     listing what the caller failed to supply.
//   • A metric never claims a value when its inputs aren't met.
//   • OEE-family metrics never display above 100%.
//   • Aggregations (Dashboard, Genealogy, etc.) return a Bundle —
//     a record of MetricResults — not a single MetricResult.

import type { BlisterBagCounterSegment } from "./blister-bag-counter-segments";

/** Confidence ladder from highest to lowest. MISSING means we
 *  refused to compute because of an empty/unconfigured input. */
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING";

/** The canonical scalar metric envelope. Aggregator functions
 *  return a `MetricBundle` (Record<string, MetricResult>) so each
 *  KPI in the bundle still carries its own confidence tag. */
export interface MetricResult {
  /** Numeric value, formatted text (e.g. "3h 12m"), or null when
   *  confidence is MISSING. */
  value: number | string | null;
  /** "%", "min", "sec", "units", "displays", "cases", "bottles",
   *  "bags", "tablets", "USD/case", null. Null is allowed for
   *  status-string metrics like a queue's status code. */
  unit: string | null;
  confidence: Confidence;
  /** Names of inputs that were missing or unconfigured. Empty
   *  array when confidence is HIGH. The UI shows this verbatim. */
  missingInputs: string[];
  /** Optional short user-facing label override (e.g.
   *  "Insufficient data for OEE"). The UI prefers this over the
   *  default per-metric copy when present. */
  label?: string;
  /** Optional one-line free text giving rationale (e.g. "based on
   *  3 of 5 expected scans"). Don't put numbers here that should
   *  flow as their own metric. */
  explanation?: string;
}

/** A bundle of metrics returned by aggregator functions. Each
 *  property is a separate metric with its own confidence tag. */
export type MetricBundle = Record<string, MetricResult>;

/** Inclusive-from / exclusive-to date range — same convention as
 *  SQL `[from, to)`. Callers compose using the helpers in
 *  lib/production/time.ts so timezone arithmetic lives in one place. */
export interface DateRange {
  from: Date;
  to: Date;
}

/** Filters accepted by aggregator-style functions. All optional;
 *  combine as AND. */
export interface MetricFilters {
  productId?: string;
  machineId?: string;
  stationId?: string;
  /** "CARD" or "BOTTLE" — high-level production route. */
  route?: "CARD" | "BOTTLE";
  /** Operator code (4-digit or scanned employee QR). */
  operatorCode?: string;
}

// ─── Genealogy ────────────────────────────────────────────────────

/** A single workflow event in chronological order. Reads straight
 *  off workflow_events; no derivation. The metric layer enriches
 *  with station/machine/employee names to spare the UI a join. */
export interface GenealogyEvent {
  eventId: string;
  /** Unix-second sequence the UI uses for stable ordering — stable
   *  even when several events share occurredAt to the millisecond. */
  sequence: number;
  occurredAt: Date;
  eventType: string;
  payload: unknown;
  stationId: string | null;
  stationLabel: string | null;
  machineId: string | null;
  machineName: string | null;
  machineKind: string | null;
  employeeId: string | null;
  employeeName: string | null;
  userId: string | null;
  /** Free-text payload field promoted to top level when present
   *  (notes, reason, counter values). The UI displays without
   *  re-parsing. */
  notes: string | null;
}

/** Result of `deriveBagGenealogy`. Not strictly a MetricResult —
 *  it's a list — but it carries the same confidence vocabulary so
 *  callers can render the same "missing inputs" UI. */
export interface BagGenealogyResult {
  bagId: string;
  events: GenealogyEvent[];
  /** PVC machine-counter segments (roll change, bag complete, etc.).
   *  FOIL is omitted — it mirrors PVC and would double-count. */
  blisterCounterSegments: BlisterBagCounterSegment[];
  /** Quick summary numbers the UI can show next to the timeline. */
  summary: {
    eventCount: MetricResult;
    firstEventAt: MetricResult;
    lastEventAt: MetricResult;
    spanMinutes: MetricResult;
    distinctStations: MetricResult;
  };
  confidence: Confidence;
  missingInputs: string[];
}

// ─── Bottleneck ───────────────────────────────────────────────────

/** Bottleneck identification — points at the stage that's slowing
 *  the line, with a reason. The reason chain stops at the first
 *  signal that has HIGH confidence, so a stage with no standard
 *  but a long queue still gets flagged via queue age. */
export interface BottleneckResult {
  stageKey: MetricResult;        // value: stage key string, or null+MISSING
  reason: MetricResult;          // value: one of QUEUE_AGE | WIP | CYCLE_OVER_STANDARD
  oldestAgeMinutes: MetricResult;
  wip: MetricResult;
  cycleVsStandardPct: MetricResult;
}

// ─── Constants ────────────────────────────────────────────────────

/** Stage keys used by readQueueState + the metric API. Stable
 *  string IDs the UI maps to localized labels. */
export const STAGE_KEYS = [
  "BLISTER_QUEUE",
  "POST_BLISTER_STAGING",
  "SEALING_QUEUE",
  "POST_SEAL_STAGING",
  "PACKAGING_QUEUE",
  "BOTTLE_FILL_QUEUE",
  "BOTTLE_STICKER_QUEUE",
  "BOTTLE_INDUCTION_QUEUE",
  "FINISHED_GOODS_QUEUE",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** Routes — used by deriveRouteMetrics. */
export const ROUTES = ["CARD", "BOTTLE"] as const;
export type Route = (typeof ROUTES)[number];

/** Output unit lexicon. Mirrors station_standards.output_unit and
 *  due_targets.target_unit. */
export const OUTPUT_UNITS = [
  "BAG",
  "DISPLAY",
  "CASE",
  "TABLET",
  "BOTTLE",
  "CARD",
] as const;
export type OutputUnit = (typeof OUTPUT_UNITS)[number];
