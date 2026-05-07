// Phase H.x3 — Output reconciliation between stages.
//
// Given a workflow_bag, derive what arrived at each stage:
//   • gross_blister_output    — sum(BLISTER_COMPLETE.machine_count)
//   • sealed_output           — sum(SEALING_COMPLETE.machine_count)
//                                OR sum(BOTTLE_CAP_SEAL_COMPLETE.machine_count)
//   • packaged_output         — sum(PACKAGING_COMPLETE counts)
//   • finished_output         — finalized lots tied to this bag
//   • known_damage            — sum(PACKAGING_DAMAGE_RETURN payload counts)
//   • known_rework            — sum(rework events; placeholder until
//                                event taxonomy lands)
//
// Loss layers:
//   • gross_to_sealed_loss           = gross - sealed
//   • sealed_to_packaged_loss        = sealed - packaged - known_damage - known_rework
//   • gross_to_finished_loss         = gross - finished_output
//   • unknown_variance               = gross - finished - known_damage - known_rework
//
// Honest rules:
//   • If a stage has no event, that stage's count is null (NOT zero).
//     Helpers return missing() in that case so the UI surfaces
//     "No sealing output recorded" instead of 0.
//   • Loss is never reported when either side of the subtraction is
//     missing — the operation produces no number at all.
//   • Labels are explicit. "Unknown variance" is never relabeled as
//     "spoilage" or "scrap" — those labels require additional events.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { combineConfidence, missing, ok, partial } from "./confidence";
import type { Confidence, MetricResult } from "./types";

// ─── Pure subtraction helpers (tested in isolation) ──────────────

/** a - b, with null propagation. If either input is null/undefined,
 *  the result is null — never silently substituted with 0. */
export function subtractOrNull(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a == null || b == null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a - b;
}

/** a - (b + c + ...). All addends must be present. Use 0 in the
 *  caller only when you positively know the value is zero (e.g.
 *  "no damage events found" but counter does exist). */
export function subtractAllOrNull(
  a: number | null | undefined,
  toSubtract: ReadonlyArray<number | null | undefined>,
): number | null {
  if (a == null) return null;
  let sum = 0;
  for (const x of toSubtract) {
    if (x == null) return null;
    if (!Number.isFinite(x)) return null;
    sum += x;
  }
  return a - sum;
}

/** Yield ratio with null propagation and divide-by-zero guard. */
export function yieldRatioOrNull(
  output: number | null | undefined,
  input: number | null | undefined,
): number | null {
  if (output == null || input == null) return null;
  if (!Number.isFinite(output) || !Number.isFinite(input)) return null;
  if (input <= 0) return null;
  return output / input;
}

// ─── DB-backed derivations ──────────────────────────────────────

export type StageOutput = {
  bagId: string;
  grossBlisters: number | null;
  sealedOutput: number | null;
  packagedOutput: number | null;
  finishedOutput: number | null;
  knownDamage: number | null;
  knownRework: number | null;
  /** Per-stage missing-input flags so the UI can render exactly
   *  which stage didn't post an event. */
  missingStages: ReadonlyArray<"BLISTER" | "SEALING" | "PACKAGING" | "FINISHED">;
};

export async function deriveStageOutputForBag(bagId: string): Promise<StageOutput> {
  type Row = {
    gross_blisters: number | null;
    sealed: number | null;
    packaged: number | null;
    finished: number | null;
    known_damage: number | null;
    known_rework: number | null;
  };
  const rows = await db.execute<Row>(sql`
    WITH events AS (
      SELECT event_type::text AS event_type, payload, occurred_at
      FROM workflow_events
      WHERE workflow_bag_id = ${bagId}
    )
    SELECT
      (SELECT SUM(NULLIF((payload->>'machine_count'),'')::int)::int
         FROM events WHERE event_type = 'BLISTER_COMPLETE') AS gross_blisters,
      -- Sealed output = SEALING_COMPLETE for cards OR
      --                 BOTTLE_CAP_SEAL_COMPLETE for bottles.
      (SELECT SUM(
                COALESCE(NULLIF((payload->>'machine_count'),'')::int,
                         NULLIF((payload->>'units_count'),'')::int,
                         NULLIF((payload->>'count'),'')::int))::int
         FROM events
         WHERE event_type IN ('SEALING_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE')) AS sealed,
      -- Packaged output = PACKAGING_COMPLETE counts. Multiple keys
      -- because legacy + new code both write here.
      (SELECT SUM(
                COALESCE(NULLIF((payload->>'units_packaged'),'')::int,
                         NULLIF((payload->>'cards_packaged'),'')::int,
                         NULLIF((payload->>'bottles_packaged'),'')::int,
                         NULLIF((payload->>'count'),'')::int))::int
         FROM events
         WHERE event_type IN ('PACKAGING_COMPLETE','PACKAGING_SNAPSHOT','BOTTLE_STICKER_COMPLETE')) AS packaged,
      -- Damage and rework — current model: PACKAGING_DAMAGE_RETURN and
      -- BAG_PAUSED with reason='REWORK'. Placeholder, refined later.
      (SELECT SUM(
                COALESCE(NULLIF((payload->>'damaged_count'),'')::int,
                         NULLIF((payload->>'count'),'')::int))::int
         FROM events
         WHERE event_type = 'PACKAGING_DAMAGE_RETURN') AS known_damage,
      (SELECT SUM(NULLIF((payload->>'rework_count'),'')::int)::int
         FROM events
         WHERE event_type = 'BAG_PAUSED'
           AND (payload->>'reason') = 'REWORK') AS known_rework,
      -- Finished from finished_lots tied to this bag via
      -- finished_lot_inputs.
      (SELECT SUM(fl.units_finished)::int
         FROM finished_lots fl
         JOIN finished_lot_inputs fli ON fli.finished_lot_id = fl.id
         WHERE fli.workflow_bag_id = ${bagId}) AS finished
  `);
  const r = (rows as unknown as Row[])[0] ?? {
    gross_blisters: null,
    sealed: null,
    packaged: null,
    finished: null,
    known_damage: null,
    known_rework: null,
  };

  const missingStages: Array<"BLISTER" | "SEALING" | "PACKAGING" | "FINISHED"> = [];
  if (r.gross_blisters == null) missingStages.push("BLISTER");
  if (r.sealed == null) missingStages.push("SEALING");
  if (r.packaged == null) missingStages.push("PACKAGING");
  if (r.finished == null) missingStages.push("FINISHED");

  return {
    bagId,
    grossBlisters: r.gross_blisters,
    sealedOutput: r.sealed,
    packagedOutput: r.packaged,
    finishedOutput: r.finished,
    knownDamage: r.known_damage,
    knownRework: r.known_rework,
    missingStages,
  };
}

export async function deriveBlisterToSealingYield(bagId: string): Promise<MetricResult> {
  const s = await deriveStageOutputForBag(bagId);
  if (s.grossBlisters == null) {
    return missing("ratio", ["blister_counter"], "No blister counter — cannot compute yield");
  }
  if (s.sealedOutput == null) {
    return missing("ratio", ["sealing_counter"], "No sealing output recorded");
  }
  const ratio = yieldRatioOrNull(s.sealedOutput, s.grossBlisters);
  if (ratio == null) {
    return missing("ratio", ["denominator"], "Cannot compute yield (zero gross output)");
  }
  return ok(ratio, "ratio", {
    explanation: `${s.sealedOutput} sealed / ${s.grossBlisters} gross blisters.`,
  });
}

export async function deriveSealingToPackagingYield(bagId: string): Promise<MetricResult> {
  const s = await deriveStageOutputForBag(bagId);
  if (s.sealedOutput == null) {
    return missing("ratio", ["sealing_counter"], "No sealing output recorded");
  }
  if (s.packagedOutput == null) {
    return missing("ratio", ["packaging_counter"], "No packaging output recorded");
  }
  const ratio = yieldRatioOrNull(s.packagedOutput, s.sealedOutput);
  if (ratio == null) {
    return missing("ratio", ["denominator"], "Cannot compute yield (zero sealed output)");
  }
  return ok(ratio, "ratio", {
    explanation: `${s.packagedOutput} packaged / ${s.sealedOutput} sealed.`,
  });
}

export async function deriveGrossToFinishedYield(bagId: string): Promise<MetricResult> {
  const s = await deriveStageOutputForBag(bagId);
  if (s.grossBlisters == null) {
    return missing("ratio", ["blister_counter"], "No blister counter — cannot compute yield");
  }
  if (s.finishedOutput == null) {
    return missing("ratio", ["finished_lot"], "No finished lot — bag not yet released");
  }
  const ratio = yieldRatioOrNull(s.finishedOutput, s.grossBlisters);
  if (ratio == null) {
    return missing("ratio", ["denominator"], "Cannot compute yield (zero gross output)");
  }
  return ok(ratio, "ratio", {
    explanation: `${s.finishedOutput} finished / ${s.grossBlisters} gross blisters.`,
  });
}

export type Reconciliation = {
  bagId: string;
  grossBlisters: MetricResult;
  sealedOutput: MetricResult;
  packagedOutput: MetricResult;
  finishedOutput: MetricResult;
  knownDamage: MetricResult;
  knownRework: MetricResult;
  /** Loss between blister and sealing stages. */
  grossToSealedLoss: MetricResult;
  sealedToPackagedLoss: MetricResult;
  grossToFinishedLoss: MetricResult;
  /** unknownVariance = gross - finished - damage - rework. */
  unknownVariance: MetricResult;
  /** Worst-of confidence across all components that returned a value. */
  combinedConfidence: Confidence;
};

const NA_LABEL = "Stage missing";

function asMetric(value: number | null, unit: string, missingInput: string, label: string): MetricResult {
  return value != null ? ok(value, unit) : missing(unit, [missingInput], label);
}

export async function deriveOutputReconciliationForBag(
  bagId: string,
): Promise<Reconciliation> {
  const s = await deriveStageOutputForBag(bagId);

  const gross = asMetric(s.grossBlisters, "blisters", "blister_counter", "No blister counter");
  const sealed = asMetric(s.sealedOutput, "units", "sealing_counter", "No sealing output recorded");
  const packaged = asMetric(s.packagedOutput, "units", "packaging_counter", "No packaging output recorded");
  const finished = asMetric(s.finishedOutput, "units", "finished_lot", "No finished lot — bag not yet released");
  const damage = asMetric(s.knownDamage ?? 0, "units", "damage_event", NA_LABEL);
  const rework = asMetric(s.knownRework ?? 0, "units", "rework_event", NA_LABEL);

  const grossToSealedLossNum = subtractOrNull(s.grossBlisters, s.sealedOutput);
  const sealedToPackagedLossNum = subtractAllOrNull(s.sealedOutput, [
    s.packagedOutput,
    s.knownDamage ?? 0,
    s.knownRework ?? 0,
  ]);
  const grossToFinishedLossNum = subtractOrNull(s.grossBlisters, s.finishedOutput);
  const unknownVarianceNum = subtractAllOrNull(s.grossBlisters, [
    s.finishedOutput,
    s.knownDamage ?? 0,
    s.knownRework ?? 0,
  ]);

  const grossToSealedLoss =
    grossToSealedLossNum != null
      ? partial(grossToSealedLossNum, "units", {
          missingInputs: [],
          explanation: "Gross blisters minus sealed output. Includes process loss + counter mismatch.",
        })
      : missing("units", ["blister_counter", "sealing_counter"], "Cannot compute (stage missing)");

  const sealedToPackagedLoss =
    sealedToPackagedLossNum != null
      ? partial(sealedToPackagedLossNum, "units", {
          missingInputs: [],
          explanation: "Sealed minus packaged minus known damage minus known rework. Residual = process loss + counter mismatch.",
        })
      : missing("units", ["sealing_counter", "packaging_counter"], "Cannot compute (stage missing)");

  const grossToFinishedLoss =
    grossToFinishedLossNum != null
      ? partial(grossToFinishedLossNum, "units", {
          missingInputs: [],
          explanation: "Gross blisters minus finished output across all loss types.",
        })
      : missing("units", ["blister_counter", "finished_lot"], "Cannot compute (stage missing)");

  const unknownVariance =
    unknownVarianceNum != null
      ? partial(unknownVarianceNum, "units", {
          missingInputs: [],
          explanation:
            "Gross minus finished minus known damage minus known rework. Anything in here is unaccounted-for variance — investigate.",
        })
      : missing("units", ["blister_counter", "finished_lot"], "Cannot compute (stage missing)");

  const combinedConfidence = combineConfidence([
    gross.confidence,
    sealed.confidence,
    packaged.confidence,
    finished.confidence,
  ]);

  return {
    bagId,
    grossBlisters: gross,
    sealedOutput: sealed,
    packagedOutput: packaged,
    finishedOutput: finished,
    knownDamage: damage,
    knownRework: rework,
    grossToSealedLoss,
    sealedToPackagedLoss,
    grossToFinishedLoss,
    unknownVariance,
    combinedConfidence,
  };
}

/** Convenience — return only the unknown-variance component. */
export async function deriveUnknownLoss(bagId: string): Promise<MetricResult> {
  const r = await deriveOutputReconciliationForBag(bagId);
  return r.unknownVariance;
}
