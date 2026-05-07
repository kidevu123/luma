// Phase H.x3 — Material learning derivations.
//
// Three layers:
//   1. Pure math helpers — exact arithmetic for "given starting,
//      ending, blister count, what is grams/blister?" Tested in
//      isolation in material-learning.test.ts.
//   2. DB-backed derive functions — read configured / learned
//      standards, return MetricResult. Used by the projector hook.
//   3. resolveMaterialStandard — the canonical "configured → learned
//      → fallback → missing" priority chain that H.x3 calls.
//
// Honest-data discipline applies. No fake numbers. Every helper
// returns a MetricResult with confidence + missingInputs. When
// neither configured nor learned data exists, the result is missing
// with the canonical label "Roll usage standard missing."

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  blisterMaterialStandards,
  materialInventoryEvents,
  packagingLots,
  readMaterialUsageLearning,
} from "@/lib/db/schema";
import { combineConfidence, missing, ok, partial } from "./confidence";
import type { Confidence, MetricResult } from "./types";

// ─── Pure helpers (tested in isolation) ────────────────────────────

/** Compute grams used by subtracting ending from starting weight.
 *  Returns null if either is missing or starting < ending (a
 *  bookkeeping error — surface to caller, do not silently fix). */
export function computeActualWeightUsed(
  startingGrams: number | null | undefined,
  endingGrams: number | null | undefined,
): number | null {
  if (startingGrams == null || endingGrams == null) return null;
  if (!Number.isFinite(startingGrams) || !Number.isFinite(endingGrams)) return null;
  if (startingGrams < endingGrams) return null;
  const used = startingGrams - endingGrams;
  return used >= 0 ? used : null;
}

/** Empirical grams per blister = used grams ÷ blisters produced.
 *  Returns null on missing or non-positive blister counts. */
export function computeEmpiricalGramsPerBlister(
  usedGrams: number | null | undefined,
  blistersProduced: number | null | undefined,
): number | null {
  if (usedGrams == null || blistersProduced == null) return null;
  if (!Number.isFinite(usedGrams) || !Number.isFinite(blistersProduced)) return null;
  if (blistersProduced <= 0) return null;
  if (usedGrams < 0) return null;
  return usedGrams / blistersProduced;
}

/** Confidence ladder for the *learned* standard, based on how many
 *  weighed-back rolls have been observed. */
export function learnedConfidenceFromSampleCount(n: number): Confidence {
  if (!Number.isFinite(n) || n <= 0) return "MISSING";
  if (n >= 5) return "HIGH";
  if (n >= 2) return "MEDIUM";
  return "LOW";
}

/** Outlier filter — Tukey-style 1.5 × IQR. Used by callers that want
 *  to compute a robust mean from a list of empirical samples without
 *  letting one bad weigh-back poison the average. The rebuilder
 *  itself stores raw averages + p90 to keep the math transparent;
 *  this helper exists for derive functions that want a cleaner mean. */
export function filterOutliersIQR(samples: ReadonlyArray<number>): number[] {
  if (samples.length < 4) return [...samples];
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo]!;
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter((v) => v >= lo && v <= hi);
}

// ─── DB-backed derive* functions ──────────────────────────────────

/** Compute empirical usage for a single roll lot. HIGH confidence
 *  when both starting and ending weight are present and a positive
 *  blister count was observed during the mount window. MISSING
 *  otherwise. */
export async function deriveEmpiricalRollUsage(
  materialLotId: string,
): Promise<MetricResult> {
  if (!materialLotId) {
    return missing(null, ["material_lot_id"], "Material lot not specified");
  }
  type Row = {
    starting_grams: number | null;
    ending_grams: number | null;
    blisters: number | null;
    mounted_at: string | null;
  };
  const rows = await db.execute<Row>(sql`
    WITH mount AS (
      SELECT ev.machine_id, ev.occurred_at, ev.payload
      FROM material_inventory_events ev
      WHERE ev.packaging_lot_id = ${materialLotId}
        AND ev.event_type = 'ROLL_MOUNTED'
      ORDER BY ev.occurred_at DESC, ev.id DESC
      LIMIT 1
    ),
    weighed AS (
      SELECT ev.quantity_grams, ev.occurred_at
      FROM material_inventory_events ev
      WHERE ev.packaging_lot_id = ${materialLotId}
        AND ev.event_type IN ('ROLL_WEIGHED','ROLL_UNMOUNTED')
        AND ev.quantity_grams IS NOT NULL
      ORDER BY ev.occurred_at DESC, ev.id DESC
      LIMIT 1
    ),
    blister_count AS (
      SELECT SUM(NULLIF((we.payload->>'machine_count'),'')::int)::bigint AS total_blisters
      FROM workflow_events we
      JOIN stations s ON s.id = we.station_id
      WHERE we.event_type::text = 'BLISTER_COMPLETE'
        AND s.machine_id = (SELECT machine_id FROM mount)
        AND we.occurred_at >= (SELECT occurred_at FROM mount)
        AND ((SELECT occurred_at FROM weighed) IS NULL
             OR we.occurred_at <= (SELECT occurred_at FROM weighed))
    )
    SELECT
      COALESCE(
        NULLIF(((SELECT payload FROM mount)->>'starting_weight_grams'),'')::int,
        rl.net_weight_grams
      ) AS starting_grams,
      (SELECT quantity_grams FROM weighed) AS ending_grams,
      (SELECT total_blisters FROM blister_count)::int AS blisters,
      (SELECT occurred_at FROM mount)::text AS mounted_at
    FROM packaging_lots rl
    WHERE rl.id = ${materialLotId}
  `);
  const list = rows as unknown as Row[];
  const r = list[0];
  if (!r) return missing(null, ["material_lot"], "Roll lot not found");

  const used = computeActualWeightUsed(r.starting_grams, r.ending_grams);
  const gramsPerBlister = computeEmpiricalGramsPerBlister(used, r.blisters);

  if (used == null) {
    return missing(
      "g",
      r.ending_grams == null ? ["weigh_back"] : ["starting_weight"],
      r.ending_grams == null ? "Roll not weighed back" : "Roll has no recorded starting weight",
    );
  }
  if (gramsPerBlister == null) {
    return missing("g/blister", ["blister_counter"], "No blister counter — cannot derive empirical usage");
  }
  return ok(gramsPerBlister, "g/blister", {
    confidence: "HIGH",
    explanation: `Used ${used} g over ${r.blisters} blisters during mount window.`,
  });
}

/** Read the learned standard for a (product, material role) pair.
 *  Falls back through: (product+machine) → (product) → (machine) →
 *  (material+role only). Returns the most-specific row that exists.
 *  Returns missing() when no row matches. */
export async function deriveMaterialUsageLearning(
  productId: string | null,
  packagingMaterialId: string,
  materialRole: "PVC" | "FOIL",
  machineId: string | null,
): Promise<MetricResult & { source?: "LEARNED" }> {
  if (!packagingMaterialId) {
    return missing("g/blister", ["packaging_material_id"], "Material not specified");
  }
  type Row = {
    avg_weight_per_blister: string | null;
    median_weight_per_blister: string | null;
    p90_weight_per_blister: string | null;
    sample_count: number;
    confidence: string;
    last_sample_at: string | null;
  };
  // Try most-specific to least-specific.
  const candidates: Array<{ productId: string | null; machineId: string | null }> = [
    { productId, machineId },
    { productId, machineId: null },
    { productId: null, machineId },
    { productId: null, machineId: null },
  ];
  for (const c of candidates) {
    const rows = await db.execute<Row>(sql`
      SELECT
        avg_weight_per_blister::text       AS avg_weight_per_blister,
        median_weight_per_blister::text    AS median_weight_per_blister,
        p90_weight_per_blister::text       AS p90_weight_per_blister,
        sample_count,
        confidence,
        last_sample_at::text               AS last_sample_at
      FROM read_material_usage_learning
      WHERE packaging_material_id = ${packagingMaterialId}
        AND material_role = ${materialRole}
        AND ${c.productId == null ? sql`product_id IS NULL` : sql`product_id = ${c.productId}`}
        AND ${c.machineId == null ? sql`machine_id IS NULL` : sql`machine_id = ${c.machineId}`}
      LIMIT 1
    `);
    const r = (rows as unknown as Row[])[0];
    if (r && r.sample_count > 0 && r.avg_weight_per_blister != null) {
      const conf =
        r.confidence === "HIGH"
          ? "HIGH"
          : r.confidence === "MEDIUM"
            ? "MEDIUM"
            : "LOW";
      const value = Number(r.avg_weight_per_blister);
      const result: MetricResult & { source?: "LEARNED" } = {
        ...ok(value, "g/blister", {
          confidence: conf,
          explanation: `Learned average from ${r.sample_count} weighed-back roll${r.sample_count === 1 ? "" : "s"}.`,
        }),
        source: "LEARNED",
      };
      return result;
    }
  }
  return missing(
    "g/blister",
    ["read_material_usage_learning"],
    "Learned standard missing",
    "No weighed-back rolls have been recorded for this product/material yet.",
  );
}

export type StandardSource = "CONFIGURED" | "LEARNED" | "MISSING";

export type ResolvedStandard = {
  gramsPerBlister: number | null;
  source: StandardSource;
  confidence: Confidence;
  explanation: string;
  missingInputs: string[];
};

/** The canonical priority chain. CONFIGURED beats LEARNED beats
 *  MISSING. The H.x3 hook calls this once per (product, role, machine)
 *  and uses the result to decide whether to emit a consumption event. */
export async function resolveMaterialStandard(input: {
  productId: string | null;
  packagingMaterialId: string;
  materialRole: "PVC" | "FOIL";
  machineId: string | null;
}): Promise<ResolvedStandard> {
  // Step 1 — configured.
  if (input.productId) {
    const rows = await db
      .select({
        gramsPerBlister: blisterMaterialStandards.expectedGramsPerBlister,
        blistersPerKg: blisterMaterialStandards.expectedBlistersPerKg,
      })
      .from(blisterMaterialStandards)
      .where(
        and(
          eq(blisterMaterialStandards.productId, input.productId),
          eq(blisterMaterialStandards.packagingMaterialId, input.packagingMaterialId),
          eq(blisterMaterialStandards.materialRole, input.materialRole),
          eq(blisterMaterialStandards.isActive, true),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (r) {
      const gpb = r.gramsPerBlister != null ? Number(r.gramsPerBlister) : null;
      const fromBlistersPerKg =
        r.blistersPerKg != null && Number(r.blistersPerKg) > 0
          ? 1000 / Number(r.blistersPerKg)
          : null;
      const v = gpb ?? fromBlistersPerKg;
      if (v != null && v > 0) {
        return {
          gramsPerBlister: v,
          source: "CONFIGURED",
          confidence: "HIGH",
          explanation: gpb != null
            ? "Configured grams-per-blister standard."
            : "Configured blisters-per-kg → grams-per-blister.",
          missingInputs: [],
        };
      }
    }
  }
  // Step 2 — learned.
  const learned = await deriveMaterialUsageLearning(
    input.productId,
    input.packagingMaterialId,
    input.materialRole,
    input.machineId,
  );
  if (learned.value != null && typeof learned.value === "number") {
    return {
      gramsPerBlister: learned.value,
      source: "LEARNED",
      confidence: learned.confidence,
      explanation: learned.explanation ?? "Learned average.",
      missingInputs: learned.missingInputs ?? [],
    };
  }
  // Step 3 — neither configured nor learned.
  return {
    gramsPerBlister: null,
    source: "MISSING",
    confidence: "MISSING",
    explanation: "No configured standard and no weighed-back rolls yet.",
    missingInputs: ["blister_material_standards", "read_material_usage_learning"],
  };
}

// ─── Convenience helper used by the H.x3 projector hook ─────────

/** Compute the expected weight for a given gross-blister count given
 *  the resolved standard. Returns 0g when the standard is missing —
 *  the caller decides whether to skip emission entirely. Confidence
 *  is inherited from the standard. */
export function computeExpectedGramsForBlisters(
  blistersProduced: number,
  standard: ResolvedStandard,
): { expectedGrams: number | null; combinedConfidence: Confidence } {
  if (!Number.isFinite(blistersProduced) || blistersProduced <= 0) {
    return { expectedGrams: null, combinedConfidence: "MISSING" };
  }
  if (standard.gramsPerBlister == null) {
    return { expectedGrams: null, combinedConfidence: "MISSING" };
  }
  const expected = blistersProduced * standard.gramsPerBlister;
  // The combined confidence is the worst of the standard's confidence
  // and the counter-driven HIGH (counter is HIGH unless missing).
  const combinedConfidence = combineConfidence([standard.confidence, "HIGH"]);
  return { expectedGrams: Math.round(expected), combinedConfidence };
}

/** Reusable helper: returns an `estimated`-style MetricResult for the
 *  expected consumption of one mounted roll. Used by H.x7 / metric API
 *  when a UI wants the number directly. */
export async function deriveExpectedConsumptionForMountedRoll(input: {
  productId: string | null;
  packagingMaterialId: string;
  materialRole: "PVC" | "FOIL";
  machineId: string | null;
  blistersProduced: number;
}): Promise<MetricResult> {
  const std = await resolveMaterialStandard(input);
  if (std.source === "MISSING" || std.gramsPerBlister == null) {
    return missing("g", std.missingInputs, "Roll usage standard missing");
  }
  const expected = input.blistersProduced * std.gramsPerBlister;
  if (std.confidence === "HIGH") {
    return ok(Math.round(expected), "g", {
      explanation: `${std.explanation} ${input.blistersProduced} blisters × ${std.gramsPerBlister.toFixed(4)} g/blister.`,
    });
  }
  return partial(Math.round(expected), "g", {
    missingInputs: std.missingInputs,
    explanation: `${std.explanation} ${input.blistersProduced} blisters × ${std.gramsPerBlister.toFixed(4)} g/blister.`,
  });
}

// Touch unused imports so tree-shaking does not silently drop them
// (these are referenced in templates / docs).
export const _materialInventoryEventsRef = materialInventoryEvents;
export const _packagingLotsRef = packagingLots;
export const _readMaterialUsageLearningRef = readMaterialUsageLearning;
