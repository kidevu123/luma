// Phase H.x3.5 — PO-level raw material reconciliation.
//
// Given a PO, walk every raw bag (inventory_bag) tied to it through
// the receipt chain, then attribute every raw unit to one of:
//   • finished output (via finished_lot_inputs.qty_consumed in tablet UoM)
//   • known damage / rework (via workflow_events payloads)
//   • remaining inventory (via inventory_bags.status = AVAILABLE)
//   • unknown variance (the residual; never relabeled as "shortage")
//
// All math returns MetricResult-shaped values. Missing inputs
// propagate to MISSING; partial computations propagate to MEDIUM;
// only fully-grounded computations return HIGH.
//
// No fake numbers anywhere. If the unit-weight standard is missing,
// our_estimated_count is missing — we never invent a unit weight.
// If the product structure is missing, that product's contribution
// is excluded from raw-equivalent totals and the missing reason is
// surfaced.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { combineConfidence, missing, ok, partial } from "./confidence";
import type { Confidence, MetricResult } from "./types";

// ─── Pure math helpers (tested in isolation) ────────────────────

/** Internal estimated count = received weight / standard unit weight.
 *  Returns null when either side is missing or unit weight ≤ 0.
 *  The caller surfaces a missing() MetricResult — this is just the
 *  arithmetic. */
export function computeOurEstimatedCount(
  receivedNetGrams: number | null | undefined,
  standardUnitWeightGrams: number | null | undefined,
): number | null {
  if (receivedNetGrams == null || standardUnitWeightGrams == null) return null;
  if (!Number.isFinite(receivedNetGrams) || !Number.isFinite(standardUnitWeightGrams)) return null;
  if (standardUnitWeightGrams <= 0) return null;
  if (receivedNetGrams < 0) return null;
  return receivedNetGrams / standardUnitWeightGrams;
}

/** vendor_declared - finished_equivalent - known_loss - remaining.
 *  Null propagates. Refuses to silently substitute 0 for missing
 *  inputs. */
export function computeVendorVariance(
  vendorDeclared: number | null | undefined,
  finishedEquivalent: number | null | undefined,
  knownLoss: number | null | undefined,
  remainingEstimate: number | null | undefined,
): number | null {
  if (vendorDeclared == null) return null;
  const parts = [finishedEquivalent, knownLoss, remainingEstimate];
  let sum = 0;
  for (const p of parts) {
    if (p == null) return null;
    if (!Number.isFinite(p)) return null;
    sum += p;
  }
  return vendorDeclared - sum;
}

/** Variance percent = variance / vendor_declared * 100. Null if
 *  inputs missing or denominator is 0. */
export function computeVendorErrorPercent(
  variance: number | null,
  vendorDeclared: number | null | undefined,
): number | null {
  if (variance == null || vendorDeclared == null) return null;
  if (!Number.isFinite(variance) || !Number.isFinite(vendorDeclared)) return null;
  if (vendorDeclared <= 0) return null;
  return (variance / vendorDeclared) * 100;
}

/** Decide what the supplier should be paid for. Three modes:
 *   • VENDOR_DECLARED       — pay what the vendor said. Used when
 *                              policy is to trust the declaration
 *                              (HIGH confidence).
 *   • ACCOUNTED_OUTPUT      — pay what we actually accounted for.
 *                              Used when our internal estimate has
 *                              HIGH confidence and policy is
 *                              "pay what landed."
 *   • MANUAL_REVIEW         — anything else. Confidence is too low
 *                              to auto-derive a payable quantity.
 *
 * Pure helper — does not look at any policy table. The caller wires
 * the policy. Today the only signal is the data confidence; future
 * phases may add a "PO payment policy" admin setting. */
export function decidePayableQuantity(input: {
  vendorDeclared: number | null;
  accountedOutput: number | null;
  knownLoss: number | null;
  remainingEstimate: number | null;
  confidence: Confidence;
}): {
  source: "VENDOR_DECLARED" | "ACCOUNTED_OUTPUT" | "MANUAL_REVIEW";
  value: number | null;
  explanation: string;
} {
  const { vendorDeclared, accountedOutput, knownLoss, remainingEstimate, confidence } = input;
  if (confidence === "MISSING" || confidence === "LOW") {
    return {
      source: "MANUAL_REVIEW",
      value: null,
      explanation:
        "Confidence is too low to auto-derive a payable quantity. Review bag-level data.",
    };
  }
  if (vendorDeclared != null && Number.isFinite(vendorDeclared)) {
    if (
      accountedOutput != null &&
      knownLoss != null &&
      remainingEstimate != null &&
      Number.isFinite(accountedOutput) &&
      Number.isFinite(knownLoss) &&
      Number.isFinite(remainingEstimate)
    ) {
      const accounted = accountedOutput + knownLoss + remainingEstimate;
      return {
        source: "ACCOUNTED_OUTPUT",
        value: accounted,
        explanation: `Pay for what we actually accounted for: ${accountedOutput} finished + ${knownLoss} known loss + ${remainingEstimate} remaining.`,
      };
    }
    return {
      source: "VENDOR_DECLARED",
      value: vendorDeclared,
      explanation:
        "Vendor declared count used as payable quantity (insufficient internal accounting).",
    };
  }
  return {
    source: "MANUAL_REVIEW",
    value: null,
    explanation: "Vendor declaration is missing — manual review required.",
  };
}

// ─── DB-backed helpers ──────────────────────────────────────────

type PoSummaryRow = {
  po_id: string;
  po_number: string;
  vendor_name: string | null;
  status: string;
  opened_at: string;
  bag_count: number;
};

export async function listPoSummaries(): Promise<PoSummaryRow[]> {
  const rows = await db.execute<PoSummaryRow>(sql`
    SELECT
      po.id::text                AS po_id,
      po.po_number               AS po_number,
      po.vendor_name             AS vendor_name,
      po.status::text            AS status,
      po.opened_at::text         AS opened_at,
      COUNT(ib.id)::int          AS bag_count
    FROM purchase_orders po
    -- only POs that have at least one tablet line item
    INNER JOIN po_lines pl        ON pl.po_id = po.id AND pl.tablet_type_id IS NOT NULL
    LEFT JOIN receives r          ON r.po_id = po.id
    LEFT JOIN small_boxes sb      ON sb.receive_id = r.id
    LEFT JOIN inventory_bags ib   ON ib.small_box_id = sb.id
    GROUP BY po.id
    ORDER BY po.opened_at DESC
  `);
  return rows as unknown as PoSummaryRow[];
}

/** Resolve the most-specific active unit-weight standard for a
 *  tablet_type at a given date. Returns null when no standard exists. */
export async function resolveUnitWeight(
  tabletTypeId: string,
  asOf: Date | null = null,
): Promise<{ unitWeightGrams: number; confidence: Confidence; sampleSource: string | null } | null> {
  if (!tabletTypeId) return null;
  type Row = {
    standard_unit_weight: string;
    confidence: string;
    sample_source: string | null;
  };
  const day = (asOf ?? new Date()).toISOString().slice(0, 10);
  const rows = await db.execute<Row>(sql`
    SELECT standard_unit_weight::text, confidence, sample_source
    FROM raw_item_weight_standards
    WHERE tablet_type_id = ${tabletTypeId}
      AND is_active = true
      AND effective_from <= ${day}::date
      AND (effective_to IS NULL OR effective_to >= ${day}::date)
    ORDER BY effective_from DESC
    LIMIT 1
  `);
  const r = (rows as unknown as Row[])[0];
  if (!r) return null;
  const v = Number(r.standard_unit_weight);
  if (!Number.isFinite(v) || v <= 0) return null;
  const conf: Confidence =
    r.confidence === "HIGH"
      ? "HIGH"
      : r.confidence === "LOW"
        ? "LOW"
        : r.confidence === "MISSING"
          ? "MISSING"
          : "MEDIUM";
  return { unitWeightGrams: v, confidence: conf, sampleSource: r.sample_source };
}

// ─── Bag-level reconciliation ───────────────────────────────────

export type RawBagReconciliation = {
  inventoryBagId: string;
  workflowBagIds: string[];
  vendorBarcode: string | null;
  bagNumber: number | null;
  status: string;
  poId: string | null;
  poNumber: string | null;
  vendorName: string | null;
  tabletTypeId: string | null;
  tabletTypeName: string | null;
  vendorDeclaredCount: MetricResult;
  receivedNetWeightGrams: MetricResult;
  ourEstimatedCount: MetricResult;
  finishedEquivalentUnits: MetricResult;
  knownLossUnits: MetricResult;
  remainingEstimate: MetricResult;
  unknownVariance: MetricResult;
  vendorVarianceQty: MetricResult;
  vendorErrorPercent: MetricResult;
  ourEstimateVarianceQty: MetricResult;
  ourEstimateErrorPercent: MetricResult;
  combinedConfidence: Confidence;
};

/** Reconciliation for a single inventory_bag. Caller passes the
 *  inventory_bag id (not workflow_bag) so the same helper handles
 *  multi-WF cases (one inventory bag may feed many workflow bags). */
export async function deriveRawBagReconciliation(
  inventoryBagId: string,
): Promise<RawBagReconciliation> {
  if (!inventoryBagId) {
    return emptyBagReconciliation(inventoryBagId);
  }
  type BagRow = {
    inventory_bag_id: string;
    bag_number: number | null;
    vendor_barcode: string | null;
    pill_count: number | null;
    weight_grams: number | null;
    tablet_type_id: string | null;
    tablet_type_name: string | null;
    status: string;
    batch_id: string | null;
    po_id: string | null;
    po_number: string | null;
    vendor_name: string | null;
  };
  const bagRows = await db.execute<BagRow>(sql`
    SELECT
      ib.id::text                AS inventory_bag_id,
      ib.bag_number              AS bag_number,
      ib.vendor_barcode          AS vendor_barcode,
      ib.pill_count              AS pill_count,
      ib.weight_grams            AS weight_grams,
      ib.tablet_type_id::text    AS tablet_type_id,
      tt.name                    AS tablet_type_name,
      ib.status::text            AS status,
      ib.batch_id::text          AS batch_id,
      po.id::text                AS po_id,
      po.po_number               AS po_number,
      po.vendor_name             AS vendor_name
    FROM inventory_bags ib
    LEFT JOIN tablet_types tt    ON tt.id = ib.tablet_type_id
    LEFT JOIN small_boxes sb     ON sb.id = ib.small_box_id
    LEFT JOIN receives r         ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.id = ${inventoryBagId}
    LIMIT 1
  `);
  const bag = (bagRows as unknown as BagRow[])[0];
  if (!bag) return emptyBagReconciliation(inventoryBagId);

  // Workflow bags consuming this inventory bag.
  type WfRow = { id: string };
  const wfRows = (await db.execute<WfRow>(sql`
    SELECT id::text FROM workflow_bags WHERE inventory_bag_id = ${inventoryBagId}
  `)) as unknown as WfRow[];
  const workflowBagIds = wfRows.map((r) => r.id);

  // Finished equivalent in tablet UoM — the workflow-visible truth for
  // THIS bag (RECON-FINISHED-MATH-1). Previous derivation summed
  // finished_lot_inputs by BATCH, so every bag in the same input lot
  // showed the whole flavor's total (and the PO rollup multiplied it by
  // the bag count). Now: sum over this bag's own workflow runs of
  // produced units — recomputed live from the packaging counts × the
  // product's CURRENT structure (same STALE-SNAPSHOT-MATH-1 rule the
  // rest of Luma uses) — × tablets-per-unit. Recovered/excluded runs
  // contribute nothing; a run with output but no tablets-per-unit makes
  // the value honestly unknown instead of fabricating a number.
  type FinRow = {
    finished_tablets: number | null;
    conversion_unknown: boolean | null;
    finalized_runs: number | null;
  };
  const finRows = (await db.execute<FinRow>(sql`
    SELECT
      SUM(
        CASE
          WHEN COALESCE(rbs.excluded_from_output, false) THEN 0
          ELSE (
            CASE WHEN p.units_per_display IS NOT NULL AND p.displays_per_case IS NOT NULL
              THEN m.master_cases * p.units_per_display * p.displays_per_case
                 + m.displays_made * p.units_per_display + m.loose_cards
              ELSE m.loose_cards END
          ) * p.tablets_per_unit
        END
      )::int AS finished_tablets,
      BOOL_OR(
        p.tablets_per_unit IS NULL AND NOT COALESCE(rbs.excluded_from_output, false)
      ) AS conversion_unknown,
      COUNT(m.workflow_bag_id)::int AS finalized_runs
    FROM workflow_bags wb
    JOIN read_bag_metrics m  ON m.workflow_bag_id = wb.id
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    LEFT JOIN products p     ON p.id = wb.product_id
    WHERE wb.inventory_bag_id = ${inventoryBagId}
  `)) as unknown as FinRow[];
  const fin = finRows[0];
  const finalizedRuns = fin?.finalized_runs ?? 0;
  const finishedConversionUnknown = finalizedRuns > 0 && fin?.conversion_unknown === true;
  const finishedEquivalent: number | null =
    finalizedRuns === 0
      ? 0
      : finishedConversionUnknown
        ? null
        : (fin?.finished_tablets ?? 0);

  // Known damage / rework summed across the consuming workflow bags.
  type LossRow = { known_loss: number | null };
  let knownLoss: number | null = null;
  if (workflowBagIds.length > 0) {
    const lossRows = (await db.execute<LossRow>(sql`
      SELECT
        SUM(
          COALESCE(
            NULLIF((payload->>'damaged_count'),'')::int,
            NULLIF((payload->>'rework_count'),'')::int,
            NULLIF((payload->>'count'),'')::int
          )
        )::int AS known_loss
      FROM workflow_events
      WHERE workflow_bag_id IN (${sql.raw(workflowBagIds.map((id) => `'${id}'`).join(","))})
        AND event_type::text IN ('PACKAGING_DAMAGE_RETURN', 'BAG_PAUSED')
    `)) as unknown as LossRow[];
    knownLoss = lossRows[0]?.known_loss ?? 0;
  }

  // Remaining estimate: only AVAILABLE inventory bags have remaining
  // mass. For IN_USE / EMPTIED / VOID bags, remaining is 0.
  let remainingEstimate: number | null;
  if (bag.status === "AVAILABLE" && bag.weight_grams != null) {
    // We don't subtract: AVAILABLE means not yet consumed at all.
    // pill_count is the vendor declaration; weight*unitWeight gives
    // our estimate. Use whichever is more grounded.
    if (bag.pill_count != null) {
      remainingEstimate = bag.pill_count;
    } else {
      remainingEstimate = null; // wait until we have a unit-weight standard
    }
  } else if (bag.status === "EMPTIED" || bag.status === "VOID") {
    remainingEstimate = 0;
  } else if (bag.status === "IN_USE") {
    // WIP — remaining unknown until weighed. Keep null and let the
    // caller surface "Remaining unknown — bag in production."
    remainingEstimate = null;
  } else {
    remainingEstimate = null;
  }

  // Our estimated count from received weight + unit-weight standard.
  let ourEstimatedCount: MetricResult;
  let estimatedCountValue: number | null = null;
  if (bag.weight_grams == null) {
    ourEstimatedCount = missing("units", ["received_net_weight"], "Received weight not recorded");
  } else if (!bag.tablet_type_id) {
    ourEstimatedCount = missing("units", ["tablet_type"], "Raw item not assigned to bag");
  } else {
    const std = await resolveUnitWeight(bag.tablet_type_id, null);
    if (!std) {
      ourEstimatedCount = missing(
        "units",
        ["raw_item_weight_standards"],
        "Unit weight standard missing",
      );
    } else {
      const v = computeOurEstimatedCount(bag.weight_grams, std.unitWeightGrams);
      if (v == null) {
        ourEstimatedCount = missing("units", ["calculation"], "Cannot compute estimate");
      } else {
        estimatedCountValue = Math.round(v);
        ourEstimatedCount =
          std.confidence === "HIGH"
            ? ok(estimatedCountValue, "units", {
                explanation: `${bag.weight_grams} g ÷ ${std.unitWeightGrams} g/unit (${std.sampleSource ?? "configured"}).`,
              })
            : partial(estimatedCountValue, "units", {
                missingInputs: ["unit_weight_confidence"],
                explanation: `${bag.weight_grams} g ÷ ${std.unitWeightGrams} g/unit (${std.confidence} confidence).`,
              });
      }
    }
  }

  // Build MetricResults for the structured outputs.
  const vendorDeclaredCount =
    bag.pill_count != null
      ? ok(bag.pill_count, "units")
      : missing("units", ["vendor_declared_count"], "Vendor declared count missing");
  const receivedNetWeightGrams =
    bag.weight_grams != null
      ? ok(bag.weight_grams, "g")
      : missing("g", ["received_net_weight"], "Received weight not recorded");
  const finishedEquivalentMR =
    finishedEquivalent != null
      ? ok(finishedEquivalent, "units", {
          explanation:
            finalizedRuns === 0
              ? "No finalized production runs for this bag yet."
              : `Produced output of this bag's ${finalizedRuns} finalized run${finalizedRuns === 1 ? "" : "s"} (packaging counts × current product structure × tablets per unit).`,
        })
      : missing(
          "units",
          ["tablets_per_unit"],
          "Run has output but the product's tablets-per-unit is missing — complete product setup",
        );
  const knownLossMR =
    knownLoss != null
      ? ok(knownLoss, "units", {
          explanation: "Sum of damage/rework counters across consuming workflow bags.",
        })
      : ok(0, "units", { explanation: "No damage or rework events recorded." });
  const remainingEstimateMR =
    remainingEstimate != null
      ? ok(remainingEstimate, "units", {
          explanation: `Bag status = ${bag.status}.`,
        })
      : missing("units", ["bag_status"], "Remaining unknown — bag in production or status not set");

  // Vendor variance — needs all 4 inputs.
  const vendorVarianceVal = computeVendorVariance(
    bag.pill_count,
    finishedEquivalent,
    knownLoss,
    remainingEstimate,
  );
  const vendorVarianceQty =
    vendorVarianceVal != null
      ? partial(vendorVarianceVal, "units", {
          missingInputs: [],
          explanation:
            "vendor_declared - finished - known_loss - remaining. Anything non-zero is unaccounted-for.",
        })
      : missing("units", ["vendor_inputs"], "Cannot compute (missing input)");

  const vendorErrPct = computeVendorErrorPercent(vendorVarianceVal, bag.pill_count);
  const vendorErrorPercent =
    vendorErrPct != null
      ? partial(vendorErrPct, "%", {
          missingInputs: [],
          explanation: "Variance ÷ vendor declared × 100.",
        })
      : missing("%", ["vendor_inputs"], "Cannot compute (missing input)");

  const ourVarianceVal = computeVendorVariance(
    estimatedCountValue,
    finishedEquivalent,
    knownLoss,
    remainingEstimate,
  );
  const ourEstimateVarianceQty =
    ourVarianceVal != null
      ? partial(ourVarianceVal, "units", {
          missingInputs: [],
          explanation:
            "our_estimated - finished - known_loss - remaining. Compares our weight-derived count to actual outcome.",
        })
      : missing("units", ["estimate_inputs"], "Cannot compute (missing input)");
  const ourErrPct = computeVendorErrorPercent(ourVarianceVal, estimatedCountValue);
  const ourEstimateErrorPercent =
    ourErrPct != null
      ? partial(ourErrPct, "%", { missingInputs: [], explanation: "Variance ÷ our estimate × 100." })
      : missing("%", ["estimate_inputs"], "Cannot compute (missing input)");

  // Unknown variance is the residual after everything we can account
  // for. By definition it's vendor-anchored (we pay against vendor's
  // declaration), so use the same formula as vendorVarianceVal.
  const unknownVarianceMR =
    vendorVarianceVal != null
      ? partial(vendorVarianceVal, "units", {
          missingInputs: [],
          explanation:
            "Residual after finished + known loss + remaining. Investigate when non-zero.",
        })
      : missing("units", ["accounting_inputs"], "Cannot compute (missing input)");

  const combinedConfidence = combineConfidence([
    vendorDeclaredCount.confidence,
    receivedNetWeightGrams.confidence,
    finishedEquivalentMR.confidence,
    remainingEstimateMR.confidence,
  ]);

  return {
    inventoryBagId: bag.inventory_bag_id,
    workflowBagIds,
    vendorBarcode: bag.vendor_barcode,
    bagNumber: bag.bag_number,
    status: bag.status,
    poId: bag.po_id,
    poNumber: bag.po_number,
    vendorName: bag.vendor_name,
    tabletTypeId: bag.tablet_type_id,
    tabletTypeName: bag.tablet_type_name,
    vendorDeclaredCount,
    receivedNetWeightGrams,
    ourEstimatedCount,
    finishedEquivalentUnits: finishedEquivalentMR,
    knownLossUnits: knownLossMR,
    remainingEstimate: remainingEstimateMR,
    unknownVariance: unknownVarianceMR,
    vendorVarianceQty,
    vendorErrorPercent,
    ourEstimateVarianceQty,
    ourEstimateErrorPercent,
    combinedConfidence,
  };
}

function emptyBagReconciliation(id: string): RawBagReconciliation {
  const m = missing("units", ["inventory_bag"], "Bag not found");
  const w = missing("g", ["inventory_bag"], "Bag not found");
  return {
    inventoryBagId: id,
    workflowBagIds: [],
    vendorBarcode: null,
    bagNumber: null,
    status: "UNKNOWN",
    poId: null,
    poNumber: null,
    vendorName: null,
    tabletTypeId: null,
    tabletTypeName: null,
    vendorDeclaredCount: m,
    receivedNetWeightGrams: w,
    ourEstimatedCount: m,
    finishedEquivalentUnits: m,
    knownLossUnits: m,
    remainingEstimate: m,
    unknownVariance: m,
    vendorVarianceQty: m,
    vendorErrorPercent: missing("%", ["inventory_bag"], "Bag not found"),
    ourEstimateVarianceQty: m,
    ourEstimateErrorPercent: missing("%", ["inventory_bag"], "Bag not found"),
    combinedConfidence: "MISSING",
  };
}

// ─── Per-tablet PO summary lines (RECON-TABLET-SUMMARY-1) ───────
// A single PO can span multiple tablets; the summary shows the PO total
// AND the per-tablet split for bag counts and vendor-declared totals.
// Pure — derived from the already-computed bag breakdown.

export type PoTabletSummaryLine = {
  tabletTypeId: string | null;
  /** Tablet name, or "Unassigned" when the bag has no tablet type. */
  tabletName: string;
  bagsReceived: number;
  /** Sum of vendor-declared counts across this tablet's bags — null when
   *  no bag of this tablet has a declared count (never fabricated 0). */
  vendorDeclared: number | null;
  /** False when some bags of this tablet are missing declared counts. */
  vendorDeclaredComplete: boolean;
};

export function summarizePoTabletBreakdown(
  bags: ReadonlyArray<
    Pick<RawBagReconciliation, "tabletTypeId" | "tabletTypeName" | "vendorDeclaredCount">
  >,
): PoTabletSummaryLine[] {
  const byTablet = new Map<string, PoTabletSummaryLine>();
  for (const b of bags) {
    const key = b.tabletTypeId ?? "__unassigned__";
    const line = byTablet.get(key) ?? {
      tabletTypeId: b.tabletTypeId,
      tabletName: b.tabletTypeName ?? "Unassigned",
      bagsReceived: 0,
      vendorDeclared: null,
      vendorDeclaredComplete: true,
    };
    line.bagsReceived += 1;
    const declared = b.vendorDeclaredCount;
    if (typeof declared.value === "number" && declared.confidence !== "MISSING") {
      line.vendorDeclared = (line.vendorDeclared ?? 0) + declared.value;
    } else {
      line.vendorDeclaredComplete = false;
    }
    byTablet.set(key, line);
  }
  return [...byTablet.values()].sort((a, b) => a.tabletName.localeCompare(b.tabletName));
}

// ─── PO-level reconciliation ───────────────────────────────────

export type PoProductAllocation = {
  productId: string;
  productSku: string;
  productName: string;
  routeCode: string | null;
  rawUnitsConsumed: number;
  finishedUnits: number;
  finishedDisplays: number;
  finishedCases: number;
  damageRework: number;
  yieldPercent: number | null;
};

export type PoCycleTimeline = {
  receivedAt: string | null;
  firstProductionStart: string | null;
  lastProductionEnd: string | null;
  finishedLotsCount: number;
  activeWipBags: number;
};

export type PoSettlement = {
  vendorDeclaredTotal: number | null;
  accountedFinishedOutput: number | null;
  knownLosses: number | null;
  remainingInventory: number | null;
  unknownVariance: number | null;
  suggestedPayable: {
    source: "VENDOR_DECLARED" | "ACCOUNTED_OUTPUT" | "MANUAL_REVIEW";
    value: number | null;
    explanation: string;
  };
};

export type PoReconciliation = {
  poId: string;
  poNumber: string;
  vendorName: string | null;
  status: string;
  rawItemNames: string[];
  bagsReceived: number;
  vendorDeclaredTotal: MetricResult;
  receivedNetWeightTotalGrams: MetricResult;
  internalEstimatedTotal: MetricResult;
  finishedEquivalentTotal: MetricResult;
  knownLossTotal: MetricResult;
  remainingEstimateTotal: MetricResult;
  unknownVariance: MetricResult;
  variancePercent: MetricResult;
  combinedConfidence: Confidence;
  bagBreakdown: ReadonlyArray<RawBagReconciliation>;
  productAllocation: ReadonlyArray<PoProductAllocation>;
  cycleTimeline: PoCycleTimeline;
  settlement: PoSettlement;
};

export async function derivePoRawMaterialReconciliation(
  poId: string,
): Promise<PoReconciliation | null> {
  if (!poId) return null;

  type PoRow = {
    po_id: string;
    po_number: string;
    vendor_name: string | null;
    status: string;
  };
  const poRows = (await db.execute<PoRow>(sql`
    SELECT id::text AS po_id, po_number, vendor_name, status::text
    FROM purchase_orders WHERE id = ${poId} LIMIT 1
  `)) as unknown as PoRow[];
  const po = poRows[0];
  if (!po) return null;

  // All inventory_bags on this PO.
  type IbRow = {
    id: string;
    tablet_type_name: string | null;
  };
  const bagsRows = (await db.execute<IbRow>(sql`
    SELECT ib.id::text, tt.name AS tablet_type_name
    FROM inventory_bags ib
    LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
    LEFT JOIN small_boxes sb  ON sb.id = ib.small_box_id
    LEFT JOIN receives r      ON r.id = sb.receive_id
    WHERE r.po_id = ${poId}
    ORDER BY ib.bag_number
  `)) as unknown as IbRow[];

  // Per-bag reconciliations (sequential for SQL pool friendliness).
  const bagReconciliations: RawBagReconciliation[] = [];
  for (const b of bagsRows) {
    bagReconciliations.push(await deriveRawBagReconciliation(b.id));
  }

  // Aggregate totals — use only the rows where the value is real.
  const sumOrMissing = (
    label: string,
    unit: string,
    field: keyof RawBagReconciliation,
    missingLabel: string,
  ): MetricResult => {
    const present: number[] = [];
    let allMissing = true;
    for (const b of bagReconciliations) {
      const m = b[field] as MetricResult;
      if (m && typeof m.value === "number") {
        present.push(m.value);
        allMissing = false;
      } else if (m && m.confidence !== "MISSING") {
        allMissing = false;
      }
    }
    if (present.length === 0) return missing(unit, [label], missingLabel);
    const sum = present.reduce((a, b) => a + b, 0);
    return allMissing
      ? missing(unit, [label], missingLabel)
      : present.length === bagReconciliations.length
        ? ok(sum, unit, { explanation: `Sum across ${present.length} bag${present.length === 1 ? "" : "s"}.` })
        : partial(sum, unit, {
            missingInputs: [`${present.length}_of_${bagReconciliations.length}_bags`],
            explanation: `Partial sum: ${present.length} of ${bagReconciliations.length} bags had data.`,
          });
  };

  const vendorDeclaredTotal = sumOrMissing(
    "vendor_declared",
    "units",
    "vendorDeclaredCount",
    "No vendor declared counts on PO",
  );
  const receivedNetWeightTotal = sumOrMissing(
    "received_net_weight",
    "g",
    "receivedNetWeightGrams",
    "No received weights on PO",
  );
  const internalEstimatedTotal = sumOrMissing(
    "our_estimated",
    "units",
    "ourEstimatedCount",
    "No internal estimates available",
  );
  const finishedEquivalentTotal = sumOrMissing(
    "finished_equivalent",
    "units",
    "finishedEquivalentUnits",
    "No finished output yet",
  );
  const knownLossTotal = sumOrMissing(
    "known_loss",
    "units",
    "knownLossUnits",
    "No damage/rework recorded",
  );
  const remainingEstimateTotal = sumOrMissing(
    "remaining_estimate",
    "units",
    "remainingEstimate",
    "No remaining estimate",
  );

  // Unknown variance: vendor_declared - finished - known_loss - remaining.
  const unknownVal =
    vendorDeclaredTotal.value != null &&
    finishedEquivalentTotal.value != null &&
    knownLossTotal.value != null &&
    remainingEstimateTotal.value != null
      ? Number(vendorDeclaredTotal.value) -
        Number(finishedEquivalentTotal.value) -
        Number(knownLossTotal.value) -
        Number(remainingEstimateTotal.value)
      : null;
  const unknownVariance =
    unknownVal != null
      ? partial(unknownVal, "units", {
          missingInputs: [],
          explanation:
            "Residual: vendor declared − finished − known loss − remaining. Investigate when non-zero.",
        })
      : missing("units", ["accounting_inputs"], "Cannot compute (one of the inputs is missing)");

  const variancePctVal = computeVendorErrorPercent(
    unknownVal,
    typeof vendorDeclaredTotal.value === "number" ? vendorDeclaredTotal.value : null,
  );
  const variancePercent =
    variancePctVal != null
      ? partial(variancePctVal, "%", { missingInputs: [], explanation: "Unknown variance ÷ vendor declared × 100." })
      : missing("%", ["vendor_declared"], "Cannot compute (missing input)");

  const combinedConfidence = combineConfidence([
    vendorDeclaredTotal.confidence,
    receivedNetWeightTotal.confidence,
    finishedEquivalentTotal.confidence,
    remainingEstimateTotal.confidence,
  ]);

  // Product allocation across bags.
  const productAllocation = await derivePoProductAllocation(poId);

  // Cycle timeline.
  const cycleTimeline = await derivePoProductionCycleReport(poId);

  // Settlement decision.
  const settlement: PoSettlement = (() => {
    const vd = typeof vendorDeclaredTotal.value === "number" ? vendorDeclaredTotal.value : null;
    const fo = typeof finishedEquivalentTotal.value === "number" ? finishedEquivalentTotal.value : null;
    const kl = typeof knownLossTotal.value === "number" ? knownLossTotal.value : null;
    const re = typeof remainingEstimateTotal.value === "number" ? remainingEstimateTotal.value : null;
    const decision = decidePayableQuantity({
      vendorDeclared: vd,
      accountedOutput: fo,
      knownLoss: kl,
      remainingEstimate: re,
      confidence: combinedConfidence,
    });
    return {
      vendorDeclaredTotal: vd,
      accountedFinishedOutput: fo,
      knownLosses: kl,
      remainingInventory: re,
      unknownVariance: unknownVal,
      suggestedPayable: decision,
    };
  })();

  // Distinct raw item names + opened_at as the "received" date proxy.
  const rawItemNames = Array.from(
    new Set(bagsRows.map((b) => b.tablet_type_name).filter((n): n is string => n != null)),
  );

  return {
    poId: po.po_id,
    poNumber: po.po_number,
    vendorName: po.vendor_name,
    status: po.status,
    rawItemNames,
    bagsReceived: bagsRows.length,
    vendorDeclaredTotal,
    receivedNetWeightTotalGrams: receivedNetWeightTotal,
    internalEstimatedTotal,
    finishedEquivalentTotal,
    knownLossTotal,
    remainingEstimateTotal,
    unknownVariance,
    variancePercent,
    combinedConfidence,
    bagBreakdown: bagReconciliations,
    productAllocation,
    cycleTimeline,
    settlement,
  };
}

// ─── Product / route allocation ────────────────────────────────

export async function derivePoProductAllocation(
  poId: string,
): Promise<PoProductAllocation[]> {
  type Row = {
    product_id: string;
    product_sku: string;
    product_name: string;
    route_code: string | null;
    raw_units_consumed: number;
    finished_units: number;
    finished_displays: number;
    finished_cases: number;
    damage_rework: number;
  };
  const rows = (await db.execute<Row>(sql`
    WITH bag_set AS (
      SELECT ib.id, ib.batch_id
      FROM inventory_bags ib
      JOIN small_boxes sb ON sb.id = ib.small_box_id
      JOIN receives r     ON r.id = sb.receive_id
      WHERE r.po_id = ${poId}
    ),
    finished AS (
      SELECT
        fl.product_id,
        SUM(fli.qty_consumed)::int AS raw_units_consumed,
        SUM(fl.units_produced)::int AS finished_units,
        SUM(COALESCE(fl.displays_produced, 0))::int AS finished_displays,
        SUM(COALESCE(fl.cases_produced, 0))::int AS finished_cases
      FROM finished_lot_inputs fli
      JOIN finished_lots fl ON fl.id = fli.finished_lot_id
      WHERE fli.batch_id IN (SELECT batch_id FROM bag_set WHERE batch_id IS NOT NULL)
      GROUP BY fl.product_id
    ),
    damage AS (
      SELECT
        wb.product_id,
        SUM(
          COALESCE(NULLIF((we.payload->>'damaged_count'),'')::int,
                   NULLIF((we.payload->>'rework_count'),'')::int,
                   NULLIF((we.payload->>'count'),'')::int)
        )::int AS damage_rework
      FROM workflow_bags wb
      JOIN workflow_events we ON we.workflow_bag_id = wb.id
      WHERE wb.inventory_bag_id IN (SELECT id FROM bag_set)
        AND we.event_type::text IN ('PACKAGING_DAMAGE_RETURN','BAG_PAUSED')
      GROUP BY wb.product_id
    )
    SELECT
      p.id::text                                AS product_id,
      p.sku                                     AS product_sku,
      p.name                                    AS product_name,
      pr.code                                   AS route_code,
      COALESCE(f.raw_units_consumed, 0)         AS raw_units_consumed,
      COALESCE(f.finished_units, 0)             AS finished_units,
      COALESCE(f.finished_displays, 0)          AS finished_displays,
      COALESCE(f.finished_cases, 0)             AS finished_cases,
      COALESCE(d.damage_rework, 0)              AS damage_rework
    FROM products p
    LEFT JOIN finished f ON f.product_id = p.id
    LEFT JOIN damage d   ON d.product_id = p.id
    LEFT JOIN product_route_assignments pra
      ON pra.product_id = p.id AND pra.is_default = true AND pra.is_active = true
    LEFT JOIN production_routes pr ON pr.id = pra.route_id
    WHERE COALESCE(f.raw_units_consumed, 0) > 0 OR COALESCE(d.damage_rework, 0) > 0
    ORDER BY p.name
  `)) as unknown as Row[];

  return rows.map((r) => ({
    productId: r.product_id,
    productSku: r.product_sku,
    productName: r.product_name,
    routeCode: r.route_code,
    rawUnitsConsumed: r.raw_units_consumed,
    finishedUnits: r.finished_units,
    finishedDisplays: r.finished_displays,
    finishedCases: r.finished_cases,
    damageRework: r.damage_rework,
    yieldPercent:
      r.raw_units_consumed > 0
        ? (r.finished_units / r.raw_units_consumed) * 100
        : null,
  }));
}

// ─── Production cycle timeline ─────────────────────────────────

export async function derivePoProductionCycleReport(
  poId: string,
): Promise<PoCycleTimeline> {
  type Row = {
    received_at: string | null;
    first_start: string | null;
    last_end: string | null;
    finished_lots: number;
    active_wip: number;
  };
  const rows = (await db.execute<Row>(sql`
    WITH bag_set AS (
      SELECT ib.id, ib.batch_id
      FROM inventory_bags ib
      JOIN small_boxes sb ON sb.id = ib.small_box_id
      JOIN receives r     ON r.id = sb.receive_id
      WHERE r.po_id = ${poId}
    )
    SELECT
      (SELECT MIN(r.received_at)::text FROM receives r WHERE r.po_id = ${poId}) AS received_at,
      (SELECT MIN(wb.started_at)::text
         FROM workflow_bags wb WHERE wb.inventory_bag_id IN (SELECT id FROM bag_set)) AS first_start,
      (SELECT MAX(wb.finalized_at)::text
         FROM workflow_bags wb WHERE wb.inventory_bag_id IN (SELECT id FROM bag_set)) AS last_end,
      (SELECT COUNT(DISTINCT fl.id)::int
         FROM finished_lots fl
         JOIN finished_lot_inputs fli ON fli.finished_lot_id = fl.id
         WHERE fli.batch_id IN (SELECT batch_id FROM bag_set WHERE batch_id IS NOT NULL)) AS finished_lots,
      (SELECT COUNT(*)::int
         FROM workflow_bags wb
         WHERE wb.inventory_bag_id IN (SELECT id FROM bag_set) AND wb.finalized_at IS NULL) AS active_wip
  `)) as unknown as Row[];
  const r = rows[0] ?? {
    received_at: null,
    first_start: null,
    last_end: null,
    finished_lots: 0,
    active_wip: 0,
  };
  return {
    receivedAt: r.received_at,
    firstProductionStart: r.first_start,
    lastProductionEnd: r.last_end,
    finishedLotsCount: r.finished_lots,
    activeWipBags: r.active_wip,
  };
}

// ─── Supplier analytics ───────────────────────────────────────

export type VendorAccuracySample = {
  poId: string;
  poNumber: string;
  vendorName: string | null;
  vendorDeclared: number;
  accountedTotal: number;
  variancePercent: number;
  confidence: Confidence;
};

/** Roll-up of vendor count accuracy per PO. Caller passes a date
 *  range; rows are limited to POs received within that range. */
export async function deriveVendorCountAccuracy(input: {
  startDate?: string;
  endDate?: string;
}): Promise<VendorAccuracySample[]> {
  type Row = {
    po_id: string;
    po_number: string;
    vendor_name: string | null;
  };
  const start = input.startDate ?? "2000-01-01";
  const end = input.endDate ?? "9999-12-31";
  const ids = (await db.execute<Row>(sql`
    SELECT DISTINCT po.id::text AS po_id, po.po_number, po.vendor_name
    FROM purchase_orders po
    JOIN receives r ON r.po_id = po.id
    WHERE r.received_at >= ${start}::date
      AND r.received_at < (${end}::date + INTERVAL '1 day')
    ORDER BY po.po_number
    LIMIT 200
  `)) as unknown as Row[];

  const out: VendorAccuracySample[] = [];
  for (const id of ids) {
    const recon = await derivePoRawMaterialReconciliation(id.po_id);
    if (!recon) continue;
    const vd = typeof recon.vendorDeclaredTotal.value === "number" ? recon.vendorDeclaredTotal.value : null;
    const fo = typeof recon.finishedEquivalentTotal.value === "number" ? recon.finishedEquivalentTotal.value : 0;
    const kl = typeof recon.knownLossTotal.value === "number" ? recon.knownLossTotal.value : 0;
    const re = typeof recon.remainingEstimateTotal.value === "number" ? recon.remainingEstimateTotal.value : 0;
    if (vd == null || vd <= 0) continue;
    const accounted = fo + kl + re;
    const pct = ((vd - accounted) / vd) * 100;
    out.push({
      poId: id.po_id,
      poNumber: id.po_number,
      vendorName: id.vendor_name,
      vendorDeclared: vd,
      accountedTotal: accounted,
      variancePercent: pct,
      confidence: recon.combinedConfidence,
    });
  }
  return out;
}

export type RawItemYieldSample = {
  vendorName: string | null;
  tabletTypeName: string;
  rawUnitsIn: number;
  finishedUnits: number;
  yieldPercent: number;
  confidence: Confidence;
};

/** Per-supplier-by-raw-item yield over a date range. Joins finished
 *  output to the originating PO via the batch chain. */
export async function deriveRawItemYieldBySupplier(input: {
  startDate?: string;
  endDate?: string;
}): Promise<RawItemYieldSample[]> {
  const start = input.startDate ?? "2000-01-01";
  const end = input.endDate ?? "9999-12-31";
  type Row = {
    vendor_name: string | null;
    tablet_type_name: string;
    raw_in: number;
    finished_units: number;
  };
  const rows = (await db.execute<Row>(sql`
    SELECT
      po.vendor_name                                      AS vendor_name,
      tt.name                                             AS tablet_type_name,
      SUM(COALESCE(ib.pill_count,0))::int                  AS raw_in,
      COALESCE(SUM(fl.units_produced),0)::int              AS finished_units
    FROM purchase_orders po
    JOIN receives r          ON r.po_id = po.id
    JOIN small_boxes sb      ON sb.receive_id = r.id
    JOIN inventory_bags ib   ON ib.small_box_id = sb.id
    JOIN tablet_types tt     ON tt.id = ib.tablet_type_id
    LEFT JOIN finished_lot_inputs fli ON fli.batch_id = ib.batch_id
    LEFT JOIN finished_lots fl ON fl.id = fli.finished_lot_id
    WHERE r.received_at >= ${start}::date
      AND r.received_at < (${end}::date + INTERVAL '1 day')
    GROUP BY po.vendor_name, tt.name
    HAVING SUM(COALESCE(ib.pill_count,0)) > 0
    ORDER BY po.vendor_name, tt.name
  `)) as unknown as Row[];

  return rows.map((r) => ({
    vendorName: r.vendor_name,
    tabletTypeName: r.tablet_type_name,
    rawUnitsIn: r.raw_in,
    finishedUnits: r.finished_units,
    yieldPercent: r.raw_in > 0 ? (r.finished_units / r.raw_in) * 100 : 0,
    confidence: r.finished_units > 0 ? "HIGH" : "LOW",
  }));
}

/** Convenience for the settlement section (re-exports the shape with
 *  a helpful name). */
export async function deriveSupplierSettlementReport(poId: string): Promise<PoSettlement | null> {
  const recon = await derivePoRawMaterialReconciliation(poId);
  return recon ? recon.settlement : null;
}

// ── P3-PO-VIEW · Production Output PO comparison ────────────────────
//
// Per tablet line on a PO: ordered vs received vs produced (finished
// lots) vs remaining, for the Production Output page's PO-centric
// view. Drill-down to lots/receipts/bags lives on /po-reconciliation.

export type PoOutputComparisonLine = {
  poLineId: string;
  tabletTypeId: string;
  tabletName: string;
  qtyOrdered: number;
  qtyReceived: number;
  rawConsumed: number;
  finishedUnits: number;
  remainingToReceive: number;
  unproducedOnHand: number;
  state: "matched" | "short" | "over" | "in_progress";
};

export async function derivePoOutputComparison(
  poId: string,
): Promise<PoOutputComparisonLine[]> {
  type Row = {
    po_line_id: string;
    tablet_type_id: string;
    tablet_name: string;
    qty_ordered: number;
    qty_received: number;
    raw_consumed: number;
    finished_units: number;
  };
  const rows = (await db.execute<Row>(sql`
    WITH bag_set AS (
      SELECT ib.id, ib.tablet_type_id,
             COALESCE(ib.declared_pill_count, ib.pill_count, 0)::int AS received_count
      FROM inventory_bags ib
      JOIN small_boxes sb ON sb.id = ib.small_box_id
      JOIN receives r     ON r.id = sb.receive_id
      WHERE r.po_id = ${poId}
    ),
    received AS (
      SELECT tablet_type_id, SUM(received_count)::int AS qty_received
      FROM bag_set GROUP BY tablet_type_id
    ),
    consumed AS (
      SELECT bs.tablet_type_id, SUM(COALESCE(s.consumed_qty, 0))::int AS raw_consumed
      FROM raw_bag_allocation_sessions s
      JOIN bag_set bs ON bs.id = s.inventory_bag_id
      WHERE s.allocation_status IN ('CLOSED','DEPLETED','RETURNED_TO_STOCK')
      GROUP BY bs.tablet_type_id
    ),
    produced AS (
      SELECT bs.tablet_type_id, SUM(COALESCE(fl.units_produced, 0))::int AS finished_units
      FROM finished_lots fl
      JOIN workflow_bags wb ON wb.id = fl.workflow_bag_id
      JOIN bag_set bs ON bs.id = wb.inventory_bag_id
      WHERE fl.status NOT IN ('RECALLED')
      GROUP BY bs.tablet_type_id
    )
    SELECT
      pl.id::text              AS po_line_id,
      pl.tablet_type_id::text  AS tablet_type_id,
      tt.name                  AS tablet_name,
      pl.qty_ordered           AS qty_ordered,
      COALESCE(rcv.qty_received, 0)  AS qty_received,
      COALESCE(c.raw_consumed, 0)    AS raw_consumed,
      COALESCE(p.finished_units, 0)  AS finished_units
    FROM po_lines pl
    JOIN tablet_types tt ON tt.id = pl.tablet_type_id
    LEFT JOIN received rcv ON rcv.tablet_type_id = pl.tablet_type_id
    LEFT JOIN consumed c   ON c.tablet_type_id = pl.tablet_type_id
    LEFT JOIN produced p   ON p.tablet_type_id = pl.tablet_type_id
    WHERE pl.po_id = ${poId} AND pl.tablet_type_id IS NOT NULL
    ORDER BY tt.name
  `)) as unknown as Row[];

  return rows.map((r) => {
    const remainingToReceive = Math.max(0, r.qty_ordered - r.qty_received);
    const unproducedOnHand = Math.max(0, r.qty_received - r.raw_consumed);
    // Discrepancy classification on the receive side (the commercial
    // promise): short = under-received, over = over-received, matched
    // when received covers ordered and consumption caught up.
    let state: PoOutputComparisonLine["state"];
    if (r.qty_received > r.qty_ordered) state = "over";
    else if (remainingToReceive > 0) state = "short";
    else if (unproducedOnHand > 0) state = "in_progress";
    else state = "matched";
    return {
      poLineId: r.po_line_id,
      tabletTypeId: r.tablet_type_id,
      tabletName: r.tablet_name,
      qtyOrdered: r.qty_ordered,
      qtyReceived: r.qty_received,
      rawConsumed: r.raw_consumed,
      finishedUnits: r.finished_units,
      remainingToReceive,
      unproducedOnHand,
      state,
    };
  });
}
