// INTAKE-WORKFLOW-1 — pure-helper tests for the raw-bag intake.

import { describe, expect, it } from "vitest";
import {
  assignQrCodesFromPool,
  computeReceivedTotal,
  computeVariance,
  derivePoVerificationStatus,
  detectDuplicatesInPayload,
  distributeDeclaredTotal,
  generateBagRowSeed,
  preflightRawBagIntake,
  rawBagIntakeInputSchema,
  splitReceiptStart,
  validateBagRowSeeds,
  verificationStatusLabel,
} from "@/lib/production/raw-bag-intake";

// ─── splitReceiptStart ──────────────────────────────────────────────────

describe("splitReceiptStart", () => {
  it("parses plain integer", () => {
    expect(splitReceiptStart("1001")).toEqual({ prefix: "", number: 1001, padding: 4 });
  });
  it("parses QA-R1001", () => {
    expect(splitReceiptStart("QA-R1001")).toEqual({
      prefix: "QA-R",
      number: 1001,
      padding: 4,
    });
  });
  it("parses R-007 (3-wide padding)", () => {
    expect(splitReceiptStart("R-007")).toEqual({ prefix: "R-", number: 7, padding: 3 });
  });
  it("no-digit input returns prefix only", () => {
    expect(splitReceiptStart("ABC")).toEqual({ prefix: "ABC", number: 1, padding: 0 });
  });
  it("empty input returns sane defaults", () => {
    expect(splitReceiptStart("")).toEqual({ prefix: "", number: 1, padding: 0 });
  });
  it("trims whitespace", () => {
    expect(splitReceiptStart("  1001  ").prefix).toBe("");
    expect(splitReceiptStart("  1001  ").number).toBe(1001);
  });
});

// ─── generateBagRowSeed ────────────────────────────────────────────────

describe("generateBagRowSeed", () => {
  it("creates exactly N rows", () => {
    expect(generateBagRowSeed({ count: 10, receiptStart: "1001" })).toHaveLength(10);
  });

  it("auto-increments receipt numbers from 1001 to 1010", () => {
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    expect(rows.map((r) => r.receiptNumber)).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
      "1006",
      "1007",
      "1008",
      "1009",
      "1010",
    ]);
  });

  it("respects QA prefix", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "QA-R1001" });
    expect(rows.map((r) => r.receiptNumber)).toEqual(["QA-R1001", "QA-R1002", "QA-R1003"]);
  });

  it("preserves zero-padding when start has padding", () => {
    const rows = generateBagRowSeed({ count: 4, receiptStart: "R-007" });
    expect(rows.map((r) => r.receiptNumber)).toEqual(["R-007", "R-008", "R-009", "R-010"]);
  });

  it("explicit prefix override", () => {
    const rows = generateBagRowSeed({
      count: 3,
      receiptStart: "1001",
      receiptPrefix: "QA-R",
    });
    expect(rows.map((r) => r.receiptNumber)).toEqual(["QA-R1001", "QA-R1002", "QA-R1003"]);
  });

  it("bulk applies declared count to every row", () => {
    const rows = generateBagRowSeed({
      count: 5,
      receiptStart: "1001",
      declaredCount: 20000,
    });
    expect(rows.every((r) => r.declaredCount === 20000)).toBe(true);
  });

  it("bulk applies weight to every row", () => {
    const rows = generateBagRowSeed({
      count: 3,
      receiptStart: "1001",
      weightGrams: 10500,
    });
    expect(rows.every((r) => r.weightGrams === 10500)).toBe(true);
  });

  it("returns empty array for count=0", () => {
    expect(generateBagRowSeed({ count: 0, receiptStart: "1001" })).toEqual([]);
  });

  it("returns empty array for negative count", () => {
    expect(generateBagRowSeed({ count: -5, receiptStart: "1001" })).toEqual([]);
  });

  it("bagSequence is 1-indexed and sequential", () => {
    const rows = generateBagRowSeed({ count: 4, receiptStart: "1001" });
    expect(rows.map((r) => r.bagSequence)).toEqual([1, 2, 3, 4]);
  });

  it("bagQrCode is null on every seed (operator fills in)", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    expect(rows.every((r) => r.bagQrCode === null)).toBe(true);
  });

  it("declaredTotal distributes evenly when divisible", () => {
    const rows = generateBagRowSeed({
      count: 10,
      receiptStart: "1001",
      declaredTotal: 43100,
    });
    expect(rows.every((r) => r.declaredCount === 4310)).toBe(true);
    expect(rows.reduce((s, r) => s + (r.declaredCount ?? 0), 0)).toBe(43100);
  });

  it("declaredTotal distributes remainder to first bags", () => {
    const rows = generateBagRowSeed({
      count: 3,
      receiptStart: "1001",
      declaredTotal: 10,
    });
    // 10 / 3 = 3 remainder 1 → [4, 3, 3]
    expect(rows.map((r) => r.declaredCount)).toEqual([4, 3, 3]);
    expect(rows.reduce((s, r) => s + (r.declaredCount ?? 0), 0)).toBe(10);
  });

  it("sum of declaredTotal rows always equals total", () => {
    // edge case: 43100 across 7 bags
    const rows = generateBagRowSeed({
      count: 7,
      receiptStart: "1",
      declaredTotal: 43100,
    });
    expect(rows.reduce((s, r) => s + (r.declaredCount ?? 0), 0)).toBe(43100);
  });

  it("declaredCount (per-bag) still broadcasts to all rows", () => {
    const rows = generateBagRowSeed({
      count: 5,
      receiptStart: "1001",
      declaredCount: 4310,
    });
    expect(rows.every((r) => r.declaredCount === 4310)).toBe(true);
  });
});

// ─── distributeDeclaredTotal ───────────────────────────────────────────

describe("distributeDeclaredTotal", () => {
  it("returns empty array for zero bags", () => {
    expect(distributeDeclaredTotal(100, 0)).toEqual([]);
  });

  it("returns empty array for zero total", () => {
    expect(distributeDeclaredTotal(0, 10)).toEqual([]);
  });

  it("exact division — all bags equal", () => {
    expect(distributeDeclaredTotal(100, 4)).toEqual([25, 25, 25, 25]);
  });

  it("remainder distributed to first bags", () => {
    // 10 / 3 = 3r1 → [4, 3, 3]
    expect(distributeDeclaredTotal(10, 3)).toEqual([4, 3, 3]);
  });

  it("sum always equals total", () => {
    for (const [total, count] of [[43100, 10], [1, 3], [99999, 7], [5, 5]]) {
      const arr = distributeDeclaredTotal(total!, count!);
      expect(arr.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

// ─── assignQrCodesFromPool ────────────────────────────────────────────

describe("assignQrCodesFromPool", () => {
  it("assigns pool tokens to rows in order", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    const pool = [
      { scanToken: "bag-card-1" },
      { scanToken: "bag-card-2" },
      { scanToken: "bag-card-3" },
    ];
    const result = assignQrCodesFromPool(rows, pool);
    expect(result.map((r) => r.bagQrCode)).toEqual([
      "bag-card-1",
      "bag-card-2",
      "bag-card-3",
    ]);
  });

  it("fills with null when pool is smaller than rows", () => {
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    const pool = [{ scanToken: "bag-card-1" }, { scanToken: "bag-card-2" }];
    const result = assignQrCodesFromPool(rows, pool);
    expect(result.map((r) => r.bagQrCode)).toEqual([
      "bag-card-1",
      "bag-card-2",
      null,
      null,
      null,
    ]);
  });

  it("fills all nulls when pool is empty", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    const result = assignQrCodesFromPool(rows, []);
    expect(result.every((r) => r.bagQrCode === null)).toBe(true);
  });

  it("all rows assigned when pool is larger than rows", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001" });
    const pool = [
      { scanToken: "bag-card-1" },
      { scanToken: "bag-card-2" },
      { scanToken: "bag-card-3" }, // extra — not used
    ];
    const result = assignQrCodesFromPool(rows, pool);
    expect(result.map((r) => r.bagQrCode)).toEqual(["bag-card-1", "bag-card-2"]);
  });

  it("returns empty array for empty rows", () => {
    const result = assignQrCodesFromPool([], [{ scanToken: "bag-card-1" }]);
    expect(result).toHaveLength(0);
  });

  it("does not mutate input rows", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001" });
    const originalQrCodes = rows.map((r) => r.bagQrCode);
    assignQrCodesFromPool(rows, [{ scanToken: "bag-card-1" }]);
    expect(rows.map((r) => r.bagQrCode)).toEqual(originalQrCodes);
  });
});

// ─── kg/grams round-trip conversion ──────────────────────────────────

describe("kg/grams round-trip conversion", () => {
  it("12.5 kg → 12500 g", () => {
    expect(Math.round(12.5 * 1000)).toBe(12500);
  });

  it("0.001 kg → 1 g (minimum precision)", () => {
    expect(Math.round(0.001 * 1000)).toBe(1);
  });

  it("12500 g → 12.5 kg", () => {
    expect(12500 / 1000).toBe(12.5);
  });

  it("1 g → 0.001 kg", () => {
    expect(1 / 1000).toBe(0.001);
  });

  it("NaN input is guarded (form contract)", () => {
    const g = Math.round(Number("abc") * 1000);
    expect(Number.isFinite(g)).toBe(false);
  });
});

// ─── detectDuplicatesInPayload ─────────────────────────────────────────

describe("detectDuplicatesInPayload", () => {
  it("flags duplicate receipt numbers", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    rows[2]!.receiptNumber = "1001"; // collide with row 1
    const issues = detectDuplicatesInPayload(rows);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.field === "receiptNumber" && i.reason === "duplicate_in_payload")).toBe(true);
  });

  it("flags duplicate QR codes", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    rows[0]!.bagQrCode = "QR-A";
    rows[1]!.bagQrCode = "QR-A";
    rows[2]!.bagQrCode = "QR-B";
    const issues = detectDuplicatesInPayload(rows);
    expect(issues.filter((i) => i.field === "bagQrCode").length).toBe(2);
  });

  it("does NOT flag empty QR codes as duplicates of each other", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    // every bagQrCode is null by default
    const issues = detectDuplicatesInPayload(rows);
    expect(issues.filter((i) => i.field === "bagQrCode" && i.reason === "duplicate_in_payload")).toHaveLength(0);
  });

  it("returns empty array when no duplicates", () => {
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    expect(detectDuplicatesInPayload(rows)).toEqual([]);
  });
});

// ─── validateBagRowSeeds ───────────────────────────────────────────────

describe("validateBagRowSeeds", () => {
  it("flags missing QR when requireQr=true", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001", declaredCount: 20000 });
    const issues = validateBagRowSeeds(rows, { requireQr: true, requireDeclaredCount: true });
    expect(issues.filter((i) => i.field === "bagQrCode" && i.reason === "missing").length).toBe(3);
  });

  it("flags missing declared count when requireDeclaredCount=true", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" }).map((r) => ({
      ...r,
      bagQrCode: `QR-${r.bagSequence}`,
    }));
    const issues = validateBagRowSeeds(rows, { requireQr: true, requireDeclaredCount: true });
    expect(issues.filter((i) => i.field === "declaredCount" && i.reason === "missing").length).toBe(3);
  });

  it("flags non-positive declared count", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001", declaredCount: 20000 }).map((r, i) => ({
      ...r,
      bagQrCode: `QR-${r.bagSequence}`,
      declaredCount: i === 0 ? 0 : 20000,
    }));
    const issues = validateBagRowSeeds(rows);
    expect(issues.some((i) => i.field === "declaredCount" && i.reason === "must_be_positive")).toBe(true);
  });

  it("flags missing receipt number", () => {
    const rows = generateBagRowSeed({ count: 1, receiptStart: "1001", declaredCount: 20000 });
    rows[0]!.receiptNumber = "";
    const issues = validateBagRowSeeds(rows, { requireQr: false, requireDeclaredCount: false });
    expect(issues.some((i) => i.field === "receiptNumber" && i.reason === "missing")).toBe(true);
  });

  it("clean row passes with QR + declared count present", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001", declaredCount: 20000 }).map((r) => ({
      ...r,
      bagQrCode: `QR-${r.bagSequence}`,
    }));
    expect(validateBagRowSeeds(rows)).toEqual([]);
  });
});

// ─── Variance ─────────────────────────────────────────────────────────

describe("computeReceivedTotal", () => {
  it("sums declared counts", () => {
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001", declaredCount: 20000 });
    expect(computeReceivedTotal(rows)).toBe(200000);
  });

  it("treats null declared count as 0", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    expect(computeReceivedTotal(rows)).toBe(0);
  });
});

describe("computeVariance", () => {
  it("EXACT when received equals ordered", () => {
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001", declaredCount: 20000 });
    const v = computeVariance({ rows, orderedQuantity: 200000 });
    expect(v.status).toBe("EXACT");
    expect(v.variance).toBe(0);
  });

  it("PARTIAL when received below ordered", () => {
    const rows = generateBagRowSeed({ count: 9, receiptStart: "1001", declaredCount: 20000 });
    const v = computeVariance({ rows, orderedQuantity: 200000 });
    expect(v.status).toBe("PARTIAL");
    expect(v.variance).toBe(-20000);
  });

  it("OVER when received above ordered", () => {
    const rows = generateBagRowSeed({ count: 11, receiptStart: "1001", declaredCount: 20000 });
    const v = computeVariance({ rows, orderedQuantity: 200000 });
    expect(v.status).toBe("OVER");
    expect(v.variance).toBe(20000);
  });

  it("UNKNOWN when ordered is null", () => {
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001", declaredCount: 20000 });
    const v = computeVariance({ rows, orderedQuantity: null });
    expect(v.status).toBe("UNKNOWN");
    expect(v.variance).toBeNull();
    expect(v.receivedQuantity).toBe(200000);
  });
});

// ─── PO verification status ────────────────────────────────────────────

describe("derivePoVerificationStatus", () => {
  it("local PO + mapping → VERIFIED_LOCAL", () => {
    expect(
      derivePoVerificationStatus({
        localPoFound: true,
        zohoCachedPoFound: false,
        productMappingResolved: true,
        manualOverride: false,
      }),
    ).toBe("VERIFIED_LOCAL");
  });

  it("Zoho cached PO + mapping → VERIFIED_ZOHO", () => {
    expect(
      derivePoVerificationStatus({
        localPoFound: false,
        zohoCachedPoFound: true,
        productMappingResolved: true,
        manualOverride: false,
      }),
    ).toBe("VERIFIED_ZOHO");
  });

  it("manual override → MANUAL_REFERENCE (when product mapping exists)", () => {
    expect(
      derivePoVerificationStatus({
        localPoFound: false,
        zohoCachedPoFound: false,
        productMappingResolved: true,
        manualOverride: true,
      }),
    ).toBe("MANUAL_REFERENCE");
  });

  it("missing product mapping → MISSING_PRODUCT_MAPPING regardless of PO source", () => {
    expect(
      derivePoVerificationStatus({
        localPoFound: true,
        zohoCachedPoFound: false,
        productMappingResolved: false,
        manualOverride: false,
      }),
    ).toBe("MISSING_PRODUCT_MAPPING");
  });
});

describe("verificationStatusLabel — data-honesty copy", () => {
  it("MANUAL_REFERENCE explicitly says not verified", () => {
    const label = verificationStatusLabel("MANUAL_REFERENCE");
    expect(label).toMatch(/not verified/i);
  });
  it("VERIFIED_LOCAL says verified from local", () => {
    expect(verificationStatusLabel("VERIFIED_LOCAL")).toMatch(/local/i);
  });
  it("VERIFIED_ZOHO mentions Zoho", () => {
    expect(verificationStatusLabel("VERIFIED_ZOHO")).toMatch(/zoho/i);
  });
});

// ─── preflightRawBagIntake — top-level pre-flight ─────────────────────

const validRow = {
  bagSequence: 1,
  receiptNumber: "1001",
  supplierLotNumber: "LOT-TEST-001",
  bagQrCode: "QR-001",
  declaredCount: 20000,
};

describe("preflightRawBagIntake", () => {
  it("OK when LOCAL_PO mode + poId + valid rows", () => {
    const r = preflightRawBagIntake({
      poMode: "LOCAL_PO",
      poId: "00000000-0000-0000-0000-000000000001",
      poLineId: "00000000-0000-0000-0000-000000000002",
      poNumberManual: null,
      vendorNameManual: null,
      orderedQuantity: 200000,
      tabletTypeId: "00000000-0000-0000-0000-000000000003",
      supplierLotNumber: "1243",
      rows: [validRow],
    });
    expect(r.ok).toBe(true);
  });

  it("MANUAL_REFERENCE requires poNumberManual + vendorNameManual", () => {
    const r = preflightRawBagIntake({
      poMode: "MANUAL_REFERENCE",
      poId: null,
      poLineId: null,
      poNumberManual: null,
      vendorNameManual: null,
      orderedQuantity: 200000,
      tabletTypeId: "00000000-0000-0000-0000-000000000003",
      supplierLotNumber: "1243",
      rows: [validRow],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/PO number/);
  });

  it("LOCAL_PO requires poId", () => {
    const r = preflightRawBagIntake({
      poMode: "LOCAL_PO",
      poId: null,
      poLineId: null,
      poNumberManual: null,
      vendorNameManual: null,
      orderedQuantity: 200000,
      tabletTypeId: "00000000-0000-0000-0000-000000000003",
      supplierLotNumber: "1243",
      rows: [validRow],
    });
    expect(r.ok).toBe(false);
  });

  it("invalid Zod shape rejected (negative bag sequence)", () => {
    const r = preflightRawBagIntake({
      poMode: "MANUAL_REFERENCE",
      poId: null,
      poLineId: null,
      poNumberManual: "PO-X",
      vendorNameManual: "V",
      orderedQuantity: 100,
      tabletTypeId: "00000000-0000-0000-0000-000000000003",
      supplierLotNumber: "1243",
      rows: [{ ...validRow, bagSequence: -1 }],
    });
    expect(r.ok).toBe(false);
  });

  it("duplicate receipts surface as issues, not pass", () => {
    const r = preflightRawBagIntake({
      poMode: "MANUAL_REFERENCE",
      poId: null,
      poLineId: null,
      poNumberManual: "PO-X",
      vendorNameManual: "V",
      orderedQuantity: 100,
      tabletTypeId: "00000000-0000-0000-0000-000000000003",
      supplierLotNumber: "1243",
      rows: [
        validRow,
        { ...validRow, bagSequence: 2, receiptNumber: "1001", bagQrCode: "QR-002" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.field === "receiptNumber" && i.reason === "duplicate_in_payload")).toBe(true);
    }
  });
});

// ─── Example acceptance scenario ────────────────────────────────────────

describe("Acceptance — PO-1234 / 10 bags / 20000 each / start 1001", () => {
  it("generates 1001 through 1010 with declared 20000 each", () => {
    const rows = generateBagRowSeed({
      count: 10,
      receiptStart: "1001",
      declaredCount: 20000,
    });
    expect(rows.map((r) => r.receiptNumber)).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
      "1006",
      "1007",
      "1008",
      "1009",
      "1010",
    ]);
    expect(rows.map((r) => r.declaredCount)).toEqual(Array(10).fill(20000));
  });

  it("variance is EXACT when ordered=200000 and 10×20000 received", () => {
    const rows = generateBagRowSeed({
      count: 10,
      receiptStart: "1001",
      declaredCount: 20000,
    });
    const v = computeVariance({ rows, orderedQuantity: 200000 });
    expect(v.status).toBe("EXACT");
    expect(v.receivedQuantity).toBe(200000);
    expect(v.variance).toBe(0);
  });
});

// ─── RECEIVABLE_PO_STATUSES ────────────────────────────────────────────────

import { RECEIVABLE_PO_STATUSES } from "@/lib/production/raw-bag-intake";

describe("RECEIVABLE_PO_STATUSES", () => {
  it("includes OPEN", () => {
    expect(RECEIVABLE_PO_STATUSES).toContain("OPEN");
  });
  it("includes RECEIVING", () => {
    expect(RECEIVABLE_PO_STATUSES).toContain("RECEIVING");
  });
  it("excludes CLOSED", () => {
    expect(RECEIVABLE_PO_STATUSES).not.toContain("CLOSED");
  });
  it("excludes CANCELLED", () => {
    expect(RECEIVABLE_PO_STATUSES).not.toContain("CANCELLED");
  });
  it("excludes DRAFT", () => {
    expect(RECEIVABLE_PO_STATUSES).not.toContain("DRAFT");
  });
  it("excludes RECEIVED", () => {
    expect(RECEIVABLE_PO_STATUSES).not.toContain("RECEIVED");
  });
});

// ─── QR assignment edge cases — RECEIVE-2 ─────────────────────────
describe("QR assignment edge cases — RECEIVE-2", () => {
  it("10 rows with 10-card pool: all rows get unique non-null QR codes", () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const qrCodes = assigned.map((r) => r.bagQrCode).filter((q) => q != null);
    expect(qrCodes).toHaveLength(10);
    expect(new Set(qrCodes).size).toBe(10);
  });

  it("removing a row does not affect remaining rows' QR codes", () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    // Simulate removing row at index 2 (bag-card-3)
    const afterRemoval = assigned.filter((_, idx) => idx !== 2);
    expect(afterRemoval).toHaveLength(4);
    expect(afterRemoval[0]?.bagQrCode).toBe("bag-card-1");
    expect(afterRemoval[1]?.bagQrCode).toBe("bag-card-2");
    expect(afterRemoval[2]?.bagQrCode).toBe("bag-card-4");
    expect(afterRemoval[3]?.bagQrCode).toBe("bag-card-5");
  });

  it("removed row's QR code is absent from remaining rows", () => {
    const pool = [
      { scanToken: "bag-card-1" },
      { scanToken: "bag-card-2" },
      { scanToken: "bag-card-3" },
    ];
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const remaining = assigned.filter((_, idx) => idx !== 1);
    const remainingQrCodes = remaining.map((r) => r.bagQrCode);
    expect(remainingQrCodes).not.toContain("bag-card-2");
    expect(remainingQrCodes).toContain("bag-card-1");
    expect(remainingQrCodes).toContain("bag-card-3");
  });

  it("pool exhaustion: 5-card pool for 10 rows gives nulls for rows 6–10", () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const hasQr = assigned.map((r) => r.bagQrCode != null);
    expect(hasQr).toEqual([
      true, true, true, true, true,
      false, false, false, false, false,
    ]);
  });

  it("empty pool: all rows get null QR codes (no silent assignment)", () => {
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, []);
    expect(assigned.every((r) => r.bagQrCode === null)).toBe(true);
  });

  it("trimming rows after removal updates exhaustion threshold", () => {
    // 8 rows, 5-card pool → rows 6–8 have no QR
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 8, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    // Remove rows 6,7,8 (indices 5,6,7)
    const trimmed = assigned.filter((_, idx) => idx < 5);
    expect(trimmed).toHaveLength(5);
    expect(trimmed.every((r) => r.bagQrCode != null)).toBe(true);
  });
});

// ─── RECEIVE-3: per-row supplier lot seeding ──────────────────────────
describe("generateBagRowSeed — supplierLotNumber seeding", () => {
  it("seeds all rows with the provided supplierLotNumber", () => {
    const rows = generateBagRowSeed({
      count: 3,
      receiptStart: "1001",
      supplierLotNumber: "LOT-ABC-2026",
    });
    expect(rows.every((r) => r.supplierLotNumber === "LOT-ABC-2026")).toBe(true);
  });

  it("seeds empty string when supplierLotNumber is not provided", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001" });
    expect(rows.every((r) => r.supplierLotNumber === "")).toBe(true);
  });

  it("assignQrCodesFromPool preserves supplierLotNumber through spread", () => {
    const pool = [{ scanToken: "bag-card-1" }, { scanToken: "bag-card-2" }];
    const rows = generateBagRowSeed({
      count: 2,
      receiptStart: "1001",
      supplierLotNumber: "LOT-XYZ",
    });
    const assigned = assignQrCodesFromPool(rows, pool);
    expect(assigned[0]?.supplierLotNumber).toBe("LOT-XYZ");
    expect(assigned[1]?.supplierLotNumber).toBe("LOT-XYZ");
  });

  it("seeds supplierLotNumber from input", () => {
    const rows = generateBagRowSeed({
      count: 3,
      receiptStart: "1001",
      supplierLotNumber: "LOT-ABC-001",
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.supplierLotNumber === "LOT-ABC-001")).toBe(true);
  });

  it("trims supplierLotNumber whitespace", () => {
    const rows = generateBagRowSeed({
      count: 2,
      receiptStart: "1001",
      supplierLotNumber: "  LOT-TRIM  ",
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.supplierLotNumber === "LOT-TRIM")).toBe(true);
  });

  it("defaults supplierLotNumber to empty string when not provided", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.supplierLotNumber === "")).toBe(true);
  });
});

// ─── RECEIVE-3: rawBagIntakeInputSchema per-row supplierLotNumber ──────

describe("rawBagIntakeInputSchema — per-row supplierLotNumber", () => {
  const basePayload = {
    poMode: "LOCAL_PO" as const,
    poId: "00000000-0000-0000-0000-000000000001",
    poLineId: null,
    poNumberManual: null,
    vendorNameManual: null,
    orderedQuantity: null,
    tabletTypeId: "00000000-0000-0000-0000-000000000002",
    supplierLotNumber: "LOT-MAIN-001",
    rows: [
      {
        bagSequence: 1,
        receiptNumber: "REC-001",
        bagQrCode: "bag-card-1",
        declaredCount: 1000,
        weightGrams: 500,
        supplierLotNumber: "LOT-MAIN-001",
        notes: null,
      },
    ],
  };

  it("accepts valid payload with per-row supplierLotNumber", () => {
    const result = rawBagIntakeInputSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it("rejects when row supplierLotNumber is blank", () => {
    const payload = {
      ...basePayload,
      rows: [{ ...basePayload.rows[0]!, supplierLotNumber: "" }],
    };
    const result = rawBagIntakeInputSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects when row supplierLotNumber is missing", () => {
    const { supplierLotNumber: _, ...rowWithoutLot } = basePayload.rows[0]!;
    const payload = { ...basePayload, rows: [rowWithoutLot] };
    const result = rawBagIntakeInputSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rows can have different supplierLotNumbers independently", () => {
    const payload = {
      ...basePayload,
      rows: [
        { ...basePayload.rows[0]!, bagSequence: 1, receiptNumber: "REC-001", supplierLotNumber: "LOT-A" },
        { ...basePayload.rows[0]!, bagSequence: 2, receiptNumber: "REC-002", supplierLotNumber: "LOT-B" },
      ],
    };
    const result = rawBagIntakeInputSchema.safeParse(payload);
    if (!result.success) throw new Error("Expected parse to succeed");
    expect(result.data.rows[0]?.supplierLotNumber).toBe("LOT-A");
    expect(result.data.rows[1]?.supplierLotNumber).toBe("LOT-B");
  });

  it("preflightRawBagIntake maps row supplierLotNumber", () => {
    const result = preflightRawBagIntake(basePayload);
    if (!result.ok) throw new Error("Expected ok=true, got: " + result.error);
    expect(result.input.rows[0]?.supplierLotNumber).toBe("LOT-MAIN-001");
  });
});
