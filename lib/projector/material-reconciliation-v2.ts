// PT-6C — Reconciliation v2 input assembler + projector.
//
// Pulls live DB inputs for one packaging_lot, hands them to the pure
// PT-6B helpers, and persists the result into
// read_material_reconciliation_v2. Coexists with the legacy v1
// read_material_reconciliation projector — neither writes to the
// other's table.
//
// Idempotent: a single upsert keyed on (scope_type, scope_id).
// Re-running the rebuilder on an unchanged lot leaves the row's
// values identical (calculated_at + updated_at refresh).

import { and, desc, eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  materialInventoryEvents,
  packagingLots,
  packagingMaterials,
  readMaterialLotState,
  readMaterialReconciliationV2,
} from "@/lib/db/schema";

import {
  deriveReconciliationResult,
  type ActualConsumptionSource,
  type EstimatedConsumptionSource,
  type OnHandSource,
  type ReceiptSourceSystem,
  type ReconciliationInput,
  type ReconciliationQuantity,
  type ReconciliationResult,
  type ReconciliationVariance,
  type VarianceKind,
} from "@/lib/production/reconciliation-v2";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Per-lot input assembler. Reads packaging_lots, the matching
 *  packaging_materials row, read_material_lot_state, and the most
 *  recent cycle-count event in the lot's history. Returns a
 *  ReconciliationInput shaped exactly the way PT-6B expects, plus a
 *  metadata bag describing scope_type / scope_id / unit lineage. */
export async function buildPackagingLotReconciliationInput(
  tx: Tx,
  lotId: string,
): Promise<{
  scopeType: "PACKAGING_LOT" | "ROLL";
  scopeId: string;
  packagingLotId: string;
  materialItemId: string;
  poId: string | null;
  productId: string | null;
  unit: string;
  input: ReconciliationInput;
  sourceSnapshot: Record<string, unknown>;
} | null> {
  const [row] = await tx
    .select({
      lot: packagingLots,
      mat: packagingMaterials,
    })
    .from(packagingLots)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, packagingLots.packagingMaterialId),
    )
    .where(eq(packagingLots.id, lotId));
  if (!row) return null;
  const lot = row.lot;
  const mat = row.mat;

  // The unit and reconciliation mode is DATA-DRIVEN, not driven by
  // the material's kind. A roll material received with net_weight_
  // grams reconciles in grams; the same kind received via a PackTrack
  // count receipt reconciles in `each`. This is honest: the buckets
  // report whichever measurement Luma actually has.
  const materialKindIsRoll = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(
    mat.kind,
  );
  const hasWeight = lot.netWeightGrams != null;
  const hasCounts =
    lot.declaredQuantity != null ||
    lot.countedQuantity != null ||
    // qtyReceived === 1 on a roll-kind lot is the placeholder; ignore
    // it for count-based detection.
    (lot.qtyReceived != null &&
      !(materialKindIsRoll && lot.qtyReceived === 1));
  const useWeightMode = hasWeight && !hasCounts;
  // scope_type still reflects the lot's material classification — UI
  // filters by ROLL vs PACKAGING_LOT — but the unit is per-row.
  const scopeType = materialKindIsRoll ? "ROLL" : "PACKAGING_LOT";
  const unit = useWeightMode ? "g" : "each";

  // Receipt inputs come straight off the packaging_lots row.
  // For COUNT-BASED packaging: declared/counted/qty_received are the
  // direct ACCEPTED inputs. qtyReceivedLegacy fires only when neither
  // declared nor counted is filled.
  // For ROLL lots: weight is the unit. The roll-receive form stores
  // qty_received=1 as a placeholder (one roll), which is meaningless
  // when ACCEPTED is in grams. The honest mapping is:
  //   - declared_quantity: null (rolls don't have a separate declared
  //     vs counted weight at receipt)
  //   - counted_quantity:  net_weight_grams (HIGH when net came from
  //     gross-tare or was entered directly)
  //   - qtyReceivedLegacy: null (the placeholder 1 must NOT drive
  //     ACCEPTED in grams)
  let receiptDeclared: number | null = null;
  let receiptCounted: number | null = null;
  let qtyReceivedLegacy: number | null = null;
  if (useWeightMode) {
    // Weight-based: declared null (rolls don't have a declared-vs-
    // counted shape at receipt), counted = net_weight_grams (HIGH).
    receiptDeclared = null;
    receiptCounted = lot.netWeightGrams ?? null;
  } else {
    // Count-based: trust declared/counted as-is. qtyReceived is a
    // legacy fallback only when neither declared nor counted is set
    // AND the value isn't the roll-placeholder 1.
    receiptDeclared = lot.declaredQuantity ?? null;
    receiptCounted = lot.countedQuantity ?? null;
    if (
      lot.declaredQuantity == null &&
      lot.countedQuantity == null &&
      !(materialKindIsRoll && lot.qtyReceived === 1)
    ) {
      qtyReceivedLegacy = lot.qtyReceived;
    }
  }

  // Consumption signals come from read_material_lot_state, which is
  // maintained by the H.x4 / H.x3 projector hooks. estimated reads
  // segment-ledger × standard for rolls; for count-based packaging
  // it's empty until the QC subsystem ships an explicit consumption
  // event, in which case we leave it null and the helper reports
  // CONSUMED_ESTIMATED MISSING honestly.
  const [state] = await tx
    .select({
      consumedEstimated: readMaterialLotState.consumedEstimated,
      consumedActual: readMaterialLotState.consumedActual,
      currentWeightGramsEstimate: readMaterialLotState.currentWeightGramsEstimate,
      currentQuantityEstimate: readMaterialLotState.currentQuantityEstimate,
    })
    .from(readMaterialLotState)
    .where(eq(readMaterialLotState.packagingLotId, lotId));

  // Estimated-consumption source name follows the unit. Rolls in
  // grams use the segment-ledger × standard math; count-based lots
  // use BOM × output. The lot's material kind is the better proxy
  // here because consumed_estimated lives in read_material_lot_state
  // and that table's source code follows kind, not per-lot mode.
  const estimatedSource: EstimatedConsumptionSource = materialKindIsRoll
    ? "ROLL_SEGMENT_STANDARD"
    : "BOM";
  const consumedEstimated =
    state?.consumedEstimated != null && state.consumedEstimated !== 0
      ? { value: state.consumedEstimated, source: estimatedSource }
      : null;

  // For actual consumption we look at the latest weigh-back / depletion
  // event on the lot. Both are emitted as material_inventory_events
  // with a recognisable event_type. WEIGH_BACK gives us a HIGH-quality
  // signal; DEPLETION_YIELD is MEDIUM (segment-derived final yield).
  const [latestWeigh] = await tx
    .select({
      eventType: materialInventoryEvents.eventType,
      quantityGrams: materialInventoryEvents.quantityGrams,
      occurredAt: materialInventoryEvents.occurredAt,
    })
    .from(materialInventoryEvents)
    .where(
      and(
        eq(materialInventoryEvents.packagingLotId, lotId),
        sql`${materialInventoryEvents.eventType} IN ('ROLL_WEIGHED', 'ROLL_DEPLETED', 'MATERIAL_CONSUMED_ACTUAL')`,
      ),
    )
    .orderBy(desc(materialInventoryEvents.occurredAt))
    .limit(1);
  let consumedActual: { value: number; source: ActualConsumptionSource } | null = null;
  if (state?.consumedActual != null && state.consumedActual !== 0) {
    // read_material_lot_state already collapses the ledger; trust its
    // value but tag the source from the latest event so the UI can
    // explain provenance.
    let actualSource: ActualConsumptionSource = "WEIGH_BACK";
    if (latestWeigh?.eventType === "ROLL_DEPLETED") actualSource = "DEPLETION_YIELD";
    else if (latestWeigh?.eventType === "MATERIAL_CONSUMED_ACTUAL") actualSource = "MANUAL_ENTRY";
    consumedActual = { value: state.consumedActual, source: actualSource };
  }

  // Most recent cycle-count adjustment in the lot's history. We use
  // the ADJUSTED event's payload (stamped by adjustPackagingLotAction
  // in PT-4D) to surface the operator's physical count.
  const [latestAdjust] = await tx
    .select({
      payload: materialInventoryEvents.payload,
      occurredAt: materialInventoryEvents.occurredAt,
    })
    .from(materialInventoryEvents)
    .where(
      and(
        eq(materialInventoryEvents.packagingLotId, lotId),
        eq(materialInventoryEvents.eventType, "PACKAGING_RECEIPT_ADJUSTED"),
      ),
    )
    .orderBy(desc(materialInventoryEvents.occurredAt))
    .limit(1);
  const adjustPayload = (latestAdjust?.payload ?? {}) as Record<string, unknown>;
  const cycleCountActualRemaining =
    typeof adjustPayload["new_qty_on_hand"] === "number"
      ? (adjustPayload["new_qty_on_hand"] as number)
      : null;

  // ON_HAND follows the same data-driven mode the receipt section
  // chose. Weight-mode reads current_weight_grams_estimate; count-
  // mode reads qty_on_hand. A recent cycle count on a count-mode lot
  // upgrades the source from QTY_ON_HAND (MEDIUM) to CYCLE_COUNT (HIGH).
  const onHandQty = useWeightMode
    ? lot.currentWeightGramsEstimate ?? null
    : lot.qtyOnHand;
  let onHandSource: OnHandSource = "QTY_ON_HAND";
  if (useWeightMode) {
    onHandSource = "WEIGH_BACK_DERIVED";
  } else if (cycleCountActualRemaining != null) {
    onHandSource = "CYCLE_COUNT";
  }

  const sourceSystem = (lot.sourceSystem ?? null) as
    | ReceiptSourceSystem
    | null;

  const input: ReconciliationInput = {
    unit,
    receipt: {
      declaredQuantity: receiptDeclared,
      countedQuantity: receiptCounted,
      qtyReceivedLegacy,
      sourceSystem,
    },
    consumption: {
      estimated: consumedEstimated,
      actual: consumedActual,
    },
    inventory: {
      onHandQty,
      onHandSource,
      cycleCountActualRemaining,
    },
    // Scrap remains MISSING until the QC subsystem ships explicit
    // raw-material scrap events. The helper's missing-data branch
    // pushes the QC-deferral warning into result.warnings.
    scrap: null,
  };

  const sourceSnapshot: Record<string, unknown> = {
    packaging_lot_id: lot.id,
    packaging_material_id: lot.packagingMaterialId,
    material_kind: mat.kind,
    material_kind_is_roll: materialKindIsRoll,
    use_weight_mode: useWeightMode,
    source_system: lot.sourceSystem ?? null,
    declared_quantity: lot.declaredQuantity ?? null,
    counted_quantity: lot.countedQuantity ?? null,
    accepted_quantity: lot.acceptedQuantity ?? null,
    qty_received: lot.qtyReceived,
    qty_on_hand: lot.qtyOnHand,
    current_weight_grams_estimate: lot.currentWeightGramsEstimate ?? null,
    consumed_estimated_state: state?.consumedEstimated ?? null,
    consumed_actual_state: state?.consumedActual ?? null,
    latest_adjust_at: latestAdjust?.occurredAt ?? null,
    latest_weigh_at: latestWeigh?.occurredAt ?? null,
  };

  return {
    scopeType,
    scopeId: lot.id,
    packagingLotId: lot.id,
    materialItemId: lot.packagingMaterialId,
    poId: lot.poId ?? null,
    productId: null,
    unit,
    input,
    sourceSnapshot,
  };
}

/** Helper: format a JS number for the numeric(20,6) column without
 *  losing precision on the way through the postgres-js wire format. */
function fmt(value: number | null): string | null {
  if (value == null) return null;
  return value.toString();
}

function quantityRow(q: ReconciliationQuantity): {
  value: string | null;
  confidence: string;
  source: string | null;
  missingInputs: unknown;
} {
  return {
    value: fmt(q.value),
    confidence: q.confidence,
    source: q.source,
    missingInputs: q.missingInputs,
  };
}

function variance(result: ReconciliationResult, kind: VarianceKind): ReconciliationVariance {
  const found = result.variances.find((v) => v.kind === kind);
  if (!found) {
    // Should never happen — deriveReconciliationResult always populates
    // all four. But TypeScript wants a non-undefined value, so we
    // return a MISSING fallback.
    return {
      kind,
      value: null,
      unit: null,
      confidence: "MISSING",
      severity: "MISSING",
      explanation: "",
      missingInputs: [],
    };
  }
  return found;
}

/** Compute + persist v2 reconciliation for one packaging_lot.
 *  Idempotent: ON CONFLICT (scope_type, scope_id) updates in place.
 *  Returns the scope id on success, null if the lot was not found. */
export async function rebuildMaterialReconciliationV2ForLot(
  tx: Tx,
  lotId: string,
): Promise<string | null> {
  const assembled = await buildPackagingLotReconciliationInput(tx, lotId);
  if (!assembled) return null;
  const result = deriveReconciliationResult(assembled.input);
  await upsertReconciliationV2Row(tx, {
    scopeType: assembled.scopeType,
    scopeId: assembled.scopeId,
    materialItemId: assembled.materialItemId,
    packagingLotId: assembled.packagingLotId,
    rawBagId: null,
    poId: assembled.poId,
    productId: assembled.productId,
    unit: assembled.unit,
    result,
    sourceSnapshot: assembled.sourceSnapshot,
  });
  return assembled.scopeId;
}

/** Full rebuild over every packaging_lot. Iterates one lot at a time
 *  so the projector touches a bounded number of rows per upsert. */
export async function rebuildMaterialReconciliationV2(tx: Tx): Promise<{
  scanned: number;
  written: number;
}> {
  const lots = await tx
    .select({ id: packagingLots.id })
    .from(packagingLots);
  let written = 0;
  for (const { id } of lots) {
    const r = await rebuildMaterialReconciliationV2ForLot(tx, id);
    if (r) written++;
  }
  return { scanned: lots.length, written };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal — the upsert SQL
// ─────────────────────────────────────────────────────────────────────────────

async function upsertReconciliationV2Row(
  tx: Tx,
  args: {
    scopeType: "PACKAGING_LOT" | "ROLL" | "RAW_BAG" | "MATERIAL_ITEM" | "PO";
    scopeId: string;
    materialItemId: string | null;
    packagingLotId: string | null;
    rawBagId: string | null;
    poId: string | null;
    productId: string | null;
    unit: string;
    result: ReconciliationResult;
    sourceSnapshot: Record<string, unknown>;
  },
): Promise<void> {
  const r = args.result;
  const declared = quantityRow(r.declared);
  const counted = quantityRow(r.counted);
  const accepted = quantityRow(r.accepted);
  const consumedEstimated = quantityRow(r.consumedEstimated);
  const consumedActual = quantityRow(r.consumedActual);
  const scrappedOrDamaged = quantityRow(r.scrappedOrDamaged);
  const onHand = quantityRow(r.onHand);
  const recv = variance(r, "RECEIPT_VARIANCE");
  const cycle = variance(r, "CYCLE_COUNT_VARIANCE");
  const consVar = variance(r, "CONSUMPTION_VARIANCE");
  const unknown = variance(r, "UNKNOWN_VARIANCE");

  await tx
    .insert(readMaterialReconciliationV2)
    .values({
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      materialItemId: args.materialItemId,
      packagingLotId: args.packagingLotId,
      rawBagId: args.rawBagId,
      poId: args.poId,
      productId: args.productId,
      unitOfMeasure: args.unit,
      declaredValue: declared.value,
      declaredConfidence: declared.confidence,
      declaredSource: declared.source,
      declaredMissingInputs: declared.missingInputs,
      countedValue: counted.value,
      countedConfidence: counted.confidence,
      countedSource: counted.source,
      countedMissingInputs: counted.missingInputs,
      acceptedValue: accepted.value,
      acceptedConfidence: accepted.confidence,
      acceptedSource: accepted.source,
      acceptedMissingInputs: accepted.missingInputs,
      consumedEstimatedValue: consumedEstimated.value,
      consumedEstimatedConfidence: consumedEstimated.confidence,
      consumedEstimatedSource: consumedEstimated.source,
      consumedEstimatedMissingInputs: consumedEstimated.missingInputs,
      consumedActualValue: consumedActual.value,
      consumedActualConfidence: consumedActual.confidence,
      consumedActualSource: consumedActual.source,
      consumedActualMissingInputs: consumedActual.missingInputs,
      scrappedOrDamagedValue: scrappedOrDamaged.value,
      scrappedOrDamagedConfidence: scrappedOrDamaged.confidence,
      scrappedOrDamagedSource: scrappedOrDamaged.source,
      scrappedOrDamagedMissingInputs: scrappedOrDamaged.missingInputs,
      onHandValue: onHand.value,
      onHandConfidence: onHand.confidence,
      onHandSource: onHand.source,
      onHandMissingInputs: onHand.missingInputs,
      receiptVarianceValue: fmt(recv.value),
      receiptVarianceConfidence: recv.confidence,
      receiptVarianceSeverity: recv.severity,
      cycleCountVarianceValue: fmt(cycle.value),
      cycleCountVarianceConfidence: cycle.confidence,
      cycleCountVarianceSeverity: cycle.severity,
      consumptionVarianceValue: fmt(consVar.value),
      consumptionVarianceConfidence: consVar.confidence,
      consumptionVarianceSeverity: consVar.severity,
      unknownVarianceValue: fmt(unknown.value),
      unknownVarianceConfidence: unknown.confidence,
      unknownVarianceSeverity: unknown.severity,
      overallConfidence: r.overallConfidence,
      warnings: r.warnings,
      sourceSnapshot: args.sourceSnapshot,
      calculatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        readMaterialReconciliationV2.scopeType,
        readMaterialReconciliationV2.scopeId,
      ],
      set: {
        materialItemId: args.materialItemId,
        packagingLotId: args.packagingLotId,
        rawBagId: args.rawBagId,
        poId: args.poId,
        productId: args.productId,
        unitOfMeasure: args.unit,
        declaredValue: declared.value,
        declaredConfidence: declared.confidence,
        declaredSource: declared.source,
        declaredMissingInputs: declared.missingInputs,
        countedValue: counted.value,
        countedConfidence: counted.confidence,
        countedSource: counted.source,
        countedMissingInputs: counted.missingInputs,
        acceptedValue: accepted.value,
        acceptedConfidence: accepted.confidence,
        acceptedSource: accepted.source,
        acceptedMissingInputs: accepted.missingInputs,
        consumedEstimatedValue: consumedEstimated.value,
        consumedEstimatedConfidence: consumedEstimated.confidence,
        consumedEstimatedSource: consumedEstimated.source,
        consumedEstimatedMissingInputs: consumedEstimated.missingInputs,
        consumedActualValue: consumedActual.value,
        consumedActualConfidence: consumedActual.confidence,
        consumedActualSource: consumedActual.source,
        consumedActualMissingInputs: consumedActual.missingInputs,
        scrappedOrDamagedValue: scrappedOrDamaged.value,
        scrappedOrDamagedConfidence: scrappedOrDamaged.confidence,
        scrappedOrDamagedSource: scrappedOrDamaged.source,
        scrappedOrDamagedMissingInputs: scrappedOrDamaged.missingInputs,
        onHandValue: onHand.value,
        onHandConfidence: onHand.confidence,
        onHandSource: onHand.source,
        onHandMissingInputs: onHand.missingInputs,
        receiptVarianceValue: fmt(recv.value),
        receiptVarianceConfidence: recv.confidence,
        receiptVarianceSeverity: recv.severity,
        cycleCountVarianceValue: fmt(cycle.value),
        cycleCountVarianceConfidence: cycle.confidence,
        cycleCountVarianceSeverity: cycle.severity,
        consumptionVarianceValue: fmt(consVar.value),
        consumptionVarianceConfidence: consVar.confidence,
        consumptionVarianceSeverity: consVar.severity,
        unknownVarianceValue: fmt(unknown.value),
        unknownVarianceConfidence: unknown.confidence,
        unknownVarianceSeverity: unknown.severity,
        overallConfidence: r.overallConfidence,
        warnings: r.warnings,
        sourceSnapshot: args.sourceSnapshot,
        calculatedAt: new Date(),
        updatedAt: new Date(),
      },
    });
}
