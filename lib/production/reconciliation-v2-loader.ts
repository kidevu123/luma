// PT-6D — Reconciliation v2 page loader.
//
// Pure read of `read_material_reconciliation_v2` joined with
// packaging_materials (for SKU + name) and packaging_lots (for lot
// number + roll number). The math itself lives in PT-6B + PT-6C; the
// loader only formats and filters.
//
// The UI must NOT recompute formulas. This loader returns the row
// already-shaped, including parsed jsonb columns, so the page
// component can drop directly into JSX.

import { and, desc, eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  packagingLots,
  packagingMaterials,
  readMaterialReconciliationV2,
} from "@/lib/db/schema";

import type {
  ReconciliationConfidence,
  VarianceKind,
  VarianceSeverity,
} from "@/lib/production/reconciliation-v2";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export type ReconciliationV2BucketView = {
  value: number | null;
  unit: string;
  confidence: ReconciliationConfidence;
  source: string | null;
  missingInputs: string[];
};

export type ReconciliationV2VarianceView = {
  kind: VarianceKind;
  value: number | null;
  unit: string;
  confidence: ReconciliationConfidence;
  severity: VarianceSeverity;
};

export type ReconciliationV2Row = {
  id: string;
  scopeType: "PACKAGING_LOT" | "RAW_BAG" | "ROLL" | "MATERIAL_ITEM" | "PO";
  scopeId: string;
  packagingLotId: string | null;
  rawBagId: string | null;
  poId: string | null;
  productId: string | null;
  unit: string;
  /** Identity helpers for the UI. */
  materialSku: string | null;
  materialName: string | null;
  materialKind: string | null;
  lotNumber: string | null;
  rollNumber: string | null;
  /** Buckets — 7 typed, plus 4 variances below. */
  declared: ReconciliationV2BucketView;
  counted: ReconciliationV2BucketView;
  accepted: ReconciliationV2BucketView;
  consumedEstimated: ReconciliationV2BucketView;
  consumedActual: ReconciliationV2BucketView;
  scrappedOrDamaged: ReconciliationV2BucketView;
  onHand: ReconciliationV2BucketView;
  /** The four parallel variance subtypes. Keyed by kind. */
  variances: Record<VarianceKind, ReconciliationV2VarianceView>;
  overallConfidence: ReconciliationConfidence;
  warnings: string[];
  sourceSnapshot: Record<string, unknown>;
  calculatedAt: Date;
};

export type ReconciliationV2Filters = {
  scopeType?: "PACKAGING_LOT" | "RAW_BAG" | "ROLL" | "MATERIAL_ITEM" | "PO";
  materialItemId?: string;
  /** Only rows whose overall_confidence matches. */
  confidence?: ReconciliationConfidence;
  /** Only rows with a non-zero variance of this kind. */
  varianceKind?: VarianceKind;
  /** Only rows with this variance severity. */
  varianceSeverity?: VarianceSeverity;
  /** Only rows with at least one non-zero variance bucket. */
  varianceOnly?: boolean;
  /** Only rows with at least one MISSING bucket. */
  missingOnly?: boolean;
  /** Source-system tag from the source_snapshot. */
  sourceSystem?: "PACKTRACK" | "MANUAL_LUMA" | "ZOHO" | "IMPORT";
};

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // numeric(20,6) comes back as string from postgres-js
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function asKind(s: string | null): VarianceKind {
  // narrow text → union; storage layer enforces this is one of the four
  return (s as VarianceKind) ?? "UNKNOWN_VARIANCE";
}

/** Parse a single row from the v2 read model into the view shape. */
function shapeRow(
  raw: typeof readMaterialReconciliationV2.$inferSelect & {
    materialSku: string | null;
    materialName: string | null;
    materialKind: string | null;
    lotNumber: string | null;
    rollNumber: string | null;
  },
): ReconciliationV2Row {
  const unit = raw.unitOfMeasure;

  const bucket = (
    value: unknown,
    confidence: string,
    source: string | null,
    missing: unknown,
  ): ReconciliationV2BucketView => ({
    value: num(value),
    unit,
    confidence: confidence as ReconciliationConfidence,
    source,
    missingInputs: asStringArray(missing),
  });

  const variance = (
    kind: VarianceKind,
    value: unknown,
    confidence: string,
    severity: string,
  ): ReconciliationV2VarianceView => ({
    kind,
    value: num(value),
    unit,
    confidence: confidence as ReconciliationConfidence,
    severity: severity as VarianceSeverity,
  });

  return {
    id: raw.id,
    scopeType: raw.scopeType as ReconciliationV2Row["scopeType"],
    scopeId: raw.scopeId,
    packagingLotId: raw.packagingLotId ?? null,
    rawBagId: raw.rawBagId ?? null,
    poId: raw.poId ?? null,
    productId: raw.productId ?? null,
    unit,
    materialSku: raw.materialSku,
    materialName: raw.materialName,
    materialKind: raw.materialKind,
    lotNumber: raw.lotNumber,
    rollNumber: raw.rollNumber,
    declared: bucket(
      raw.declaredValue,
      raw.declaredConfidence,
      raw.declaredSource,
      raw.declaredMissingInputs,
    ),
    counted: bucket(
      raw.countedValue,
      raw.countedConfidence,
      raw.countedSource,
      raw.countedMissingInputs,
    ),
    accepted: bucket(
      raw.acceptedValue,
      raw.acceptedConfidence,
      raw.acceptedSource,
      raw.acceptedMissingInputs,
    ),
    consumedEstimated: bucket(
      raw.consumedEstimatedValue,
      raw.consumedEstimatedConfidence,
      raw.consumedEstimatedSource,
      raw.consumedEstimatedMissingInputs,
    ),
    consumedActual: bucket(
      raw.consumedActualValue,
      raw.consumedActualConfidence,
      raw.consumedActualSource,
      raw.consumedActualMissingInputs,
    ),
    scrappedOrDamaged: bucket(
      raw.scrappedOrDamagedValue,
      raw.scrappedOrDamagedConfidence,
      raw.scrappedOrDamagedSource,
      raw.scrappedOrDamagedMissingInputs,
    ),
    onHand: bucket(
      raw.onHandValue,
      raw.onHandConfidence,
      raw.onHandSource,
      raw.onHandMissingInputs,
    ),
    variances: {
      RECEIPT_VARIANCE: variance(
        "RECEIPT_VARIANCE",
        raw.receiptVarianceValue,
        raw.receiptVarianceConfidence,
        raw.receiptVarianceSeverity,
      ),
      CYCLE_COUNT_VARIANCE: variance(
        "CYCLE_COUNT_VARIANCE",
        raw.cycleCountVarianceValue,
        raw.cycleCountVarianceConfidence,
        raw.cycleCountVarianceSeverity,
      ),
      CONSUMPTION_VARIANCE: variance(
        "CONSUMPTION_VARIANCE",
        raw.consumptionVarianceValue,
        raw.consumptionVarianceConfidence,
        raw.consumptionVarianceSeverity,
      ),
      UNKNOWN_VARIANCE: variance(
        "UNKNOWN_VARIANCE",
        raw.unknownVarianceValue,
        raw.unknownVarianceConfidence,
        raw.unknownVarianceSeverity,
      ),
    },
    overallConfidence: raw.overallConfidence as ReconciliationConfidence,
    warnings: asStringArray(raw.warnings),
    sourceSnapshot: (raw.sourceSnapshot ?? {}) as Record<string, unknown>,
    calculatedAt: raw.calculatedAt,
  };
}

/** List v2 reconciliation rows joined with material + lot identity.
 *  Filters apply after the join so we can scan source_snapshot for
 *  things like source_system. */
export async function listReconciliationV2Rows(
  tx: Tx,
  filters: ReconciliationV2Filters = {},
): Promise<ReconciliationV2Row[]> {
  const baseConditions = [];
  if (filters.scopeType) {
    baseConditions.push(
      eq(readMaterialReconciliationV2.scopeType, filters.scopeType),
    );
  }
  if (filters.materialItemId) {
    baseConditions.push(
      eq(readMaterialReconciliationV2.materialItemId, filters.materialItemId),
    );
  }
  if (filters.confidence) {
    baseConditions.push(
      eq(readMaterialReconciliationV2.overallConfidence, filters.confidence),
    );
  }

  const rows = await tx
    .select({
      // v2 fields
      id: readMaterialReconciliationV2.id,
      scopeType: readMaterialReconciliationV2.scopeType,
      scopeId: readMaterialReconciliationV2.scopeId,
      materialItemId: readMaterialReconciliationV2.materialItemId,
      packagingLotId: readMaterialReconciliationV2.packagingLotId,
      rawBagId: readMaterialReconciliationV2.rawBagId,
      poId: readMaterialReconciliationV2.poId,
      productId: readMaterialReconciliationV2.productId,
      unitOfMeasure: readMaterialReconciliationV2.unitOfMeasure,
      declaredValue: readMaterialReconciliationV2.declaredValue,
      declaredConfidence: readMaterialReconciliationV2.declaredConfidence,
      declaredSource: readMaterialReconciliationV2.declaredSource,
      declaredMissingInputs: readMaterialReconciliationV2.declaredMissingInputs,
      countedValue: readMaterialReconciliationV2.countedValue,
      countedConfidence: readMaterialReconciliationV2.countedConfidence,
      countedSource: readMaterialReconciliationV2.countedSource,
      countedMissingInputs: readMaterialReconciliationV2.countedMissingInputs,
      acceptedValue: readMaterialReconciliationV2.acceptedValue,
      acceptedConfidence: readMaterialReconciliationV2.acceptedConfidence,
      acceptedSource: readMaterialReconciliationV2.acceptedSource,
      acceptedMissingInputs: readMaterialReconciliationV2.acceptedMissingInputs,
      consumedEstimatedValue: readMaterialReconciliationV2.consumedEstimatedValue,
      consumedEstimatedConfidence:
        readMaterialReconciliationV2.consumedEstimatedConfidence,
      consumedEstimatedSource: readMaterialReconciliationV2.consumedEstimatedSource,
      consumedEstimatedMissingInputs:
        readMaterialReconciliationV2.consumedEstimatedMissingInputs,
      consumedActualValue: readMaterialReconciliationV2.consumedActualValue,
      consumedActualConfidence: readMaterialReconciliationV2.consumedActualConfidence,
      consumedActualSource: readMaterialReconciliationV2.consumedActualSource,
      consumedActualMissingInputs:
        readMaterialReconciliationV2.consumedActualMissingInputs,
      scrappedOrDamagedValue: readMaterialReconciliationV2.scrappedOrDamagedValue,
      scrappedOrDamagedConfidence:
        readMaterialReconciliationV2.scrappedOrDamagedConfidence,
      scrappedOrDamagedSource: readMaterialReconciliationV2.scrappedOrDamagedSource,
      scrappedOrDamagedMissingInputs:
        readMaterialReconciliationV2.scrappedOrDamagedMissingInputs,
      onHandValue: readMaterialReconciliationV2.onHandValue,
      onHandConfidence: readMaterialReconciliationV2.onHandConfidence,
      onHandSource: readMaterialReconciliationV2.onHandSource,
      onHandMissingInputs: readMaterialReconciliationV2.onHandMissingInputs,
      receiptVarianceValue: readMaterialReconciliationV2.receiptVarianceValue,
      receiptVarianceConfidence:
        readMaterialReconciliationV2.receiptVarianceConfidence,
      receiptVarianceSeverity: readMaterialReconciliationV2.receiptVarianceSeverity,
      cycleCountVarianceValue: readMaterialReconciliationV2.cycleCountVarianceValue,
      cycleCountVarianceConfidence:
        readMaterialReconciliationV2.cycleCountVarianceConfidence,
      cycleCountVarianceSeverity:
        readMaterialReconciliationV2.cycleCountVarianceSeverity,
      consumptionVarianceValue: readMaterialReconciliationV2.consumptionVarianceValue,
      consumptionVarianceConfidence:
        readMaterialReconciliationV2.consumptionVarianceConfidence,
      consumptionVarianceSeverity:
        readMaterialReconciliationV2.consumptionVarianceSeverity,
      unknownVarianceValue: readMaterialReconciliationV2.unknownVarianceValue,
      unknownVarianceConfidence:
        readMaterialReconciliationV2.unknownVarianceConfidence,
      unknownVarianceSeverity: readMaterialReconciliationV2.unknownVarianceSeverity,
      overallConfidence: readMaterialReconciliationV2.overallConfidence,
      warnings: readMaterialReconciliationV2.warnings,
      sourceSnapshot: readMaterialReconciliationV2.sourceSnapshot,
      calculatedAt: readMaterialReconciliationV2.calculatedAt,
      createdAt: readMaterialReconciliationV2.createdAt,
      updatedAt: readMaterialReconciliationV2.updatedAt,
      // material identity
      materialSku: packagingMaterials.sku,
      materialName: packagingMaterials.name,
      materialKind: packagingMaterials.kind,
      // lot identity
      lotNumber: packagingLots.supplierLotNumber,
      rollNumber: packagingLots.rollNumber,
    })
    .from(readMaterialReconciliationV2)
    .leftJoin(
      packagingMaterials,
      eq(packagingMaterials.id, readMaterialReconciliationV2.materialItemId),
    )
    .leftJoin(
      packagingLots,
      eq(packagingLots.id, readMaterialReconciliationV2.packagingLotId),
    )
    .where(baseConditions.length > 0 ? and(...baseConditions) : sql`true`)
    .orderBy(desc(readMaterialReconciliationV2.calculatedAt));

  let shaped = rows.map((r) => shapeRow(r));

  // Post-filter for things that aren't directly indexable.
  if (filters.varianceKind) {
    shaped = shaped.filter((row) => {
      const v = row.variances[filters.varianceKind!];
      return v.value !== null && Math.abs(v.value) > 0.0001;
    });
  }
  if (filters.varianceSeverity) {
    shaped = shaped.filter((row) =>
      Object.values(row.variances).some(
        (v) => v.severity === filters.varianceSeverity,
      ),
    );
  }
  if (filters.varianceOnly) {
    shaped = shaped.filter((row) =>
      Object.values(row.variances).some(
        (v) => v.value !== null && Math.abs(v.value) > 0.0001,
      ),
    );
  }
  if (filters.missingOnly) {
    shaped = shaped.filter(
      (row) =>
        row.declared.confidence === "MISSING" ||
        row.counted.confidence === "MISSING" ||
        row.accepted.confidence === "MISSING" ||
        row.consumedEstimated.confidence === "MISSING" ||
        row.consumedActual.confidence === "MISSING" ||
        row.scrappedOrDamaged.confidence === "MISSING" ||
        row.onHand.confidence === "MISSING",
    );
  }
  if (filters.sourceSystem) {
    shaped = shaped.filter(
      (row) => row.sourceSnapshot["source_system"] === filters.sourceSystem,
    );
  }

  return shaped;
}

/** Existence check used by the page's empty-state branch. */
export async function reconciliationV2HasAnyRows(tx: Tx): Promise<boolean> {
  const [first] = await tx
    .select({ id: readMaterialReconciliationV2.id })
    .from(readMaterialReconciliationV2)
    .limit(1);
  return first != null;
}

/** Stable label + subtitle the UI uses for variance columns. The
 *  bucket name is translated into operator-friendly copy that never
 *  conflates the four subtypes. */
export const VARIANCE_LABELS: Record<
  VarianceKind,
  { title: string; subtitle: string }
> = {
  RECEIPT_VARIANCE: {
    title: "Receipt variance",
    subtitle: "Declared vs physically counted",
  },
  CYCLE_COUNT_VARIANCE: {
    title: "Cycle-count variance",
    subtitle: "Expected remaining vs physical count",
  },
  CONSUMPTION_VARIANCE: {
    title: "Consumption variance",
    subtitle: "Actual use vs expected use",
  },
  UNKNOWN_VARIANCE: {
    title: "Unknown variance",
    subtitle: "Unclassified difference",
  },
};
