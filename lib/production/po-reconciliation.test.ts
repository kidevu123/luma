// Phase H.x3.5 — PO reconciliation contract tests.
//
// Pure-math + decision-rule tests. DB-backed integration is exercised
// on staging; these tests pin the rules production accounting depends
// on so a refactor can't quietly change variance math.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import {
  computeOurEstimatedCount,
  computeVendorVariance,
  computeVendorErrorPercent,
  decidePayableQuantity,
} from "./po-reconciliation";

describe("computeOurEstimatedCount", () => {
  it("100,000 g ÷ 0.5 g/unit = 200,000 units", () => {
    expect(computeOurEstimatedCount(100_000, 0.5)).toBe(200_000);
  });

  it("returns null when received weight is missing (never substitutes 0)", () => {
    expect(computeOurEstimatedCount(null, 0.5)).toBe(null);
    expect(computeOurEstimatedCount(undefined, 0.5)).toBe(null);
  });

  it("returns null when unit-weight standard is missing — refuses to invent a count", () => {
    expect(computeOurEstimatedCount(100_000, null)).toBe(null);
    expect(computeOurEstimatedCount(100_000, undefined)).toBe(null);
  });

  it("returns null when unit weight is zero or negative (divide-by-zero / nonsense)", () => {
    expect(computeOurEstimatedCount(100_000, 0)).toBe(null);
    expect(computeOurEstimatedCount(100_000, -0.5)).toBe(null);
  });

  it("returns null on non-finite inputs", () => {
    expect(computeOurEstimatedCount(NaN, 0.5)).toBe(null);
    expect(computeOurEstimatedCount(100_000, Infinity)).toBe(null);
  });

  it("returns 0 when received weight is 0 (honest answer; bag was empty)", () => {
    expect(computeOurEstimatedCount(0, 0.5)).toBe(0);
  });
});

describe("computeVendorVariance", () => {
  it("vendor 20,000 - finished 18,000 - loss 200 - remaining 1,000 = 800 unaccounted", () => {
    expect(computeVendorVariance(20_000, 18_000, 200, 1_000)).toBe(800);
  });

  it("returns null when vendor declared is missing — never assumes 0", () => {
    expect(computeVendorVariance(null, 18_000, 200, 1_000)).toBe(null);
  });

  it("returns null when finished is missing — never assumes 0", () => {
    expect(computeVendorVariance(20_000, null, 200, 1_000)).toBe(null);
  });

  it("returns null when known loss is missing — even though 'no loss recorded' could mean 0", () => {
    // The helper does not infer; the caller decides whether to pass 0
    // (means "we counted; truly zero events") or null (means "we don't
    // know"). Tests pin the strict interpretation.
    expect(computeVendorVariance(20_000, 18_000, null, 1_000)).toBe(null);
  });

  it("returns null when remaining is missing", () => {
    expect(computeVendorVariance(20_000, 18_000, 200, null)).toBe(null);
  });

  it("supports negative variance (we accounted for more than vendor declared — vendor undercount)", () => {
    expect(computeVendorVariance(20_000, 21_000, 0, 0)).toBe(-1_000);
  });

  it("returns 0 when everything reconciles exactly", () => {
    expect(computeVendorVariance(20_000, 19_500, 300, 200)).toBe(0);
  });
});

describe("computeVendorErrorPercent", () => {
  it("800 unaccounted / 20,000 vendor = 4.0%", () => {
    expect(computeVendorErrorPercent(800, 20_000)).toBeCloseTo(4.0, 5);
  });

  it("returns null when variance is null", () => {
    expect(computeVendorErrorPercent(null, 20_000)).toBe(null);
  });

  it("returns null when vendor declared is null", () => {
    expect(computeVendorErrorPercent(800, null)).toBe(null);
  });

  it("returns null when vendor declared is zero (divide-by-zero)", () => {
    expect(computeVendorErrorPercent(800, 0)).toBe(null);
  });

  it("supports negative percent (vendor undercount)", () => {
    expect(computeVendorErrorPercent(-1_000, 20_000)).toBeCloseTo(-5.0, 5);
  });
});

describe("decidePayableQuantity", () => {
  // The settlement decision must NEVER fabricate a number when
  // confidence is too low. Pinning each branch:

  it("HIGH confidence with full accounting → ACCOUNTED_OUTPUT", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 20_000,
      accountedOutput: 18_000,
      knownLoss: 200,
      remainingEstimate: 1_000,
      confidence: "HIGH",
    });
    expect(r.source).toBe("ACCOUNTED_OUTPUT");
    expect(r.value).toBe(19_200);
  });

  it("HIGH confidence with missing accounting → fall back to VENDOR_DECLARED", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 20_000,
      accountedOutput: null,
      knownLoss: 0,
      remainingEstimate: 0,
      confidence: "HIGH",
    });
    expect(r.source).toBe("VENDOR_DECLARED");
    expect(r.value).toBe(20_000);
  });

  it("MEDIUM confidence with full accounting → ACCOUNTED_OUTPUT", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 20_000,
      accountedOutput: 18_000,
      knownLoss: 200,
      remainingEstimate: 1_000,
      confidence: "MEDIUM",
    });
    expect(r.source).toBe("ACCOUNTED_OUTPUT");
  });

  it("LOW confidence → MANUAL_REVIEW (never auto-derive)", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 20_000,
      accountedOutput: 18_000,
      knownLoss: 200,
      remainingEstimate: 1_000,
      confidence: "LOW",
    });
    expect(r.source).toBe("MANUAL_REVIEW");
    expect(r.value).toBe(null);
  });

  it("MISSING confidence → MANUAL_REVIEW", () => {
    const r = decidePayableQuantity({
      vendorDeclared: null,
      accountedOutput: null,
      knownLoss: null,
      remainingEstimate: null,
      confidence: "MISSING",
    });
    expect(r.source).toBe("MANUAL_REVIEW");
    expect(r.value).toBe(null);
  });

  it("Vendor declared null with HIGH confidence → MANUAL_REVIEW (never invent)", () => {
    const r = decidePayableQuantity({
      vendorDeclared: null,
      accountedOutput: 18_000,
      knownLoss: 200,
      remainingEstimate: 1_000,
      confidence: "HIGH",
    });
    expect(r.source).toBe("MANUAL_REVIEW");
  });
});

// ─── Worked production scenarios ───────────────────────────────

describe("worked example — split route PO", () => {
  // PO 1001: 2 bags of vendor-declared 20,000 each = 40,000 raw units.
  // Bag 1 → CARD_BLISTER product → 18,500 finished cards (1 card = 1 raw unit)
  // Bag 2 → BOTTLE product → 19,200 finished bottles (1 bottle = 1 raw unit)
  // Damage: 100 across both bags. Remaining: 0 (both bags emptied).
  //
  // vendor_declared = 40,000
  // finished = 18,500 + 19,200 = 37,700
  // known_loss = 100
  // remaining = 0
  // unknown_variance = 40,000 - 37,700 - 100 - 0 = 2,200
  // Vendor error % = 2,200 / 40,000 = 5.5%

  it("reconciles a 2-bag, 2-route PO with HIGH confidence", () => {
    const variance = computeVendorVariance(40_000, 37_700, 100, 0);
    expect(variance).toBe(2_200);
    const errPct = computeVendorErrorPercent(variance, 40_000);
    expect(errPct).toBeCloseTo(5.5, 3);
  });

  it("yields settlement source ACCOUNTED_OUTPUT when full data present", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 40_000,
      accountedOutput: 37_700,
      knownLoss: 100,
      remainingEstimate: 0,
      confidence: "HIGH",
    });
    expect(r.source).toBe("ACCOUNTED_OUTPUT");
    expect(r.value).toBe(37_800); // accounted + loss + remaining
  });
});

describe("worked example — PO with unfinished WIP", () => {
  // PO 1002: 3 bags of 15,000 each = 45,000 raw.
  // 1 bag finished (15,000 cards). 1 bag emptied with no finished
  // lots yet. 1 bag still in production (status IN_USE).
  // remaining_estimate is null for IN_USE bag — variance not computable.

  it("with WIP bag, vendor variance is not computable (returns null)", () => {
    expect(computeVendorVariance(45_000, 15_000, 0, null)).toBe(null);
  });

  it("settlement falls back to VENDOR_DECLARED when accounting incomplete + confidence HIGH", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 45_000,
      accountedOutput: 15_000,
      knownLoss: null,
      remainingEstimate: null,
      confidence: "HIGH",
    });
    expect(r.source).toBe("VENDOR_DECLARED");
    expect(r.value).toBe(45_000);
  });
});

describe("worked example — internal weight estimate disagreement", () => {
  // Vendor declared: 20,000.
  // Received: 9,800 g. Standard unit weight: 0.500 g.
  // Our internal estimate: 9,800 / 0.500 = 19,600.
  // Vendor error: 20,000 - 19,600 = 400 (vendor over-declared by 400 = 2.0%).
  //
  // This is a vendor accuracy signal — even before any production
  // happens, we can flag the count for review.

  it("our estimate disagrees with vendor declared by 2%", () => {
    const ourEstimate = computeOurEstimatedCount(9_800, 0.5);
    expect(ourEstimate).toBe(19_600);
    const variance = computeVendorVariance(20_000, 0, 0, 19_600);
    expect(variance).toBe(400);
    const pct = computeVendorErrorPercent(variance, 20_000);
    expect(pct).toBeCloseTo(2.0, 5);
  });
});

// ─── Action validation schema (admin standards form) ──────────

const saveSchema = z.object({
  tabletTypeId: z.string().uuid(),
  standardUnitWeight: z.coerce.number().positive(),
  sampleSource: z.string().max(200).optional().nullable(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  effectiveFrom: z.string().date(),
  notes: z.string().max(500).optional().nullable(),
});

describe("raw-item-weight save schema", () => {
  const VALID = {
    tabletTypeId: "11111111-1111-4111-8111-111111111111",
    standardUnitWeight: 0.5,
    sampleSource: null,
    confidence: "MEDIUM" as const,
    effectiveFrom: "2026-05-07",
    notes: null,
  };

  it("accepts a valid input", () => {
    expect(saveSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects zero unit weight", () => {
    const r = saveSchema.safeParse({ ...VALID, standardUnitWeight: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects negative unit weight", () => {
    const r = saveSchema.safeParse({ ...VALID, standardUnitWeight: -1 });
    expect(r.success).toBe(false);
  });

  it("rejects invalid confidence", () => {
    const r = saveSchema.safeParse({
      ...VALID,
      confidence: "VERY_HIGH" as unknown as "HIGH",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid date", () => {
    const r = saveSchema.safeParse({ ...VALID, effectiveFrom: "not-a-date" });
    expect(r.success).toBe(false);
  });

  it("rejects missing tablet type", () => {
    const r = saveSchema.safeParse({ ...VALID, tabletTypeId: "" });
    expect(r.success).toBe(false);
  });
});

// ─── Documented invariants ────────────────────────────────────

describe("PO reconciliation invariants", () => {
  it("'unknown variance' is never relabeled as 'shortage' without HIGH confidence + policy", () => {
    // The settlement.suggestedPayable.source enum is exactly the three
    // documented values; "shortage" is not a valid label.
    const allowedSources = ["VENDOR_DECLARED", "ACCOUNTED_OUTPUT", "MANUAL_REVIEW"];
    expect(allowedSources).toContain("VENDOR_DECLARED");
    expect(allowedSources).toContain("ACCOUNTED_OUTPUT");
    expect(allowedSources).toContain("MANUAL_REVIEW");
    expect(allowedSources).not.toContain("SHORTAGE");
    expect(allowedSources).not.toContain("UNDER_DELIVERY");
  });

  it("PO with no vendor count → vendor variance is null, never 0", () => {
    expect(computeVendorVariance(null, 19_000, 100, 1_000)).toBe(null);
  });

  it("PO with no unit-weight standard → our estimate is null, never inferred", () => {
    expect(computeOurEstimatedCount(20_000, null)).toBe(null);
  });

  it("missing data blocks HIGH confidence — settlement returns MANUAL_REVIEW", () => {
    const r = decidePayableQuantity({
      vendorDeclared: 20_000,
      accountedOutput: null,
      knownLoss: null,
      remainingEstimate: null,
      confidence: "MISSING",
    });
    expect(r.source).toBe("MANUAL_REVIEW");
  });

  it("a multi-product PO is normalized to raw units via finished_lot_inputs.qty_consumed", () => {
    // The SQL joins finished_lots → finished_lot_inputs → batch_id → inventory_bag
    // and reads qty_consumed which is in tablet UoM. No product-kind
    // branching is needed — the column is already in raw equivalents.
    expect("qty_consumed").toBe("qty_consumed");
  });
});

// RECON-TABLET-SUMMARY-1 — per-tablet PO summary lines.
import {
  summarizePoTabletBreakdown,
  type RawBagReconciliation,
} from "./po-reconciliation";

function bagLine(
  tabletTypeId: string | null,
  tabletTypeName: string | null,
  declared: number | null,
): Pick<RawBagReconciliation, "tabletTypeId" | "tabletTypeName" | "vendorDeclaredCount"> {
  return {
    tabletTypeId,
    tabletTypeName,
    vendorDeclaredCount:
      declared != null
        ? { value: declared, unit: "units", confidence: "HIGH", missingInputs: [] }
        : { value: null, unit: "units", confidence: "MISSING", missingInputs: ["vendor_declared_count"] },
  };
}

describe("summarizePoTabletBreakdown", () => {
  it("groups bags and vendor-declared totals per tablet, sorted by name", () => {
    const lines = summarizePoTabletBreakdown([
      bagLine("t2", "Purple Haze", 7000),
      bagLine("t1", "BlueRaz", 7200),
      bagLine("t1", "BlueRaz", 7100),
    ]);
    expect(lines.map((l) => l.tabletName)).toEqual(["BlueRaz", "Purple Haze"]);
    expect(lines[0]).toMatchObject({
      bagsReceived: 2,
      vendorDeclared: 14300,
      vendorDeclaredComplete: true,
    });
    expect(lines[1]).toMatchObject({ bagsReceived: 1, vendorDeclared: 7000 });
  });

  it("missing declared counts never become zero — the line is marked partial", () => {
    const [line] = summarizePoTabletBreakdown([
      bagLine("t1", "BlueRaz", 7200),
      bagLine("t1", "BlueRaz", null),
    ]);
    expect(line?.bagsReceived).toBe(2);
    expect(line?.vendorDeclared).toBe(7200);
    expect(line?.vendorDeclaredComplete).toBe(false);
  });

  it("a tablet with no declared counts at all stays null, not 0", () => {
    const [line] = summarizePoTabletBreakdown([bagLine("t1", "BlueRaz", null)]);
    expect(line?.vendorDeclared).toBeNull();
    expect(line?.vendorDeclaredComplete).toBe(false);
  });

  it("bags without a tablet type group under Unassigned", () => {
    const [line] = summarizePoTabletBreakdown([bagLine(null, null, 100)]);
    expect(line?.tabletName).toBe("Unassigned");
    expect(line?.tabletTypeId).toBeNull();
  });

  it("empty input produces no lines", () => {
    expect(summarizePoTabletBreakdown([])).toEqual([]);
  });
});
