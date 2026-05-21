// PT-6B — Pure 8-bucket reconciliation tests.
//
// Every test from the PT-6A plan §8 + the prompt's required 28 cases
// + the canonical example fixture (declared 1000, counted 972,
// accepted 972, consumed_estimated 800, consumed_actual 820, on_hand
// 150, cycle_counted 140).

import { describe, expect, it } from "vitest";

import {
  classifyVarianceSeverity,
  combineConfidence,
  deriveAcceptedQuantity,
  deriveConsumedActual,
  deriveConsumedEstimated,
  deriveCountedQuantity,
  deriveCycleCountVariance,
  deriveConsumptionVariance,
  deriveDeclaredQuantity,
  deriveEstimatedRemaining,
  deriveOnHand,
  deriveReceiptVariance,
  deriveReconciliationResult,
  deriveScrappedOrDamaged,
  deriveUnknownVariance,
  normalizeQuantity,
  type ReconciliationInput,
  type ReceiptInput,
} from "./reconciliation-v2";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_RECEIPT: ReceiptInput = {
  declaredQuantity: null,
  countedQuantity: null,
  qtyReceivedLegacy: null,
  sourceSystem: null,
};

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  const base: ReconciliationInput = {
    unit: "each",
    receipt: { ...EMPTY_RECEIPT, ...(overrides.receipt ?? {}) },
    consumption: {
      estimated: null,
      actual: null,
      ...(overrides.consumption ?? {}),
    },
    inventory: {
      onHandQty: null,
      onHandSource: null,
      cycleCountActualRemaining: null,
      ...(overrides.inventory ?? {}),
    },
    scrap: overrides.scrap === undefined ? null : overrides.scrap,
  };
  if (overrides.adjustments !== undefined) {
    base.adjustments = overrides.adjustments;
  }
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-9: ACCEPTED + DECLARED + COUNTED rules
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTED, DECLARED, COUNTED — single-source rules", () => {
  it("[1] declared only — accepted falls back to declared, MEDIUM", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: null, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      }),
    );
    expect(r.declared.value).toBe(1000);
    expect(r.declared.confidence).toBe("MEDIUM");
    expect(r.counted.confidence).toBe("MISSING");
    expect(r.accepted.value).toBe(1000);
    expect(r.accepted.confidence).toBe("MEDIUM");
    expect(r.accepted.source).toBe("declared_quantity");
  });

  it("[2] declared + counted equal — accepted = counted HIGH, RECEIPT_VARIANCE 0/NONE", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      }),
    );
    expect(r.accepted.value).toBe(1000);
    expect(r.accepted.confidence).toBe("HIGH");
    expect(r.accepted.source).toBe("counted_quantity");
    const recv = r.variances.find((v) => v.kind === "RECEIPT_VARIANCE")!;
    expect(recv.value).toBe(0);
    expect(recv.severity).toBe("NONE");
  });

  it("[3] declared + counted SHORT — RECEIPT_VARIANCE negative", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 972, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      }),
    );
    expect(r.accepted.value).toBe(972);
    const recv = r.variances.find((v) => v.kind === "RECEIPT_VARIANCE")!;
    expect(recv.value).toBe(-28);
    expect(recv.severity).toBe("MEDIUM"); // 28/1000 = 2.8% → MEDIUM
    expect(recv.explanation).toMatch(/short-shipped/);
    expect(recv.explanation).not.toMatch(/production loss/);
  });

  it("[4] declared + counted OVER — RECEIPT_VARIANCE positive", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 1015, qtyReceivedLegacy: null, sourceSystem: "PACKTRACK" },
      }),
    );
    const recv = r.variances.find((v) => v.kind === "RECEIPT_VARIANCE")!;
    expect(recv.value).toBe(15);
    expect(recv.explanation).toMatch(/over-shipped/);
    expect(recv.severity).toBe("MEDIUM"); // 15/1000 = 1.5%
  });

  it("[5] counted only (no declared) — accepted HIGH, RECEIPT_VARIANCE MISSING", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 500, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      }),
    );
    expect(r.accepted.value).toBe(500);
    expect(r.accepted.confidence).toBe("HIGH");
    const recv = r.variances.find((v) => v.kind === "RECEIPT_VARIANCE")!;
    expect(recv.value).toBeNull();
    expect(recv.confidence).toBe("MISSING");
    expect(recv.missingInputs).toContain("declared_quantity");
  });

  it("[6] accepted prefers counted over declared", () => {
    const r = deriveAcceptedQuantity(
      { declaredQuantity: 800, countedQuantity: 750, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      "each",
    );
    expect(r.value).toBe(750);
    expect(r.source).toBe("counted_quantity");
    expect(r.confidence).toBe("HIGH");
  });

  it("[7] accepted falls back to declared when counted absent", () => {
    const r = deriveAcceptedQuantity(
      { declaredQuantity: 800, countedQuantity: null, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      "each",
    );
    expect(r.value).toBe(800);
    expect(r.source).toBe("declared_quantity");
    expect(r.confidence).toBe("MEDIUM");
  });

  it("[8] accepted falls back to legacy qty_received as LOW confidence", () => {
    const r = deriveAcceptedQuantity(
      { declaredQuantity: null, countedQuantity: null, qtyReceivedLegacy: 600, sourceSystem: "IMPORT" },
      "each",
    );
    expect(r.value).toBe(600);
    expect(r.source).toBe("legacy_qty_received");
    expect(r.confidence).toBe("LOW");
    expect(r.explanation).toMatch(/legacy/);
  });

  it("[9] missing accepted — value null, MISSING confidence", () => {
    const r = deriveAcceptedQuantity(EMPTY_RECEIPT, "each");
    expect(r.value).toBeNull();
    expect(r.confidence).toBe("MISSING");
    expect(r.missingInputs).toEqual([
      "counted_quantity",
      "declared_quantity",
      "qty_received",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10-13: receipt-vs-loss separation; source-system handling
// ─────────────────────────────────────────────────────────────────────────────

describe("receipt variance is never labelled production loss", () => {
  it("[10] explanation never says 'loss' for any receipt-variance branch", () => {
    for (const counted of [950, 1000, 1050]) {
      const v = deriveReceiptVariance(
        { declaredQuantity: 1000, countedQuantity: counted, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        "each",
      );
      expect(v.explanation.toLowerCase()).not.toContain("production loss");
      expect(v.explanation.toLowerCase()).not.toContain("scrap");
      expect(v.explanation.toLowerCase()).not.toContain("yield");
    }
  });

  it("[11] manual Luma receipt — accepted source name reflects MANUAL_LUMA path", () => {
    const r = deriveAcceptedQuantity(
      { declaredQuantity: 200, countedQuantity: null, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      "each",
    );
    expect(r.source).toBe("declared_quantity");
  });

  it("[12] PackTrack receipt — accepted source tags packtrack_declared when no counted", () => {
    const r = deriveAcceptedQuantity(
      { declaredQuantity: 200, countedQuantity: null, qtyReceivedLegacy: null, sourceSystem: "PACKTRACK" },
      "each",
    );
    expect(r.source).toBe("packtrack_declared");
  });

  it("[13] imported legacy receipt — qty_received-only path is LOW", () => {
    const r = deriveAcceptedQuantity(
      { declaredQuantity: null, countedQuantity: null, qtyReceivedLegacy: 500, sourceSystem: "IMPORT" },
      "each",
    );
    expect(r.confidence).toBe("LOW");
    expect(r.source).toBe("legacy_qty_received");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14-20: CONSUMED_ESTIMATED + CONSUMED_ACTUAL + CONSUMPTION_VARIANCE
// ─────────────────────────────────────────────────────────────────────────────

describe("CONSUMED_ESTIMATED / CONSUMED_ACTUAL / CONSUMPTION_VARIANCE", () => {
  it("[14] estimated consumption from BOM — MEDIUM confidence", () => {
    const r = deriveConsumedEstimated(
      { estimated: { value: 800, source: "BOM" }, actual: null },
      "each",
    );
    expect(r.value).toBe(800);
    expect(r.confidence).toBe("MEDIUM");
    expect(r.source).toBe("BOM");
    expect(r.estimated).toBe(true);
  });

  it("[15] estimated consumption from roll segment standard — MEDIUM", () => {
    const r = deriveConsumedEstimated(
      { estimated: { value: 35562, source: "ROLL_SEGMENT_STANDARD" }, actual: null },
      "g",
    );
    expect(r.value).toBe(35562);
    expect(r.confidence).toBe("MEDIUM");
    expect(r.source).toBe("ROLL_SEGMENT_STANDARD");
  });

  it("[16] actual consumption from weigh-back — HIGH", () => {
    const r = deriveConsumedActual(
      { estimated: null, actual: { value: 10562, source: "WEIGH_BACK" } },
      "g",
    );
    expect(r.value).toBe(10562);
    expect(r.confidence).toBe("HIGH");
    expect(r.source).toBe("WEIGH_BACK");
  });

  it("[17] actual consumption from depletion yield — MEDIUM", () => {
    const r = deriveConsumedActual(
      { estimated: null, actual: { value: 35562, source: "DEPLETION_YIELD" } },
      "g",
    );
    expect(r.value).toBe(35562);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("[18] consumption variance positive — actual > estimated", () => {
    const r = deriveConsumptionVariance(
      input({
        consumption: {
          estimated: { value: 800, source: "BOM" },
          actual: { value: 820, source: "WEIGH_BACK" },
        },
      }),
    );
    expect(r.value).toBe(20);
    expect(r.severity).toBe("MEDIUM"); // 20/800 = 2.5% → MEDIUM
    expect(r.explanation).toMatch(/MORE than BOM/);
  });

  it("[19] consumption variance negative — actual < estimated", () => {
    const r = deriveConsumptionVariance(
      input({
        consumption: {
          estimated: { value: 800, source: "BOM" },
          actual: { value: 780, source: "WEIGH_BACK" },
        },
      }),
    );
    expect(r.value).toBe(-20);
    expect(r.explanation).toMatch(/LESS than BOM/);
  });

  it("[20] no consumption variance when actual missing — MISSING", () => {
    const r = deriveConsumptionVariance(
      input({
        consumption: {
          estimated: { value: 800, source: "BOM" },
          actual: null,
        },
      }),
    );
    expect(r.value).toBeNull();
    expect(r.confidence).toBe("MISSING");
    expect(r.missingInputs).toContain("consumed_actual");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21-23: CYCLE_COUNT_VARIANCE
// ─────────────────────────────────────────────────────────────────────────────

describe("CYCLE_COUNT_VARIANCE — drift, never auto-blamed on supplier", () => {
  it("[21] cycle count above expected — positive variance", () => {
    const r = deriveCycleCountVariance(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 200, source: "BOM" }, actual: null },
        inventory: { onHandQty: null, onHandSource: null, cycleCountActualRemaining: 850 },
      }),
    );
    // accepted=1000, consumed_estimated=200, scrap=0 → estimated_remaining=800
    // cycle_counted=850 → variance = 850 - 800 = +50
    expect(r.value).toBe(50);
    expect(r.explanation).toMatch(/un-issued|mis-counted/);
  });

  it("[22] cycle count below expected — negative variance", () => {
    const r = deriveCycleCountVariance(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 200, source: "BOM" }, actual: null },
        inventory: { onHandQty: null, onHandSource: null, cycleCountActualRemaining: 750 },
      }),
    );
    expect(r.value).toBe(-50);
    expect(r.explanation).toMatch(/shrink|mis-issue|count error/);
    expect(r.explanation).not.toMatch(/vendor shortage/i);
  });

  it("[23] cycle count variance is structurally separate from receipt variance", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 980, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 100, source: "BOM" }, actual: null },
        inventory: { onHandQty: 880, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: 850 },
      }),
    );
    const receipt = r.variances.find((v) => v.kind === "RECEIPT_VARIANCE")!;
    const cycle = r.variances.find((v) => v.kind === "CYCLE_COUNT_VARIANCE")!;
    expect(receipt.value).toBe(-20); // 980 - 1000
    // accepted = 980, consumed_est = 100 → expected_remaining = 880
    // cycle_counted = 850 → cycle variance = -30
    expect(cycle.value).toBe(-30);
    expect(receipt.value).not.toBe(cycle.value); // distinct numbers, distinct buckets
    expect(receipt.explanation).not.toMatch(/cycle/i);
    expect(cycle.explanation).not.toMatch(/vendor/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 24-26: SCRAPPED_OR_DAMAGED + UNKNOWN_VARIANCE + no double-count
// ─────────────────────────────────────────────────────────────────────────────

describe("SCRAPPED_OR_DAMAGED, UNKNOWN_VARIANCE, no double-count", () => {
  it("[24] scrapped/damaged explicit quantity — HIGH from EXPLICIT_SCRAP_EVENT", () => {
    const r = deriveScrappedOrDamaged(
      { value: 12, source: "EXPLICIT_SCRAP_EVENT" },
      "each",
    );
    expect(r.value).toBe(12);
    expect(r.confidence).toBe("HIGH");
  });

  it("[25] unknown variance surfaces unaccounted material with LOW confidence", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 700, source: "BOM" }, actual: null },
        inventory: { onHandQty: 250, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: null },
      }),
    );
    const u = r.variances.find((v) => v.kind === "UNKNOWN_VARIANCE")!;
    // 1000 - 700 - 0 - 250 = 50 unaccounted
    expect(u.value).toBe(50);
    expect(u.confidence).toBe("LOW");
    expect(u.severity).toBe("MEDIUM"); // 50/1000 = 5%
    expect(u.explanation).toMatch(/investigate/);
  });

  it("[26] no double-counting between consumed_estimated and consumed_actual — only one drives unknown", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: {
          estimated: { value: 700, source: "BOM" },
          actual: { value: 720, source: "WEIGH_BACK" },
        },
        inventory: { onHandQty: 280, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: null },
      }),
    );
    const u = r.variances.find((v) => v.kind === "UNKNOWN_VARIANCE")!;
    // unknown uses actual (720) when present, not 700 + 720
    // 1000 - 720 - 0 - 280 = 0
    expect(u.value).toBe(0);
    expect(u.severity).toBe("NONE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27-30: overall confidence ladder
// ─────────────────────────────────────────────────────────────────────────────

describe("overallConfidence ladder", () => {
  it("[27] HIGH path — accepted HIGH + consumed_actual HIGH", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: {
          estimated: { value: 800, source: "BOM" },
          actual: { value: 800, source: "WEIGH_BACK" },
        },
        inventory: { onHandQty: 200, onHandSource: "CYCLE_COUNT", cycleCountActualRemaining: 200 },
        scrap: { value: 0, source: "EXPLICIT_SCRAP_EVENT" },
      }),
    );
    expect(r.overallConfidence).toBe("HIGH");
    // No actual-consumption warning, no legacy warning, no scrap-deferral
    // warning because we provided an explicit scrap signal.
    expect(r.warnings).toEqual([]);
  });

  it("[28] MEDIUM path — accepted HIGH but only estimated consumption", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 800, source: "BOM" }, actual: null },
        inventory: { onHandQty: 200, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: null },
      }),
    );
    expect(r.overallConfidence).toBe("MEDIUM");
    expect(r.warnings.some((w) => w.includes("actual consumption"))).toBe(true);
  });

  it("[29] LOW path — legacy qty_received drives accepted", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: { declaredQuantity: null, countedQuantity: null, qtyReceivedLegacy: 500, sourceSystem: "IMPORT" },
        consumption: { estimated: { value: 100, source: "LEGACY" }, actual: null },
        inventory: { onHandQty: 400, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: null },
      }),
    );
    expect(r.overallConfidence).toBe("LOW");
    expect(r.warnings.some((w) => w.includes("legacy"))).toBe(true);
  });

  it("[30] MISSING path — accepted itself missing", () => {
    const r = deriveReconciliationResult(input({}));
    expect(r.overallConfidence).toBe("MISSING");
    expect(r.accepted.value).toBeNull();
    expect(r.warnings.some((w) => w.includes("ACCEPTED is missing"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 31-32: severity classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyVarianceSeverity bands", () => {
  it("[31] severity NONE when variance is zero (within epsilon)", () => {
    expect(classifyVarianceSeverity(0, 1000)).toBe("NONE");
    expect(classifyVarianceSeverity(0.00001, 1000)).toBe("NONE");
  });

  it("[32] severity LOW/MEDIUM/HIGH thresholds vs baseline", () => {
    expect(classifyVarianceSeverity(10, 1000)).toBe("LOW"); // 1.0%
    expect(classifyVarianceSeverity(10.5, 1000)).toBe("MEDIUM"); // 1.05% > 1%
    expect(classifyVarianceSeverity(50, 1000)).toBe("MEDIUM"); // 5.0%
    expect(classifyVarianceSeverity(60, 1000)).toBe("HIGH"); // 6.0%
    // negative magnitudes use absolute value
    expect(classifyVarianceSeverity(-30, 1000)).toBe("MEDIUM");
    // null value → MISSING
    expect(classifyVarianceSeverity(null, 1000)).toBe("MISSING");
    // null baseline falls through to absolute brackets (1, 5)
    expect(classifyVarianceSeverity(0.5, null)).toBe("LOW");
    expect(classifyVarianceSeverity(3, null)).toBe("MEDIUM");
    expect(classifyVarianceSeverity(10, null)).toBe("HIGH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pure utilities
// ─────────────────────────────────────────────────────────────────────────────

describe("pure utilities", () => {
  it("normalizeQuantity rejects non-finite numbers", () => {
    expect(normalizeQuantity(null)).toBeNull();
    expect(normalizeQuantity(undefined)).toBeNull();
    expect(normalizeQuantity(NaN)).toBeNull();
    expect(normalizeQuantity(Infinity)).toBeNull();
    expect(normalizeQuantity(-0)).toBe(-0);
    expect(normalizeQuantity(42)).toBe(42);
  });

  it("combineConfidence returns lowest of inputs", () => {
    expect(combineConfidence(["HIGH", "HIGH"])).toBe("HIGH");
    expect(combineConfidence(["HIGH", "MEDIUM"])).toBe("MEDIUM");
    expect(combineConfidence(["HIGH", "LOW"])).toBe("LOW");
    expect(combineConfidence(["HIGH", "MISSING"])).toBe("MISSING");
    expect(combineConfidence([])).toBe("MISSING");
  });

  it("deriveDeclaredQuantity tags packtrack vs declared source", () => {
    const a = deriveDeclaredQuantity(
      { declaredQuantity: 100, countedQuantity: null, qtyReceivedLegacy: null, sourceSystem: "PACKTRACK" },
      "each",
    );
    expect(a.source).toBe("packtrack_declared");
    const b = deriveDeclaredQuantity(
      { declaredQuantity: 100, countedQuantity: null, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      "each",
    );
    expect(b.source).toBe("declared_quantity");
  });

  it("deriveCountedQuantity reports MISSING when null", () => {
    const r = deriveCountedQuantity(EMPTY_RECEIPT, "each");
    expect(r.value).toBeNull();
    expect(r.confidence).toBe("MISSING");
  });

  it("deriveScrappedOrDamaged respects source-driven confidence", () => {
    expect(deriveScrappedOrDamaged({ value: 5, source: "EXPLICIT_SCRAP_EVENT" }, "each").confidence).toBe("HIGH");
    expect(deriveScrappedOrDamaged({ value: 5, source: "READ_BAG_METRICS_DAMAGE" }, "each").confidence).toBe("MEDIUM");
    expect(deriveScrappedOrDamaged({ value: 5, source: null }, "each").confidence).toBe("LOW");
    expect(deriveScrappedOrDamaged(null, "each").confidence).toBe("MISSING");
  });

  it("deriveOnHand confidence depends on source", () => {
    expect(deriveOnHand({ onHandQty: 100, onHandSource: "CYCLE_COUNT", cycleCountActualRemaining: null }, "each").confidence).toBe("HIGH");
    expect(deriveOnHand({ onHandQty: 100, onHandSource: "WEIGH_BACK_DERIVED", cycleCountActualRemaining: null }, "each").confidence).toBe("HIGH");
    expect(deriveOnHand({ onHandQty: 100, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: null }, "each").confidence).toBe("MEDIUM");
    expect(deriveOnHand({ onHandQty: null, onHandSource: null, cycleCountActualRemaining: null }, "each").confidence).toBe("MISSING");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canonical example from the prompt (declared 1000, counted 972, etc.)
// ─────────────────────────────────────────────────────────────────────────────

describe("canonical full-stack scenario", () => {
  it("declared 1000 / counted 972 / consumed_est 800 / consumed_act 820 / on_hand 150 / cycle 140", () => {
    const r = deriveReconciliationResult(
      input({
        receipt: {
          declaredQuantity: 1000,
          countedQuantity: 972,
          qtyReceivedLegacy: null,
          sourceSystem: "PACKTRACK",
        },
        consumption: {
          estimated: { value: 800, source: "BOM" },
          actual: { value: 820, source: "WEIGH_BACK" },
        },
        inventory: {
          onHandQty: 150,
          onHandSource: "QTY_ON_HAND",
          cycleCountActualRemaining: 140,
        },
        scrap: null,
      }),
    );
    expect(r.declared.value).toBe(1000);
    expect(r.counted.value).toBe(972);
    expect(r.accepted.value).toBe(972);
    expect(r.accepted.confidence).toBe("HIGH");
    expect(r.consumedEstimated.value).toBe(800);
    expect(r.consumedActual.value).toBe(820);
    expect(r.onHand.value).toBe(150);

    const recv = r.variances.find((v) => v.kind === "RECEIPT_VARIANCE")!;
    const cycle = r.variances.find((v) => v.kind === "CYCLE_COUNT_VARIANCE")!;
    const cons = r.variances.find((v) => v.kind === "CONSUMPTION_VARIANCE")!;
    const unk = r.variances.find((v) => v.kind === "UNKNOWN_VARIANCE")!;

    expect(recv.value).toBe(-28); // counted-declared
    // estimated_remaining = accepted - consumed_est - scrap = 972 - 800 - 0 = 172
    // cycle_counted = 140 → cycle variance = 140 - 172 = -32
    expect(cycle.value).toBe(-32);
    expect(cons.value).toBe(20); // actual - estimated
    // unknown = accepted - consumed_used(=actual=820) - scrap(0) - on_hand(150)
    //        = 972 - 820 - 150 = 2
    expect(unk.value).toBe(2);

    // Buckets stay structurally distinct. The four variance numbers must
    // not collapse into the same explanation labels.
    expect(recv.explanation).toMatch(/short-shipped|over-shipped/);
    expect(cycle.explanation).toMatch(/below expected|above expected|matches expected/);
    expect(cons.explanation).toMatch(/MORE than BOM|LESS than BOM|matches BOM/);
    expect(unk.explanation).toMatch(/investigate|accounted/);

    // Overall HIGH because accepted HIGH + consumed_actual HIGH.
    expect(r.overallConfidence).toBe("HIGH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// receipt variance never contains "production loss" wording (load-bearing)
// ─────────────────────────────────────────────────────────────────────────────

describe("UI copy invariants — no banned wording in variance explanations", () => {
  it("RECEIPT_VARIANCE never says production loss / yield / scrap", () => {
    const cases = [
      { declaredQuantity: 1000, countedQuantity: 1000 },
      { declaredQuantity: 1000, countedQuantity: 800 },
      { declaredQuantity: 1000, countedQuantity: 1100 },
      { declaredQuantity: null, countedQuantity: 800 },
      { declaredQuantity: 1000, countedQuantity: null },
    ] as const;
    for (const c of cases) {
      const v = deriveReceiptVariance(
        { ...c, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        "each",
      );
      const e = v.explanation.toLowerCase();
      expect(e).not.toContain("production loss");
      expect(e).not.toContain("scrap");
      expect(e).not.toContain("yield");
    }
  });

  it("CYCLE_COUNT_VARIANCE never auto-blames the supplier", () => {
    const r = deriveCycleCountVariance(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 200, source: "BOM" }, actual: null },
        inventory: { onHandQty: null, onHandSource: null, cycleCountActualRemaining: 700 },
      }),
    );
    expect(r.explanation.toLowerCase()).not.toContain("vendor");
    expect(r.explanation.toLowerCase()).not.toContain("supplier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimated remaining helper edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveEstimatedRemaining edge cases", () => {
  it("returns null when ACCEPTED itself is missing", () => {
    const r = deriveEstimatedRemaining(input({}));
    expect(r).toBeNull();
  });

  it("treats null consumed_estimated as 0 in the formula but keeps confidence honest", () => {
    const r = deriveEstimatedRemaining(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 500, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.value).toBe(500); // 500 - 0 - 0
    // confidence chains only the inputs that contributed values; with
    // accepted HIGH and nothing else, returns HIGH.
    expect(r!.confidence).toBe("HIGH");
  });

  it("includes signed adjustments", () => {
    const r = deriveEstimatedRemaining(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: { estimated: { value: 200, source: "BOM" }, actual: null },
        adjustments: -10,
      }),
    );
    expect(r!.value).toBe(790); // 1000 - 200 - 0 + (-10)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unknown variance never reports HIGH confidence
// ─────────────────────────────────────────────────────────────────────────────

describe("UNKNOWN_VARIANCE confidence ceiling", () => {
  it("is at most LOW even when every input is HIGH", () => {
    const r = deriveUnknownVariance(
      input({
        receipt: { declaredQuantity: 1000, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: {
          estimated: { value: 700, source: "BOM" },
          actual: { value: 720, source: "WEIGH_BACK" },
        },
        inventory: { onHandQty: 250, onHandSource: "CYCLE_COUNT", cycleCountActualRemaining: 250 },
      }),
    );
    expect(r.confidence).toBe("LOW");
  });

  it("MISSING when ACCEPTED itself is unresolvable", () => {
    const r = deriveUnknownVariance(input({}));
    expect(r.value).toBeNull();
    expect(r.confidence).toBe("MISSING");
  });

  it("zero unknown when buckets close cleanly", () => {
    const r = deriveUnknownVariance(
      input({
        receipt: { declaredQuantity: null, countedQuantity: 1000, qtyReceivedLegacy: null, sourceSystem: "MANUAL_LUMA" },
        consumption: {
          estimated: null,
          actual: { value: 750, source: "WEIGH_BACK" },
        },
        inventory: { onHandQty: 250, onHandSource: "QTY_ON_HAND", cycleCountActualRemaining: null },
        scrap: null,
      }),
    );
    expect(r.value).toBe(0);
    expect(r.severity).toBe("NONE");
  });
});
