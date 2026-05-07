// Phase H.x3.6 — Variety pack component reconciliation.
//
// A variety-pack product has multiple raw components (e.g. flavor A,
// B, C). Each component is a row in product_component_requirements
// stating the quantity per finished unit and the slot/role.
//
// Reconciliation answers:
//   • For a finished_lot: did we consume the expected quantity of
//     each component? What's the variance per role?
//   • For a product: across all finished lots, how does empirical
//     consumption compare to the requirements?
//
// All helpers return MetricResult-shaped values. Missing requirements
// or missing component usage produce explicit empty-state labels —
// no fake variance numbers.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { combineConfidence, missing, ok, partial } from "./confidence";
import type { Confidence, MetricResult } from "./types";

// ─── Pure helpers ───────────────────────────────────────────────

/** expected = finishedUnits × qtyPerFinishedUnit. Null on missing
 *  inputs. The helper does no rounding — caller decides. */
export function computeExpectedComponentQty(
  finishedUnits: number | null | undefined,
  qtyPerFinishedUnit: number | null | undefined,
): number | null {
  if (finishedUnits == null || qtyPerFinishedUnit == null) return null;
  if (!Number.isFinite(finishedUnits) || !Number.isFinite(qtyPerFinishedUnit)) return null;
  if (finishedUnits < 0 || qtyPerFinishedUnit <= 0) return null;
  return finishedUnits * qtyPerFinishedUnit;
}

/** actual − expected. Null when either is missing. Negative variance
 *  means we used less than required (under-consumption, possibly
 *  short-fill); positive means we used more (waste, theft, miscount). */
export function computeComponentVariance(
  actual: number | null | undefined,
  expected: number | null | undefined,
): number | null {
  if (actual == null || expected == null) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
  return actual - expected;
}

/** Variance %, with divide-by-zero guard. */
export function computeComponentVariancePercent(
  variance: number | null,
  expected: number | null | undefined,
): number | null {
  if (variance == null || expected == null) return null;
  if (!Number.isFinite(variance) || !Number.isFinite(expected)) return null;
  if (expected <= 0) return null;
  return (variance / expected) * 100;
}

// ─── DB-backed helpers ─────────────────────────────────────────

export type ComponentRequirement = {
  id: string;
  productId: string;
  routeId: string | null;
  componentItemId: string;
  componentName: string;
  componentItemCode: string;
  componentRole: string;
  quantityPerFinishedUnit: number;
  unitOfMeasure: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
};

/** Active component requirements for a product. Returns [] when
 *  none configured — the caller surfaces the missing-state label. */
export async function deriveVarietyPackComponentRequirements(
  productId: string,
): Promise<ComponentRequirement[]> {
  if (!productId) return [];
  type Row = {
    id: string;
    product_id: string;
    route_id: string | null;
    component_item_id: string;
    component_name: string;
    component_item_code: string;
    component_role: string;
    qty_per_finished_unit: string;
    uom: string;
    effective_from: string;
    effective_to: string | null;
    is_active: boolean;
  };
  const rows = (await db.execute<Row>(sql`
    SELECT
      r.id::text                             AS id,
      r.product_id::text                     AS product_id,
      r.route_id::text                       AS route_id,
      r.component_item_id::text              AS component_item_id,
      i.name                                 AS component_name,
      i.item_code                            AS component_item_code,
      r.component_role                       AS component_role,
      r.quantity_per_finished_unit::text     AS qty_per_finished_unit,
      r.unit_of_measure                      AS uom,
      r.effective_from::text                 AS effective_from,
      r.effective_to::text                   AS effective_to,
      r.is_active                            AS is_active
    FROM product_component_requirements r
    JOIN items i ON i.id = r.component_item_id
    WHERE r.product_id = ${productId}
      AND r.is_active = true
    ORDER BY r.component_role, i.name
  `)) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    routeId: r.route_id,
    componentItemId: r.component_item_id,
    componentName: r.component_name,
    componentItemCode: r.component_item_code,
    componentRole: r.component_role,
    quantityPerFinishedUnit: Number(r.qty_per_finished_unit),
    unitOfMeasure: r.uom,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    isActive: r.is_active,
  }));
}

export type ComponentUsage = {
  componentItemId: string;
  componentName: string;
  componentRole: string;
  finishedUnits: number;
  expectedQty: MetricResult;
  actualConsumedQty: MetricResult;
  varianceQty: MetricResult;
  variancePct: MetricResult;
  confidence: Confidence;
  missingInputs: string[];
};

/** Per-component usage for a finished_lot. Resolves expected from
 *  product_component_requirements and actual from
 *  raw_bag_allocation_events filtered by finished_lot_id +
 *  componentRole, with a finished_lot_inputs.qty_consumed fallback. */
export async function deriveVarietyPackComponentUsage(
  finishedLotId: string,
): Promise<ComponentUsage[]> {
  if (!finishedLotId) return [];

  type LotRow = { product_id: string; units_produced: number };
  const lotRows = (await db.execute<LotRow>(sql`
    SELECT product_id::text, units_produced FROM finished_lots WHERE id = ${finishedLotId} LIMIT 1
  `)) as unknown as LotRow[];
  const lot = lotRows[0];
  if (!lot) return [];

  const requirements = await deriveVarietyPackComponentRequirements(lot.product_id);
  if (requirements.length === 0) return [];

  // Actual consumption per (component_item, role). Two sources:
  //   1. raw_bag_allocation_events with finished_lot_id matching
  //      and an item-source linking to the component item.
  //   2. Legacy fallback: finished_lot_inputs.qty_consumed mapped
  //      via inventory_bag.tablet_type → items.source_id.
  type ActualRow = {
    component_item_id: string;
    component_role: string | null;
    qty: number;
    used_ledger: boolean;
  };
  const actualRows = (await db.execute<ActualRow>(sql`
    -- Ledger-first.
    SELECT
      it.id::text                                     AS component_item_id,
      e.payload->>'component_role'                    AS component_role,
      SUM(COALESCE(e.quantity::numeric::int, 0))::int AS qty,
      true                                            AS used_ledger
    FROM raw_bag_allocation_events e
    JOIN inventory_bags ib ON ib.id = e.inventory_bag_id
    JOIN items it          ON it.source_kind = 'TABLET_TYPE' AND it.source_id = ib.tablet_type_id
    WHERE e.finished_lot_id = ${finishedLotId}
      AND e.event_type = 'RAW_BAG_PARTIAL_CONSUMED'
    GROUP BY it.id, e.payload->>'component_role'
    UNION ALL
    -- Legacy fallback (only contributes when the ledger has nothing
    -- for the lot).
    SELECT
      it.id::text                                AS component_item_id,
      NULL                                       AS component_role,
      SUM(fli.qty_consumed)::int                  AS qty,
      false                                       AS used_ledger
    FROM finished_lot_inputs fli
    JOIN batches b           ON b.id = fli.batch_id
    JOIN inventory_bags ib   ON ib.batch_id = b.id
    JOIN items it            ON it.source_kind = 'TABLET_TYPE' AND it.source_id = ib.tablet_type_id
    WHERE fli.finished_lot_id = ${finishedLotId}
      AND NOT EXISTS (
        SELECT 1 FROM raw_bag_allocation_events e
        WHERE e.finished_lot_id = ${finishedLotId}
          AND e.event_type = 'RAW_BAG_PARTIAL_CONSUMED'
      )
    GROUP BY it.id
  `)) as unknown as ActualRow[];

  const actualByKey = new Map<string, { qty: number; usedLedger: boolean }>();
  for (const r of actualRows) {
    const key = `${r.component_item_id}::${r.component_role ?? ""}`;
    const cur = actualByKey.get(key) ?? { qty: 0, usedLedger: false };
    cur.qty += r.qty ?? 0;
    cur.usedLedger = cur.usedLedger || r.used_ledger;
    actualByKey.set(key, cur);
  }

  return requirements.map((req) => {
    const exact = actualByKey.get(`${req.componentItemId}::${req.componentRole}`);
    const fallback = actualByKey.get(`${req.componentItemId}::`);
    const actualEntry = exact ?? fallback;
    const expectedQtyValue = computeExpectedComponentQty(
      lot.units_produced,
      req.quantityPerFinishedUnit,
    );
    const actualQtyValue = actualEntry?.qty ?? null;
    const variance = computeComponentVariance(actualQtyValue, expectedQtyValue);
    const variancePct = computeComponentVariancePercent(variance, expectedQtyValue);
    const usedLedger = actualEntry?.usedLedger ?? false;
    const missingInputs: string[] = [];
    if (actualQtyValue == null) missingInputs.push("component_usage");
    if (!usedLedger && actualQtyValue != null) missingInputs.push("ledger_fallback");
    let conf: Confidence;
    if (actualQtyValue == null) conf = "MISSING";
    else if (usedLedger) conf = "HIGH";
    else conf = "MEDIUM";

    return {
      componentItemId: req.componentItemId,
      componentName: req.componentName,
      componentRole: req.componentRole,
      finishedUnits: lot.units_produced,
      expectedQty:
        expectedQtyValue != null
          ? ok(expectedQtyValue, req.unitOfMeasure, {
              explanation: `${lot.units_produced} finished × ${req.quantityPerFinishedUnit} ${req.unitOfMeasure}/unit.`,
            })
          : missing(
              req.unitOfMeasure,
              ["finished_units", "qty_per_finished_unit"],
              "Cannot compute expected quantity",
            ),
      actualConsumedQty:
        actualQtyValue != null
          ? usedLedger
            ? ok(actualQtyValue, req.unitOfMeasure, { explanation: "From raw_bag_allocation_events." })
            : partial(actualQtyValue, req.unitOfMeasure, {
                missingInputs: ["ledger_fallback"],
                explanation: "From finished_lot_inputs (legacy fallback).",
              })
          : missing(req.unitOfMeasure, ["component_usage"], "Component usage missing"),
      varianceQty:
        variance != null
          ? partial(variance, req.unitOfMeasure, {
              missingInputs: missingInputs.filter((m) => m !== "ledger_fallback"),
              explanation: "actual − expected.",
            })
          : missing(req.unitOfMeasure, ["variance_inputs"], "Cannot compute variance"),
      variancePct:
        variancePct != null
          ? partial(variancePct, "%", { missingInputs: [], explanation: "Variance ÷ expected × 100." })
          : missing("%", ["variance_inputs"], "Cannot compute variance %"),
      confidence: conf,
      missingInputs,
    };
  });
}

export type VarietyPackReconciliation = {
  productId: string;
  productName: string;
  productSku: string;
  hasRequirements: boolean;
  rollups: ReadonlyArray<{
    componentItemId: string;
    componentName: string;
    componentRole: string;
    expectedTotal: MetricResult;
    actualTotal: MetricResult;
    varianceTotal: MetricResult;
    confidence: Confidence;
  }>;
  combinedConfidence: Confidence;
  /** When the input is a finished_lot_id, the per-lot detail is
   *  included verbatim. When the input is a product_id, the lot-
   *  level detail is omitted; the rollups are the answer. */
  lotDetail?: ComponentUsage[];
};

export async function deriveVarietyPackReconciliation(input: {
  productId?: string;
  finishedLotId?: string;
}): Promise<VarietyPackReconciliation | null> {
  // Resolve product.
  let productId = input.productId ?? null;
  let lotDetail: ComponentUsage[] | undefined;
  if (input.finishedLotId) {
    type LotRow = { product_id: string };
    const lotRows = (await db.execute<LotRow>(sql`
      SELECT product_id::text FROM finished_lots WHERE id = ${input.finishedLotId} LIMIT 1
    `)) as unknown as LotRow[];
    productId = lotRows[0]?.product_id ?? null;
    if (input.finishedLotId && productId) {
      lotDetail = await deriveVarietyPackComponentUsage(input.finishedLotId);
    }
  }
  if (!productId) return null;

  type ProductRow = { product_name: string; product_sku: string };
  const productRows = (await db.execute<ProductRow>(sql`
    SELECT name AS product_name, sku AS product_sku FROM products WHERE id = ${productId} LIMIT 1
  `)) as unknown as ProductRow[];
  const p = productRows[0];
  if (!p) return null;

  const requirements = await deriveVarietyPackComponentRequirements(productId);
  if (requirements.length === 0) {
    return {
      productId,
      productName: p.product_name,
      productSku: p.product_sku,
      hasRequirements: false,
      rollups: [],
      combinedConfidence: "MISSING",
      ...(lotDetail !== undefined ? { lotDetail } : {}),
    };
  }

  // Aggregate across all finished lots of this product.
  type AggRow = {
    component_item_id: string;
    component_role: string | null;
    expected_total: number;
    actual_total: number | null;
    used_ledger_any: boolean;
    sample_count: number;
  };
  const rows = (await db.execute<AggRow>(sql`
    WITH lots AS (
      SELECT id AS finished_lot_id, units_produced FROM finished_lots WHERE product_id = ${productId}
    ),
    requirements AS (
      SELECT id, component_item_id, component_role, quantity_per_finished_unit
      FROM product_component_requirements
      WHERE product_id = ${productId} AND is_active = true
    ),
    expected AS (
      SELECT
        r.component_item_id::text                                                AS component_item_id,
        r.component_role                                                         AS component_role,
        SUM(l.units_produced * r.quantity_per_finished_unit)::numeric            AS expected_total
      FROM requirements r CROSS JOIN lots l
      GROUP BY r.component_item_id, r.component_role
    ),
    actual_ledger AS (
      SELECT
        it.id::text                                AS component_item_id,
        e.payload->>'component_role'               AS component_role,
        SUM(COALESCE(e.quantity::numeric::int,0))::numeric AS actual_total,
        COUNT(*)::int                              AS sample_count,
        true                                       AS used_ledger
      FROM raw_bag_allocation_events e
      JOIN inventory_bags ib ON ib.id = e.inventory_bag_id
      JOIN items it          ON it.source_kind = 'TABLET_TYPE' AND it.source_id = ib.tablet_type_id
      WHERE e.finished_lot_id IN (SELECT finished_lot_id FROM lots)
        AND e.event_type = 'RAW_BAG_PARTIAL_CONSUMED'
      GROUP BY it.id, e.payload->>'component_role'
    ),
    actual_legacy AS (
      SELECT
        it.id::text                                AS component_item_id,
        NULL                                       AS component_role,
        SUM(fli.qty_consumed)::numeric             AS actual_total,
        COUNT(*)::int                              AS sample_count,
        false                                      AS used_ledger
      FROM finished_lot_inputs fli
      JOIN batches b ON b.id = fli.batch_id
      JOIN inventory_bags ib ON ib.batch_id = b.id
      JOIN items it ON it.source_kind = 'TABLET_TYPE' AND it.source_id = ib.tablet_type_id
      WHERE fli.finished_lot_id IN (SELECT finished_lot_id FROM lots)
        AND NOT EXISTS (
          SELECT 1 FROM raw_bag_allocation_events e
          WHERE e.finished_lot_id = fli.finished_lot_id
            AND e.event_type = 'RAW_BAG_PARTIAL_CONSUMED'
        )
      GROUP BY it.id
    )
    SELECT
      e.component_item_id,
      e.component_role,
      e.expected_total::numeric::int  AS expected_total,
      COALESCE(al.actual_total, ag.actual_total)::numeric::int AS actual_total,
      COALESCE(al.used_ledger, ag.used_ledger, false) AS used_ledger_any,
      COALESCE(al.sample_count, ag.sample_count, 0)::int AS sample_count
    FROM expected e
    LEFT JOIN actual_ledger al
      ON al.component_item_id = e.component_item_id
     AND COALESCE(al.component_role,'') = COALESCE(e.component_role,'')
    LEFT JOIN actual_legacy ag
      ON ag.component_item_id = e.component_item_id
     AND al.component_item_id IS NULL
  `)) as unknown as AggRow[];

  const rollups = rows.map((r) => {
    const variance = computeComponentVariance(r.actual_total, r.expected_total);
    const conf: Confidence =
      r.actual_total == null
        ? "MISSING"
        : r.used_ledger_any
          ? "HIGH"
          : "MEDIUM";
    return {
      componentItemId: r.component_item_id,
      componentName:
        requirements.find((q) => q.componentItemId === r.component_item_id)
          ?.componentName ?? r.component_item_id,
      componentRole: r.component_role ?? "",
      expectedTotal:
        r.expected_total != null
          ? ok(r.expected_total, "units")
          : missing("units", ["expected_inputs"], "No finished lots yet"),
      actualTotal:
        r.actual_total != null
          ? r.used_ledger_any
            ? ok(r.actual_total, "units")
            : partial(r.actual_total, "units", {
                missingInputs: ["ledger_fallback"],
                explanation: "From finished_lot_inputs (legacy fallback).",
              })
          : missing("units", ["component_usage"], "Component usage missing"),
      varianceTotal:
        variance != null
          ? partial(variance, "units", {
              missingInputs: [],
              explanation: "actual − expected across all finished lots.",
            })
          : missing("units", ["variance_inputs"], "Cannot compute variance"),
      confidence: conf,
    };
  });

  const combinedConfidence = combineConfidence(rollups.map((r) => r.confidence));

  return {
    productId,
    productName: p.product_name,
    productSku: p.product_sku,
    hasRequirements: true,
    rollups,
    combinedConfidence,
    ...(lotDetail !== undefined ? { lotDetail } : {}),
  };
}
