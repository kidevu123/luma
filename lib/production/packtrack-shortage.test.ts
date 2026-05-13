// PT-7B — pure shortage recommendation tests.
//
// Fixture-matrix coverage. No DB access. The helper signatures are
// frozen by these tests; later phases hydrate inputs from read models
// without touching this file.

import { describe, expect, it } from "vitest";
import {
  calculateProjectedShortage,
  calculateRecommendedOrderQuantity,
  calculateRunoutDate,
  classifyShortageConfidence,
  classifyShortageSeverity,
  deriveShortageRecommendation,
  deriveShortageRecommendations,
  deriveShortageSignals,
  isRecommendationSendableToPackTrack,
  shouldKeepExistingRecommendation,
  skipMaterialKindForPackTrackShortage,
  type ShortageRecommendationInput,
} from "./packtrack-shortage";

const NOW = new Date("2026-05-13T18:00:00Z");

/** Fully-populated HIGH-confidence baseline. Tests override fields
 *  via spread to exercise specific branches. */
function baseline(): ShortageRecommendationInput {
  return {
    generatedAt: NOW,
    materialId: "11111111-1111-4111-8111-111111111111",
    materialCode: "MP-CARD-001",
    materialName: "Mango Peach printed card",
    materialKind: "INSERT",
    productId: "22222222-2222-4222-8222-222222222222",
    productName: "Mango Peach 30ct",
    productSku: "MP-30CT",
    compatibilityRole: "CARD_MATERIAL",
    compatibilityRequired: true,
    currentOnHand: 6000,
    acceptedInventory: 6000,
    inventorySource: "COUNTED",
    inventoryConfidence: "HIGH",
    dailyUsageRate: 1200,
    usageWindowDays: 14,
    usageSource: "READ_MATERIAL_CONSUMPTION_DAILY",
    leadTimeDays: 7,
    leadTimeSource: "PACKTRACK_LIVE",
    safetyBufferPercent: 20,
    minOrderQuantity: 1000,
    orderMultiple: 100,
    parLevel: 2000,
    productRequirement: { perUnit: 1, perDisplay: 20, perCase: 400 },
    recentReceipt: {
      receivedAt: new Date("2026-04-15T00:00:00Z"),
      quantity: 5000,
      source: "PACKTRACK",
      supplier: "Acme Print Co",
    },
  };
}

// ─── 1-3. Kind skip ────────────────────────────────────────────────────

describe("skipMaterialKindForPackTrackShortage — machine consumables", () => {
  it("skips PVC_ROLL", () => {
    expect(skipMaterialKindForPackTrackShortage("PVC_ROLL")).toBe(true);
  });
  it("skips FOIL_ROLL", () => {
    expect(skipMaterialKindForPackTrackShortage("FOIL_ROLL")).toBe(true);
  });
  it("skips BLISTER_FOIL", () => {
    expect(skipMaterialKindForPackTrackShortage("BLISTER_FOIL")).toBe(true);
  });
  it("does NOT skip DISPLAY / CASE / INSERT / BOTTLE / LABEL", () => {
    expect(skipMaterialKindForPackTrackShortage("DISPLAY")).toBe(false);
    expect(skipMaterialKindForPackTrackShortage("CASE")).toBe(false);
    expect(skipMaterialKindForPackTrackShortage("INSERT")).toBe(false);
    expect(skipMaterialKindForPackTrackShortage("BOTTLE")).toBe(false);
    expect(skipMaterialKindForPackTrackShortage("LABEL")).toBe(false);
  });

  it("deriveShortageRecommendation returns null for PVC_ROLL input", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      materialKind: "PVC_ROLL",
    });
    expect(r).toBeNull();
  });
});

// ─── 4. Required + zero inventory → CRITICAL ──────────────────────────

describe("required material with zero on-hand → CRITICAL", () => {
  it("classifies CRITICAL when compatibilityRequired and accepted=0", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe("CRITICAL");
    expect(r!.warnings.some((w) => /production blocked/i.test(w))).toBe(true);
    expect(r!.reason).toMatch(/zero accepted inventory/i);
  });

  it("classifies CRITICAL when required + production target > accepted", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 1000,
      acceptedInventory: 1000,
      productionTargetDemand: 5000,
    });
    expect(r!.severity).toBe("CRITICAL");
  });
});

// ─── 5. Missing material_code → MISSING, not sendable ─────────────────

describe("missing material_code → MISSING confidence + not sendable", () => {
  it("flags missing material_code via MISSING_CONFIG", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      materialCode: null,
    });
    expect(r!.confidence).toBe("MISSING");
    expect(r!.missingInputs).toContain("material_code");
    expect(r!.sendableToPackTrack).toBe(false);
    expect(isRecommendationSendableToPackTrack(r!)).toBe(false);
    expect(r!.recommendedOrderQuantity).toBeNull();
  });
  it("treats empty/whitespace material_code as missing", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      materialCode: "   ",
    });
    expect(r!.confidence).toBe("MISSING");
  });
});

// ─── 6-9. Confidence ladder ───────────────────────────────────────────

describe("classifyShortageConfidence", () => {
  it("HIGH when everything aligned (counted + BOM + ≥7d + compatibility + live lead)", () => {
    expect(classifyShortageConfidence(baseline())).toBe("HIGH");
  });

  it("MEDIUM when inventory is SUPPLIER_DECLARED but everything else is fine", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        inventorySource: "SUPPLIER_DECLARED",
        inventoryConfidence: "MEDIUM",
        // Reset other gaps so this is a single-gap case.
        leadTimeSource: "PACKTRACK_LIVE",
      }),
    ).toBe("MEDIUM");
  });

  it("MEDIUM when lead time is CONFIG_DEFAULT only", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        leadTimeSource: "CONFIG_DEFAULT",
      }),
    ).toBe("MEDIUM");
  });

  it("LOW when inventory is LEGACY_IMPORT (counts as 2 gaps)", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        inventorySource: "LEGACY_IMPORT",
        inventoryConfidence: "LOW",
        leadTimeSource: "PACKTRACK_LIVE",
      }),
    ).toBe("LOW");
  });

  it("MISSING when BOM is missing for a product-scoped rec", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        productRequirement: { perUnit: null, perDisplay: null, perCase: null },
      }),
    ).toBe("MISSING");
  });

  it("MISSING when compatibility role missing for a product-scoped rec", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        compatibilityRole: null,
      }),
    ).toBe("MISSING");
  });

  it("MISSING when no usage source and no production target", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        usageSource: null,
        productionTargetDemand: null,
        dailyUsageRate: null,
      }),
    ).toBe("MISSING");
  });
});

// ─── 10-11. Severity timing ────────────────────────────────────────────

describe("classifyShortageSeverity — timing", () => {
  it("CRITICAL when runout is today or in the past", () => {
    const i = {
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
      compatibilityRequired: false,
      dailyUsageRate: 1000,
      leadTimeDays: 7,
    };
    const sev = classifyShortageSeverity(i, {
      projectedShortageQuantity: 0,
      runoutDate: NOW,
    });
    expect(sev).toBe("CRITICAL");
  });

  it("HIGH when runout is inside lead time", () => {
    const i = baseline();
    const r = new Date(i.generatedAt.getTime() + 3 * 86400000);
    const sev = classifyShortageSeverity(
      { ...i, compatibilityRequired: false },
      { projectedShortageQuantity: 1000, runoutDate: r },
    );
    expect(sev).toBe("HIGH");
  });

  it("MEDIUM when runout is within 1.5× lead time", () => {
    const i = baseline();
    const r = new Date(i.generatedAt.getTime() + 9 * 86400000);
    const sev = classifyShortageSeverity(
      { ...i, compatibilityRequired: false, parLevel: null },
      { projectedShortageQuantity: 500, runoutDate: r },
    );
    expect(sev).toBe("MEDIUM");
  });

  it("WATCH when no projected shortage and not below par", () => {
    const i = { ...baseline(), compatibilityRequired: false };
    const sev = classifyShortageSeverity(i, {
      projectedShortageQuantity: 0,
      runoutDate: new Date(i.generatedAt.getTime() + 30 * 86400000),
    });
    expect(sev).toBe("WATCH");
  });

  it("MEDIUM when below par-level + has usage rate", () => {
    const i = {
      ...baseline(),
      compatibilityRequired: false,
      acceptedInventory: 1500,
      currentOnHand: 1500,
      parLevel: 2000,
      dailyUsageRate: 100,
    };
    const sev = classifyShortageSeverity(i, {
      projectedShortageQuantity: 0,
      runoutDate: null,
    });
    expect(sev).toBe("MEDIUM");
  });
});

// ─── 12-13. Below-threshold + no-shortage branches ─────────────────────

describe("below reorder threshold + no-shortage", () => {
  it("recommendation surfaces at MEDIUM when below par + has usage", () => {
    // Pick a slow rate so runout is far beyond lead time — the
    // par-level branch is what we want to exercise here.
    const r = deriveShortageRecommendation({
      ...baseline(),
      compatibilityRequired: false,
      currentOnHand: 1500,
      acceptedInventory: 1500,
      parLevel: 2000,
      dailyUsageRate: 5,
      leadTimeDays: 7,
      productionTargetDemand: null,
    });
    expect(r!.severity).toBe("MEDIUM");
  });

  it("no recommendation when above par + no shortage + not required", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      compatibilityRequired: false,
      currentOnHand: 20000,
      acceptedInventory: 20000,
      parLevel: 2000,
      dailyUsageRate: 1, // tiny
      leadTimeDays: 7,
    });
    expect(r).toBeNull();
  });
});

// ─── 14-17. Recommended quantity formula ──────────────────────────────

describe("calculateRecommendedOrderQuantity", () => {
  it("applies default 20% safety buffer when not specified", () => {
    // shortage=1000, buffer=20% → raw=1200, no min, no multiple
    // → ceil(1200) = 1200.
    expect(
      calculateRecommendedOrderQuantity(1000, {}),
    ).toBe(1200);
  });
  it("applies custom safety buffer", () => {
    expect(
      calculateRecommendedOrderQuantity(1000, { safetyBufferPercent: 50 }),
    ).toBe(1500);
  });
  it("rounds up to minOrderQuantity when raw is smaller", () => {
    // shortage=10, buffer=20% → raw=12, minOQ=100 → 100.
    expect(
      calculateRecommendedOrderQuantity(10, {
        safetyBufferPercent: 20,
        minOrderQuantity: 100,
      }),
    ).toBe(100);
  });
  it("rounds up to next order_multiple", () => {
    // shortage=1000, buffer=20% → raw=1200, multiple=500 → 1500.
    expect(
      calculateRecommendedOrderQuantity(1000, {
        safetyBufferPercent: 20,
        orderMultiple: 500,
      }),
    ).toBe(1500);
  });
  it("min then multiple — both apply", () => {
    // shortage=50 → raw=60. minOQ=100 lifts to 100. multiple=300 → 300.
    expect(
      calculateRecommendedOrderQuantity(50, {
        safetyBufferPercent: 20,
        minOrderQuantity: 100,
        orderMultiple: 300,
      }),
    ).toBe(300);
  });
  it("never returns negative quantity", () => {
    expect(calculateRecommendedOrderQuantity(0, {})).toBe(0);
    expect(calculateRecommendedOrderQuantity(-5, {})).toBe(0);
  });
  it("returns null when shortage is null", () => {
    expect(calculateRecommendedOrderQuantity(null, {})).toBeNull();
  });
});

// ─── 18-19. Signal invariants ─────────────────────────────────────────

describe("deriveShortageSignals — invariants", () => {
  it("HIGH-confidence rec produces a non-empty signal list with no MISSING_CONFIG", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      // Push into shortage so a rec is returned.
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r!.sourceSignals.length).toBeGreaterThan(0);
    const hasMissing = r!.sourceSignals.some((s) => s.kind === "MISSING_CONFIG");
    expect(hasMissing).toBe(false);
  });

  it("MISSING rec carries at least one MISSING_CONFIG signal", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      materialCode: null,
    });
    expect(r!.confidence).toBe("MISSING");
    expect(
      r!.sourceSignals.some(
        (s) => s.kind === "MISSING_CONFIG" && s.meta?.["what"] === "material_code",
      ),
    ).toBe(true);
  });

  it("usage rate signal carries window_days metadata", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    const usage = r!.sourceSignals.find((s) => s.kind === "DAILY_USAGE_RATE");
    expect(usage).toBeDefined();
    expect(usage!.meta?.["window_days"]).toBe(14);
  });
});

// ─── 20. Compatibility required raises severity ───────────────────────

describe("compatibility.required flag", () => {
  it("raises CRITICAL when required + zero accepted, regardless of par_level", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      acceptedInventory: 0,
      currentOnHand: 0,
      parLevel: null,
      productionTargetDemand: null,
    });
    expect(r!.severity).toBe("CRITICAL");
  });
  it("downgrades severity when same situation but compatibilityRequired=false", () => {
    // Keep some inventory so the runout-today branch doesn't fire;
    // the test wants to isolate the required-flag effect.
    const r = deriveShortageRecommendation({
      ...baseline(),
      compatibilityRequired: false,
      acceptedInventory: 100,
      currentOnHand: 100,
      productionTargetDemand: null,
    });
    expect(r!.severity).not.toBe("CRITICAL");
  });
});

// ─── 21. Hysteresis ───────────────────────────────────────────────────

describe("shouldKeepExistingRecommendation — 1.2× hysteresis", () => {
  it("returns false when there was no prior recommendation", () => {
    expect(
      shouldKeepExistingRecommendation(baseline(), {
        projectedShortageQuantity: 0,
        triggerThreshold: 2000,
      }),
    ).toBe(false);
  });
  it("returns true when still in shortage", () => {
    expect(
      shouldKeepExistingRecommendation(
        { ...baseline(), hadActiveRecommendation: true },
        { projectedShortageQuantity: 500, triggerThreshold: 2000 },
      ),
    ).toBe(true);
  });
  it("keeps active rec until on-hand exceeds 1.2× threshold", () => {
    // on-hand 2300 with threshold 2000 → 1.15× → still keep.
    expect(
      shouldKeepExistingRecommendation(
        {
          ...baseline(),
          hadActiveRecommendation: true,
          currentOnHand: 2300,
          acceptedInventory: 2300,
        },
        { projectedShortageQuantity: 0, triggerThreshold: 2000 },
      ),
    ).toBe(true);
  });
  it("withdraws rec once on-hand clears 1.2× threshold", () => {
    // on-hand 2500 with threshold 2000 → 1.25× → withdraw.
    expect(
      shouldKeepExistingRecommendation(
        {
          ...baseline(),
          hadActiveRecommendation: true,
          currentOnHand: 2500,
          acceptedInventory: 2500,
        },
        { projectedShortageQuantity: 0, triggerThreshold: 2000 },
      ),
    ).toBe(false);
  });
});

// ─── 22. Material with no PackTrack history ───────────────────────────

describe("material with no PackTrack history", () => {
  it("returns rec with recommendedSupplierHint null when no recent receipt", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      recentReceipt: null,
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r!.recommendedSupplierHint).toBeNull();
  });
  it("returns supplier hint from MANUAL_LUMA receipt", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
      recentReceipt: {
        receivedAt: new Date("2026-04-01"),
        quantity: 5000,
        source: "MANUAL_LUMA",
        supplier: "Manual Supplier Ltd",
      },
    });
    expect(r!.recommendedSupplierHint).toBe("Manual Supplier Ltd");
  });
});

// ─── 23. Multi-product shared material via deriveShortageRecommendations ──

describe("deriveShortageRecommendations — batch", () => {
  it("skips machine-consumable kinds in the input list", () => {
    const out = deriveShortageRecommendations([
      { ...baseline(), materialKind: "PVC_ROLL" },
      {
        ...baseline(),
        materialId: "deadbeef-dead-4dde-8dde-dededededede",
        currentOnHand: 0,
        acceptedInventory: 0,
      },
    ]);
    expect(out).toHaveLength(1);
    // The output strips materialKind (it's an input-only field); the
    // assertion above is enough — PVC was the first input and was
    // skipped, so the only output is the second (non-PVC) input.
    expect(out[0]!.materialName).toBe("Mango Peach printed card");
  });

  it("emits one rec per input that triggers, never per product (per-product signals carry context)", () => {
    const out = deriveShortageRecommendations([
      {
        ...baseline(),
        currentOnHand: 0,
        acceptedInventory: 0,
      },
      {
        ...baseline(),
        // Same material, different product context — the projector
        // is expected to consolidate before calling this helper.
        // Helper does not consolidate on its own; this test pins
        // the contract.
        materialId: baseline().materialId,
        productSku: "BR-30CT",
        currentOnHand: 0,
        acceptedInventory: 0,
      },
    ]);
    expect(out).toHaveLength(2);
  });
});

// ─── 24. Production target → projected demand ─────────────────────────

describe("projected demand from production target", () => {
  it("uses target when greater than rate × lead", () => {
    const i = {
      ...baseline(),
      dailyUsageRate: 100, // → rate*lead = 700
      leadTimeDays: 7,
      productionTargetDemand: 10000,
    };
    const { projectedDemand, projectedShortage } = calculateProjectedShortage(i);
    expect(projectedDemand).toBe(10000);
    // accepted = 6000 → shortage = 4000
    expect(projectedShortage).toBe(4000);
  });

  it("uses rate*lead when target is null", () => {
    const i = {
      ...baseline(),
      productionTargetDemand: null,
      dailyUsageRate: 1200,
      leadTimeDays: 7,
    };
    const { projectedDemand } = calculateProjectedShortage(i);
    expect(projectedDemand).toBe(8400);
  });
});

// ─── 25. Usage-rate demand ────────────────────────────────────────────

describe("rate-based demand and runout date", () => {
  it("runout = on_hand / rate days from now", () => {
    const i = {
      ...baseline(),
      currentOnHand: 1200,
      acceptedInventory: 1200,
      dailyUsageRate: 100,
    };
    const r = calculateRunoutDate(i);
    expect(r).not.toBeNull();
    const days = (r!.getTime() - NOW.getTime()) / 86400000;
    expect(days).toBeCloseTo(12, 1);
  });

  it("runout null when rate is 0 or null", () => {
    expect(
      calculateRunoutDate({ ...baseline(), dailyUsageRate: 0 }),
    ).toBeNull();
    expect(
      calculateRunoutDate({ ...baseline(), dailyUsageRate: null }),
    ).toBeNull();
  });

  it("runout = today when on_hand already zero", () => {
    const r = calculateRunoutDate({
      ...baseline(),
      currentOnHand: 0,
      dailyUsageRate: 100,
    });
    expect(r!.toISOString()).toBe(NOW.toISOString());
  });
});

// ─── 26. Stale data lowers confidence ─────────────────────────────────

describe("stale data lowers confidence", () => {
  it("short consumption window (3 days) drops to MEDIUM", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        usageWindowDays: 3,
      }),
    ).toBe("MEDIUM");
  });
  it("zero-day window forces MISSING", () => {
    expect(
      classifyShortageConfidence({
        ...baseline(),
        usageWindowDays: 0,
      }),
    ).toBe("MISSING");
  });
});

// ─── 27-28. Sendable-to-PackTrack invariants ─────────────────────────

describe("isRecommendationSendableToPackTrack", () => {
  it("false when confidence MISSING", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      materialCode: null,
    });
    expect(isRecommendationSendableToPackTrack(r!)).toBe(false);
  });

  it("true for HIGH confidence with material_code and positive quantity", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r!.confidence).toBe("HIGH");
    expect(isRecommendationSendableToPackTrack(r!)).toBe(true);
  });

  it("true for MEDIUM confidence too", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      inventorySource: "SUPPLIER_DECLARED",
      inventoryConfidence: "MEDIUM",
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r!.confidence).toBe("MEDIUM");
    expect(isRecommendationSendableToPackTrack(r!)).toBe(true);
  });

  it("true for LOW confidence with material code + quantity", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      inventorySource: "LEGACY_IMPORT",
      inventoryConfidence: "LOW",
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r!.confidence).toBe("LOW");
    expect(isRecommendationSendableToPackTrack(r!)).toBe(true);
  });

  it("false when recommendedOrderQuantity is zero (no shortage)", () => {
    // Force a path that emits a rec (compatibility required) but
    // with zero shortage — quantity 0 → not sendable.
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 50000,
      acceptedInventory: 50000,
      compatibilityRequired: true,
      productionTargetDemand: 1,
    });
    // High inventory means no shortage; the rec emits because
    // required=true. quantity should be 0 → not sendable.
    if (r) {
      expect(r.recommendedOrderQuantity).toBe(0);
      expect(r.sendableToPackTrack).toBe(false);
    }
  });
});

// ─── 29. Reason is a human-readable single sentence ───────────────────

describe("recommendation.reason", () => {
  it("is a single sentence with a terminating period", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    expect(r!.reason).toMatch(/\.$/);
    expect(r!.reason.split(". ").length).toBeLessThanOrEqual(2); // one sentence (+ optional trailing)
  });

  it("names the material and the runout date when projecting", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 1200,
      acceptedInventory: 1200,
      dailyUsageRate: 100,
      compatibilityRequired: false,
    });
    expect(r!.reason).toMatch(/Mango Peach printed card/);
    // Runout = ~12 days from NOW → 2026-05-25.
    expect(r!.reason).toMatch(/2026-05-25/);
  });
});

// ─── 30. Banned misleading language absent ────────────────────────────

describe("banned-language scan on derived recommendations", () => {
  const banned = [/production loss/i, /supplier shortage/i, /known[_\s-]?loss/i];

  it("HIGH path doesn't use any banned phrase in reason or signals", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      currentOnHand: 0,
      acceptedInventory: 0,
    });
    const all = [
      r!.reason,
      ...r!.sourceSignals.map((s) => s.label),
      ...r!.warnings,
    ].join("\n");
    for (const re of banned) expect(all).not.toMatch(re);
  });

  it("MISSING-path uses 'manual review required' phrasing, not silent zero", () => {
    const r = deriveShortageRecommendation({
      ...baseline(),
      materialCode: null,
    });
    expect(r!.warnings.some((w) => /manual review required/i.test(w))).toBe(true);
    expect(r!.recommendedOrderQuantity).toBeNull();
  });
});
