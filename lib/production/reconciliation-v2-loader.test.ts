// PT-6D — loader tests.
//
// The math is covered by reconciliation-v2.test.ts (PT-6B) and
// material-reconciliation-v2.test.ts (PT-6C). This file proves the
// loader's row-shaping + filter logic is honest and that the variance
// labels never use banned wording.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import {
  VARIANCE_LABELS,
  listReconciliationV2Rows,
  reconciliationV2HasAnyRows,
  type ReconciliationV2Row,
} from "./reconciliation-v2-loader";

// Row shape that mirrors what the .select(...) join returns. Numeric
// values come back as strings from postgres-js for numeric(20,6).
type RawJoinRow = {
  id: string;
  scopeType: string;
  scopeId: string;
  materialItemId: string | null;
  packagingLotId: string | null;
  rawBagId: string | null;
  poId: string | null;
  productId: string | null;
  unitOfMeasure: string;
  declaredValue: string | null;
  declaredConfidence: string;
  declaredSource: string | null;
  declaredMissingInputs: unknown;
  countedValue: string | null;
  countedConfidence: string;
  countedSource: string | null;
  countedMissingInputs: unknown;
  acceptedValue: string | null;
  acceptedConfidence: string;
  acceptedSource: string | null;
  acceptedMissingInputs: unknown;
  consumedEstimatedValue: string | null;
  consumedEstimatedConfidence: string;
  consumedEstimatedSource: string | null;
  consumedEstimatedMissingInputs: unknown;
  consumedActualValue: string | null;
  consumedActualConfidence: string;
  consumedActualSource: string | null;
  consumedActualMissingInputs: unknown;
  scrappedOrDamagedValue: string | null;
  scrappedOrDamagedConfidence: string;
  scrappedOrDamagedSource: string | null;
  scrappedOrDamagedMissingInputs: unknown;
  onHandValue: string | null;
  onHandConfidence: string;
  onHandSource: string | null;
  onHandMissingInputs: unknown;
  receiptVarianceValue: string | null;
  receiptVarianceConfidence: string;
  receiptVarianceSeverity: string;
  cycleCountVarianceValue: string | null;
  cycleCountVarianceConfidence: string;
  cycleCountVarianceSeverity: string;
  consumptionVarianceValue: string | null;
  consumptionVarianceConfidence: string;
  consumptionVarianceSeverity: string;
  unknownVarianceValue: string | null;
  unknownVarianceConfidence: string;
  unknownVarianceSeverity: string;
  overallConfidence: string;
  warnings: unknown;
  sourceSnapshot: unknown;
  calculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  materialSku: string | null;
  materialName: string | null;
  materialKind: string | null;
  lotNumber: string | null;
  rollNumber: string | null;
};

/** Stub tx whose .select(...).from(...).leftJoin(...).leftJoin(...)
 *  .where(...).orderBy(...) chain resolves to the supplied rows. */
function buildLoaderStub(rows: RawJoinRow[]) {
  const promiseAll: unknown = rows;
  const orderable = {
    orderBy: () => Promise.resolve(promiseAll),
  };
  const where = {
    where: () => orderable,
  };
  const join = {
    leftJoin: () => join,
    where: () => orderable,
  };
  const tx = {
    select: () => ({
      from: () => ({
        leftJoin: () => join,
        where: () => orderable,
        limit: () => Promise.resolve(rows.length > 0 ? [rows[0]] : []),
      }),
    }),
  } as unknown as Parameters<typeof listReconciliationV2Rows>[0];
  return tx;
}

const PACKTRACK_ROW: RawJoinRow = {
  id: "row-1",
  scopeType: "ROLL",
  scopeId: "lot-1",
  materialItemId: "mat-1",
  packagingLotId: "lot-1",
  rawBagId: null,
  poId: null,
  productId: null,
  unitOfMeasure: "each",
  declaredValue: "100",
  declaredConfidence: "MEDIUM",
  declaredSource: "packtrack_declared",
  declaredMissingInputs: [],
  countedValue: "98",
  countedConfidence: "HIGH",
  countedSource: "physical_count",
  countedMissingInputs: [],
  acceptedValue: "98",
  acceptedConfidence: "HIGH",
  acceptedSource: "counted_quantity",
  acceptedMissingInputs: [],
  consumedEstimatedValue: null,
  consumedEstimatedConfidence: "MISSING",
  consumedEstimatedSource: null,
  consumedEstimatedMissingInputs: ["consumed_estimated"],
  consumedActualValue: null,
  consumedActualConfidence: "MISSING",
  consumedActualSource: null,
  consumedActualMissingInputs: ["consumed_actual"],
  scrappedOrDamagedValue: null,
  scrappedOrDamagedConfidence: "MISSING",
  scrappedOrDamagedSource: null,
  scrappedOrDamagedMissingInputs: ["scrap"],
  onHandValue: "98",
  onHandConfidence: "MEDIUM",
  onHandSource: "QTY_ON_HAND",
  onHandMissingInputs: [],
  receiptVarianceValue: "-2",
  receiptVarianceConfidence: "HIGH",
  receiptVarianceSeverity: "MEDIUM",
  cycleCountVarianceValue: null,
  cycleCountVarianceConfidence: "MISSING",
  cycleCountVarianceSeverity: "MISSING",
  consumptionVarianceValue: null,
  consumptionVarianceConfidence: "MISSING",
  consumptionVarianceSeverity: "MISSING",
  unknownVarianceValue: null,
  unknownVarianceConfidence: "MISSING",
  unknownVarianceSeverity: "MISSING",
  overallConfidence: "MEDIUM",
  warnings: ["no actual consumption signal"],
  sourceSnapshot: {
    source_system: "PACKTRACK",
    declared_quantity: 100,
    counted_quantity: 98,
  },
  calculatedAt: new Date("2026-05-09T12:00:00Z"),
  createdAt: new Date("2026-05-09T12:00:00Z"),
  updatedAt: new Date("2026-05-09T12:00:00Z"),
  materialSku: "FOIL-001",
  materialName: "Foil Roll",
  materialKind: "FOIL_ROLL",
  lotNumber: null,
  rollNumber: null,
};

const ROLL_ROW: RawJoinRow = {
  ...PACKTRACK_ROW,
  id: "row-2",
  scopeId: "lot-2",
  packagingLotId: "lot-2",
  unitOfMeasure: "g",
  declaredValue: null,
  declaredConfidence: "MISSING",
  declaredSource: null,
  declaredMissingInputs: ["declared_quantity"],
  countedValue: "1500",
  countedConfidence: "HIGH",
  countedSource: "physical_count",
  acceptedValue: "1500",
  acceptedConfidence: "HIGH",
  acceptedSource: "counted_quantity",
  onHandValue: "1500",
  onHandConfidence: "HIGH",
  onHandSource: "WEIGH_BACK_DERIVED",
  receiptVarianceValue: null,
  receiptVarianceConfidence: "MISSING",
  receiptVarianceSeverity: "MISSING",
  overallConfidence: "HIGH",
  sourceSnapshot: { source_system: "MANUAL_LUMA" },
  rollNumber: "PVC-9001",
  materialKind: "PVC_ROLL",
  materialSku: "PVC-001",
  materialName: "PVC Roll",
};

describe("listReconciliationV2Rows — row shaping", () => {
  it("returns one shaped row per join row, parsing numeric strings to numbers", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW]);
    const rows = await listReconciliationV2Rows(tx, {});
    expect(rows).toHaveLength(1);
    const r: ReconciliationV2Row = rows[0]!;
    expect(r.id).toBe("row-1");
    expect(r.unit).toBe("each");
    expect(r.declared.value).toBe(100);
    expect(r.counted.value).toBe(98);
    expect(r.accepted.value).toBe(98);
    expect(r.accepted.confidence).toBe("HIGH");
    expect(r.variances.RECEIPT_VARIANCE.value).toBe(-2);
    expect(r.variances.RECEIPT_VARIANCE.severity).toBe("MEDIUM");
    expect(r.materialSku).toBe("FOIL-001");
    expect(r.materialKind).toBe("FOIL_ROLL");
  });

  it("preserves jsonb arrays for missingInputs", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW]);
    const rows = await listReconciliationV2Rows(tx, {});
    const r = rows[0]!;
    expect(r.consumedEstimated.missingInputs).toEqual(["consumed_estimated"]);
    expect(r.consumedActual.missingInputs).toEqual(["consumed_actual"]);
    expect(r.scrappedOrDamaged.missingInputs).toEqual(["scrap"]);
  });

  it("reads source_snapshot as a record (not a string)", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW]);
    const rows = await listReconciliationV2Rows(tx, {});
    expect(rows[0]!.sourceSnapshot["source_system"]).toBe("PACKTRACK");
  });

  it("reads warnings array", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW]);
    const rows = await listReconciliationV2Rows(tx, {});
    expect(rows[0]!.warnings).toEqual(["no actual consumption signal"]);
  });

  it("handles weight-mode rows with unit=g + null declared", async () => {
    const tx = buildLoaderStub([ROLL_ROW]);
    const rows = await listReconciliationV2Rows(tx, {});
    const r = rows[0]!;
    expect(r.unit).toBe("g");
    expect(r.declared.value).toBeNull();
    expect(r.declared.confidence).toBe("MISSING");
    expect(r.counted.value).toBe(1500);
    expect(r.onHand.confidence).toBe("HIGH");
    expect(r.onHand.source).toBe("WEIGH_BACK_DERIVED");
    expect(r.rollNumber).toBe("PVC-9001");
  });
});

describe("listReconciliationV2Rows — filters", () => {
  it("varianceOnly drops rows whose four variance buckets are all null/zero", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW, ROLL_ROW]);
    const rows = await listReconciliationV2Rows(tx, { varianceOnly: true });
    // PackTrack row has receipt_variance=-2 (kept). Roll row has all
    // four variances MISSING (filtered out).
    expect(rows.map((r) => r.id)).toEqual(["row-1"]);
  });

  it("varianceKind=RECEIPT_VARIANCE keeps only rows with non-zero receipt variance", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW, ROLL_ROW]);
    const rows = await listReconciliationV2Rows(tx, {
      varianceKind: "RECEIPT_VARIANCE",
    });
    expect(rows.map((r) => r.id)).toEqual(["row-1"]);
  });

  it("varianceSeverity filter only keeps rows whose any-variance severity matches", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW, ROLL_ROW]);
    const rows = await listReconciliationV2Rows(tx, {
      varianceSeverity: "MEDIUM",
    });
    expect(rows.map((r) => r.id)).toEqual(["row-1"]);
  });

  it("missingOnly keeps rows with at least one MISSING bucket", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW]);
    const rows = await listReconciliationV2Rows(tx, { missingOnly: true });
    // PackTrack row has consumed_estimated / consumed_actual / scrap MISSING.
    expect(rows).toHaveLength(1);
  });

  it("sourceSystem filter reads from source_snapshot", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW, ROLL_ROW]);
    const rows = await listReconciliationV2Rows(tx, { sourceSystem: "PACKTRACK" });
    expect(rows.map((r) => r.id)).toEqual(["row-1"]);
    const rows2 = await listReconciliationV2Rows(buildLoaderStub([PACKTRACK_ROW, ROLL_ROW]), {
      sourceSystem: "MANUAL_LUMA",
    });
    expect(rows2.map((r) => r.id)).toEqual(["row-2"]);
  });
});

describe("VARIANCE_LABELS — UI copy invariants", () => {
  it("RECEIPT_VARIANCE label/subtitle never says 'production loss' / 'scrap' / 'yield'", () => {
    const v = VARIANCE_LABELS.RECEIPT_VARIANCE;
    const text = `${v.title} ${v.subtitle}`.toLowerCase();
    expect(text).not.toContain("production loss");
    expect(text).not.toContain("scrap");
    expect(text).not.toContain("yield");
  });

  it("CYCLE_COUNT_VARIANCE label/subtitle never says 'supplier shortage' / 'vendor'", () => {
    const v = VARIANCE_LABELS.CYCLE_COUNT_VARIANCE;
    const text = `${v.title} ${v.subtitle}`.toLowerCase();
    expect(text).not.toContain("supplier shortage");
    expect(text).not.toContain("vendor");
  });

  it("CONSUMPTION_VARIANCE label/subtitle never says 'shortage' / 'short-shipped'", () => {
    const v = VARIANCE_LABELS.CONSUMPTION_VARIANCE;
    const text = `${v.title} ${v.subtitle}`.toLowerCase();
    expect(text).not.toContain("shortage");
    expect(text).not.toContain("short-shipped");
  });

  it("UNKNOWN_VARIANCE clearly signals the unclassified status", () => {
    const v = VARIANCE_LABELS.UNKNOWN_VARIANCE;
    expect(v.subtitle.toLowerCase()).toContain("unclassified");
  });

  it("all four labels are distinct (no two subtypes share copy)", () => {
    const titles = new Set(Object.values(VARIANCE_LABELS).map((v) => v.title));
    const subtitles = new Set(Object.values(VARIANCE_LABELS).map((v) => v.subtitle));
    expect(titles.size).toBe(4);
    expect(subtitles.size).toBe(4);
  });
});

describe("reconciliationV2HasAnyRows", () => {
  it("returns true when any row exists", async () => {
    const tx = buildLoaderStub([PACKTRACK_ROW]);
    const has = await reconciliationV2HasAnyRows(tx);
    expect(has).toBe(true);
  });

  it("returns false when zero rows", async () => {
    const tx = buildLoaderStub([]);
    const has = await reconciliationV2HasAnyRows(tx);
    expect(has).toBe(false);
  });
});
