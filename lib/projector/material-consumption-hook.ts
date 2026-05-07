// Phase H.x3 — Material consumption emission on BLISTER_COMPLETE.
//
// When a BLISTER_COMPLETE event fires:
//   1. Find the active mounted PVC + foil rolls for the station's
//      machine.
//   2. Read the gross blister counter delta from payload.machine_count.
//   3. For each active roll:
//        a. Resolve the standard via configured → learned → MISSING.
//        b. If MISSING: skip emission (we don't fake a number).
//        c. Otherwise emit MATERIAL_CONSUMED_ESTIMATED with full
//           context payload — gross_blisters_produced, standard_source,
//           expected_weight_used, material_lot_id, product_id,
//           machine_id, workflow_bag_id, confidence, missing_inputs.
//
// The hook is called inside the same transaction as the upstream
// BLISTER_COMPLETE insert, so consumption events land atomically
// with the production event.
//
// No fake math. If a station has no active roll → skip. If the event
// has no counter → skip. If neither configured nor learned standard
// exists → skip. The skip is silent at the projector level; the UI
// surfaces the missing-state via metric-API helpers.

import { sql, eq, and } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  materialInventoryEvents,
  packagingLots,
  packagingMaterials,
  blisterMaterialStandards,
  readMaterialUsageLearning,
  workflowBags,
  stations,
} from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type ActiveRollRow = {
  packaging_lot_id: string;
  packaging_material_id: string;
  material_kind: string;
  role: "PVC" | "FOIL";
};

type ResolvedStandard = {
  gramsPerBlister: number;
  source: "CONFIGURED" | "LEARNED";
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

export async function emitMaterialConsumedFromBlister(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
    upstreamClientEventId?: string | null;
  },
): Promise<void> {
  // 1. Pull machine + product context.
  const [stationRow] = await tx
    .select({ machineId: stations.machineId })
    .from(stations)
    .where(eq(stations.id, args.stationId));
  const machineId = stationRow?.machineId ?? null;
  if (!machineId) return; // floor station without machine — skip
  const [bagRow] = await tx
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId));
  const productId = bagRow?.productId ?? null;

  // 2. Counter delta from the event payload. machine_count is the
  //    canonical key (see lib/projector/roll-usage.ts which reads
  //    the same value). Reject non-positive counts to avoid emitting
  //    junk events when the operator left the counter blank.
  const rawCount = args.payload?.["machine_count"];
  const blistersProduced =
    typeof rawCount === "number"
      ? Math.trunc(rawCount)
      : typeof rawCount === "string" && rawCount !== ""
        ? Math.trunc(Number(rawCount))
        : null;
  if (blistersProduced == null || !Number.isFinite(blistersProduced) || blistersProduced <= 0) {
    return; // no counter — skip silently. UI surfaces the gap.
  }

  // 3. Find the active mounted rolls for this machine via
  //    "latest event per lot" pattern. PVC and FOIL each get their
  //    own consumption event, derived from their own standards.
  const activeRolls = await tx.execute<ActiveRollRow>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.event_type,
        ev.machine_id,
        ev.payload
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED')
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT
      lot.id::text                    AS packaging_lot_id,
      lot.packaging_material_id::text AS packaging_material_id,
      pm.kind::text                   AS material_kind,
      COALESCE(
        (le.payload->>'roll_role'),
        CASE pm.kind::text
          WHEN 'PVC_ROLL'    THEN 'PVC'
          WHEN 'FOIL_ROLL'   THEN 'FOIL'
          WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END
      ) AS role
    FROM packaging_lots lot
    JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
    JOIN latest_event le ON le.packaging_lot_id = lot.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND le.machine_id = ${machineId}
      AND lot.status = 'IN_USE'
      AND pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
  `);
  const rolls = (activeRolls as unknown as ActiveRollRow[]).filter(
    (r) => r.role === "PVC" || r.role === "FOIL",
  );
  if (rolls.length === 0) return; // no rolls mounted — skip

  // 4. For each roll, resolve a standard and emit a consumption event.
  for (const roll of rolls) {
    const std = await resolveStandard(tx, {
      productId,
      packagingMaterialId: roll.packaging_material_id,
      materialRole: roll.role,
      machineId,
    });
    if (!std) continue; // no standard — skip honestly, never fabricate

    const expectedGrams = Math.round(blistersProduced * std.gramsPerBlister);

    await tx.insert(materialInventoryEvents).values({
      eventType: "MATERIAL_CONSUMED_ESTIMATED",
      packagingMaterialId: roll.packaging_material_id,
      packagingLotId: roll.packaging_lot_id,
      ...(productId ? { productId } : {}),
      workflowBagId: args.workflowBagId,
      machineId,
      stationId: args.stationId,
      quantityGrams: expectedGrams,
      unitOfMeasure: "g",
      occurredAt: args.occurredAt,
      payload: {
        gross_blisters_produced: blistersProduced,
        standard_source: std.source,
        expected_weight_used_grams: expectedGrams,
        grams_per_blister: std.gramsPerBlister,
        material_lot_id: roll.packaging_lot_id,
        product_id: productId,
        machine_id: machineId,
        workflow_bag_id: args.workflowBagId,
        roll_role: roll.role,
        confidence: std.confidence,
        missing_inputs: std.source === "LEARNED" ? ["configured_standard"] : [],
      },
      source: "projector.blister_complete_hook",
      // Re-use upstream clientEventId so a retry of BLISTER_COMPLETE
      // does not duplicate the consumption event. Suffix per-role so
      // PVC + FOIL emissions for the same upstream event don't
      // collide on the partial unique index.
      ...(args.upstreamClientEventId
        ? { clientEventId: `${args.upstreamClientEventId}-${roll.role.toLowerCase()}` }
        : {}),
    });
  }
}

async function resolveStandard(
  tx: Tx,
  input: {
    productId: string | null;
    packagingMaterialId: string;
    materialRole: "PVC" | "FOIL";
    machineId: string | null;
  },
): Promise<ResolvedStandard | null> {
  // Configured first.
  if (input.productId) {
    const rows = await tx
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
      const direct = r.gramsPerBlister != null ? Number(r.gramsPerBlister) : null;
      const fromKg =
        r.blistersPerKg != null && Number(r.blistersPerKg) > 0
          ? 1000 / Number(r.blistersPerKg)
          : null;
      const v = direct ?? fromKg;
      if (v != null && v > 0) {
        return { gramsPerBlister: v, source: "CONFIGURED", confidence: "HIGH" };
      }
    }
  }
  // Learned — most-specific to least-specific fallback.
  type LearnedRow = { avg: string | null; confidence: string };
  const candidates: Array<{ productId: string | null; machineId: string | null }> = [
    { productId: input.productId, machineId: input.machineId },
    { productId: input.productId, machineId: null },
    { productId: null, machineId: input.machineId },
    { productId: null, machineId: null },
  ];
  for (const c of candidates) {
    const rows = await tx
      .select({
        avg: readMaterialUsageLearning.avgWeightPerBlister,
        confidence: readMaterialUsageLearning.confidence,
        sampleCount: readMaterialUsageLearning.sampleCount,
      })
      .from(readMaterialUsageLearning)
      .where(
        and(
          eq(readMaterialUsageLearning.packagingMaterialId, input.packagingMaterialId),
          eq(readMaterialUsageLearning.materialRole, input.materialRole),
          c.productId == null
            ? sql`product_id IS NULL`
            : eq(readMaterialUsageLearning.productId, c.productId),
          c.machineId == null
            ? sql`machine_id IS NULL`
            : eq(readMaterialUsageLearning.machineId, c.machineId),
        ),
      )
      .limit(1);
    const r = rows[0] as unknown as LearnedRow & { sampleCount: number } | undefined;
    if (r && r.avg != null && r.sampleCount > 0) {
      const v = Number(r.avg);
      if (v > 0) {
        const conf =
          r.confidence === "HIGH"
            ? "HIGH"
            : r.confidence === "MEDIUM"
              ? "MEDIUM"
              : "LOW";
        return { gramsPerBlister: v, source: "LEARNED", confidence: conf };
      }
    }
  }
  return null;
}

// Reference unused imports so tree-shaking doesn't drop them.
export const _packagingLotsRef = packagingLots;
export const _packagingMaterialsRef = packagingMaterials;
