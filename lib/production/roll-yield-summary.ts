/**
 * Canonical roll yield answers — one place to answer:
 * "How many blisters per kg PVC? per full roll? per foil roll?"
 *
 * Sources (priority): configured standard → learned average → empirical from completed rolls.
 */

import { db } from "@/lib/db";
import {
  blisterMaterialStandards,
  packagingMaterials,
  readMaterialUsageLearning,
  readRollUsage,
} from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";

export type RollYieldRoleAnswer = {
  role: "PVC" | "FOIL";
  /** Primary answer the user wants */
  blistersPerKg: number | null;
  blistersPerTypicalRoll: number | null;
  typicalRollKg: number | null;
  gramsPerBlister: number | null;
  /** Human-readable source */
  source: "CONFIGURED" | "LEARNED" | "COMPLETED_ROLLS" | "MISSING";
  confidence: string;
  sampleRollCount: number;
  lastRoll: {
    rollNumber: string | null;
    blistersProduced: number;
    gramsPerBlister: number | null;
    rollKg: number | null;
  } | null;
  avgBlistersPerCompletedRoll: number | null;
  headline: string;
  detail: string;
};

function gpbToBlistersPerKg(gpb: number | null): number | null {
  if (gpb == null || gpb <= 0) return null;
  return Math.round((1000 / gpb) * 100) / 100;
}

function blistersForRoll(netGrams: number | null, gpb: number | null): number | null {
  if (netGrams == null || gpb == null || gpb <= 0) return null;
  return Math.round(netGrams / gpb);
}

export async function getRollYieldSummary(): Promise<RollYieldRoleAnswer[]> {
  const roles: Array<"PVC" | "FOIL"> = ["PVC", "FOIL"];

  const [learnedRows, rollStats, lastRolls, configuredRows] = await Promise.all([
    db
      .select({
        role: readMaterialUsageLearning.materialRole,
        avgGpb: readMaterialUsageLearning.avgWeightPerBlister,
        sampleCount: readMaterialUsageLearning.sampleCount,
        confidence: readMaterialUsageLearning.confidence,
        materialName: packagingMaterials.name,
      })
      .from(readMaterialUsageLearning)
      .leftJoin(
        packagingMaterials,
        eq(packagingMaterials.id, readMaterialUsageLearning.packagingMaterialId),
      )
      .orderBy(desc(readMaterialUsageLearning.sampleCount)),

    db.execute(sql`
      SELECT
        material_role::text AS role,
        COUNT(*)::int AS roll_count,
        ROUND(AVG(blisters_produced))::int AS avg_blisters,
        ROUND(AVG(starting_weight_grams))::int AS avg_start_g,
        ROUND(AVG(
          CASE
            WHEN blisters_produced > 0 AND actual_used_grams IS NOT NULL
              THEN actual_used_grams::numeric / blisters_produced
            WHEN blisters_produced > 0 AND starting_weight_grams IS NOT NULL
              THEN starting_weight_grams::numeric / blisters_produced
            ELSE NULL
          END
        ), 4)::float AS avg_gpb
      FROM read_roll_usage
      WHERE blisters_produced > 0
        AND unmounted_at IS NOT NULL
        AND material_role IN ('PVC', 'FOIL')
      GROUP BY material_role
    `),

    db
      .select({
        role: readRollUsage.materialRole,
        rollNumber: readRollUsage.rollNumber,
        blistersProduced: readRollUsage.blistersProduced,
        actualUsedGrams: readRollUsage.actualUsedGrams,
        startingWeightGrams: readRollUsage.startingWeightGrams,
        unmountedAt: readRollUsage.unmountedAt,
      })
      .from(readRollUsage)
      .where(
        sql`${readRollUsage.blistersProduced} > 0 AND ${readRollUsage.unmountedAt} IS NOT NULL`,
      )
      .orderBy(desc(readRollUsage.unmountedAt)),

    db
      .select({
        role: blisterMaterialStandards.materialRole,
        productId: blisterMaterialStandards.productId,
        gramsPerBlister: blisterMaterialStandards.expectedGramsPerBlister,
        blistersPerKg: blisterMaterialStandards.expectedBlistersPerKg,
      })
      .from(blisterMaterialStandards)
      .where(eq(blisterMaterialStandards.isActive, true))
      .orderBy(sql`${blisterMaterialStandards.productId} NULLS FIRST`),
  ]);

  const statsByRole = new Map<
    string,
    { rollCount: number; avgBlisters: number; avgStartG: number; avgGpb: number | null }
  >();
  for (const row of rollStats as unknown as Array<{
    role: string;
    roll_count: number;
    avg_blisters: number | null;
    avg_start_g: number | null;
    avg_gpb: number | null;
  }>) {
    statsByRole.set(row.role, {
      rollCount: row.roll_count,
      avgBlisters: row.avg_blisters ?? 0,
      avgStartG: row.avg_start_g ?? 0,
      avgGpb: row.avg_gpb,
    });
  }

  const learnedByRole = new Map<string, (typeof learnedRows)[0]>();
  for (const row of learnedRows) {
    if (row.role && !learnedByRole.has(row.role)) learnedByRole.set(row.role, row);
  }

  const configuredByRole = new Map<string, (typeof configuredRows)[0]>();
  for (const row of configuredRows) {
    if (!configuredByRole.has(row.role)) configuredByRole.set(row.role, row);
  }

  const lastByRole = new Map<string, (typeof lastRolls)[0]>();
  for (const row of lastRolls) {
    if (row.role && !lastByRole.has(row.role)) lastByRole.set(row.role, row);
  }

  return roles.map((role) => {
    const learned = learnedByRole.get(role);
    const configured = configuredByRole.get(role);
    const stats = statsByRole.get(role);
    const last = lastByRole.get(role);

    let gramsPerBlister: number | null = null;
    let source: RollYieldRoleAnswer["source"] = "MISSING";
    let confidence = "MISSING";
    let sampleRollCount = 0;

    const configuredGpb =
      configured?.gramsPerBlister != null
        ? Number(configured.gramsPerBlister)
        : configured?.blistersPerKg != null && Number(configured.blistersPerKg) > 0
          ? 1000 / Number(configured.blistersPerKg)
          : null;

    if (configuredGpb != null && configuredGpb > 0) {
      gramsPerBlister = configuredGpb;
      source = "CONFIGURED";
      confidence = "HIGH";
    } else if (learned?.avgGpb != null && Number(learned.avgGpb) > 0) {
      gramsPerBlister = Number(learned.avgGpb);
      source = "LEARNED";
      confidence = learned.confidence ?? "MEDIUM";
      sampleRollCount = learned.sampleCount ?? 0;
    } else if (stats?.avgGpb != null && stats.avgGpb > 0) {
      gramsPerBlister = stats.avgGpb;
      source = "COMPLETED_ROLLS";
      confidence = stats.rollCount >= 3 ? "MEDIUM" : "LOW";
      sampleRollCount = stats.rollCount;
    }

    const blistersPerKg = gpbToBlistersPerKg(gramsPerBlister);

    const typicalRollKg =
      stats?.avgStartG && stats.avgStartG > 0
        ? Math.round((stats.avgStartG / 1000) * 100) / 100
        : last?.startingWeightGrams
          ? Math.round((last.startingWeightGrams / 1000) * 100) / 100
          : null;

    const blistersPerTypicalRoll =
      stats?.avgBlisters && stats.avgBlisters > 0
        ? stats.avgBlisters
        : blistersForRoll(
            typicalRollKg != null ? typicalRollKg * 1000 : null,
            gramsPerBlister,
          );

    const lastUsed =
      last?.actualUsedGrams ??
      (last?.startingWeightGrams != null ? last.startingWeightGrams : null);
    const lastGpb =
      lastUsed != null &&
      last?.blistersProduced != null &&
      last.blistersProduced > 0
        ? lastUsed / last.blistersProduced
        : null;

    let headline: string;
    let detail: string;

    if (blistersPerKg != null && blistersPerTypicalRoll != null && typicalRollKg != null) {
      headline = `${blistersPerKg.toLocaleString()} blisters per kg · ~${blistersPerTypicalRoll.toLocaleString()} per ${typicalRollKg} kg roll`;
      detail =
        source === "CONFIGURED"
          ? "From confirmed standard."
          : source === "LEARNED"
            ? `Learned from ${sampleRollCount} completed roll${sampleRollCount === 1 ? "" : "s"} (${(gramsPerBlister! / 1000).toFixed(4)} kg/cycle).`
            : `From ${sampleRollCount} completed roll average on the floor.`;
    } else if (last?.blistersProduced) {
      headline = `Last roll: ${last.blistersProduced.toLocaleString()} blisters`;
      detail =
        lastGpb != null
          ? `${(lastGpb / 1000).toFixed(4)} kg/cycle on roll ${last.rollNumber ?? "?"}. Need more depleted rolls for a plant average.`
          : "Counter segments recorded — weigh roll on depletion for g/blister.";
    } else {
      headline = "No yield yet";
      detail =
        "Complete one full cycle: receive roll with net weight → mount → counter segments → mark depleted.";
    }

    return {
      role,
      blistersPerKg,
      blistersPerTypicalRoll,
      typicalRollKg,
      gramsPerBlister,
      source,
      confidence,
      sampleRollCount,
      lastRoll: last
        ? {
            rollNumber: last.rollNumber,
            blistersProduced: last.blistersProduced ?? 0,
            gramsPerBlister: lastGpb,
            rollKg:
              last.startingWeightGrams != null
                ? Math.round((last.startingWeightGrams / 1000) * 100) / 100
                : null,
          }
        : null,
      avgBlistersPerCompletedRoll: stats?.avgBlisters ?? null,
      headline,
      detail,
    };
  });
}
