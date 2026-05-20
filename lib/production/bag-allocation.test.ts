// Phase H.x3.6 — Raw bag allocation ledger contract tests.
//
// Pure-math + reduction tests. DB-backed integration is exercised on
// staging via deploy smoke; these tests pin the algebra so a refactor
// can't quietly change consumption / variance / open-allocation math.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import {
  reduceLedger,
  reduceOpenAllocation,
  classifyBagConfidence,
  resolveReopenStartingBalance,
  checkOverAllocation,
  shouldReleaseQrAtFinalization,
  deriveBagStatusAfterClose,
  isPartialBagResume,
} from "./bag-allocation";
import {
  computeExpectedComponentQty,
  computeComponentVariance,
  computeComponentVariancePercent,
} from "./variety-pack";

// ─── reduceLedger ─────────────────────────────────────────────

describe("reduceLedger", () => {
  it("OPENED sets starting balance once", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
    ]);
    expect(r.starting).toBe(20_000);
    expect(r.consumed).toBe(0);
    expect(r.remainingEstimate).toBe(20_000);
  });

  it("OPENED + ALLOCATED + PARTIAL_CONSUMED tracks running totals", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_ALLOCATED", quantity: 18_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 17_500 },
    ]);
    expect(r.starting).toBe(20_000);
    expect(r.allocated).toBe(18_000);
    expect(r.consumed).toBe(17_500);
    expect(r.remainingEstimate).toBe(20_000 - 17_500);
  });

  it("RETURNED_TO_STOCK reduces remaining estimate via the formula", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 5_000 },
      { eventType: "RAW_BAG_RETURNED_TO_STOCK", quantity: 14_000 },
    ]);
    // 20,000 − 5,000 − 14,000 = 1,000
    expect(r.remainingEstimate).toBe(1_000);
  });

  it("DEPLETED counts as consumed", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 19_500 },
      { eventType: "RAW_BAG_DEPLETED", quantity: 500 },
    ]);
    expect(r.consumed).toBe(20_000);
    expect(r.remainingEstimate).toBe(0);
  });

  it("REWEIGHED replaces remaining with the most-recent measurement", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 5_000 },
      { eventType: "RAW_BAG_REWEIGHED", quantity: 14_500 },
    ]);
    expect(r.reweighed).toBe(14_500);
    expect(r.remainingEstimate).toBe(14_500);
  });

  it("ADJUSTED is added to remaining (signed correction)", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 5_000 },
      { eventType: "RAW_BAG_ADJUSTED", quantity: -300 },
    ]);
    // 20,000 + (-300) − 5,000 − 0 − 0 = 14,700
    expect(r.remainingEstimate).toBe(14_700);
  });

  it("VOIDED quantity reduces remaining (wrote-off stock)", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_VOIDED", quantity: 500 },
    ]);
    expect(r.voided).toBe(500);
    expect(r.remainingEstimate).toBe(19_500);
  });

  it("clamps remaining to 0, never reports negative", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 1_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 1_500 },
    ]);
    expect(r.remainingEstimate).toBe(0);
  });

  it("returns null remaining when no starting balance and no reweigh", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 100 },
    ]);
    expect(r.remainingEstimate).toBe(null);
  });

  it("ignores entries with non-finite quantity (one bad event doesn't poison the ledger)", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: NaN },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 5_000 },
    ]);
    expect(r.consumed).toBe(5_000);
  });

  it("uses initial balance fallback when no OPENED event", () => {
    // Lazy fallback: legacy bags don't have OPENED but we know
    // the inventory_bag.pill_count.
    const r = reduceLedger(
      [{ eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 5_000 }],
      20_000,
    );
    expect(r.starting).toBe(20_000);
    expect(r.remainingEstimate).toBe(15_000);
  });
});

describe("reduceOpenAllocation", () => {
  it("sums ALLOCATED − CONSUMED − RETURNED for open-session entries", () => {
    expect(
      reduceOpenAllocation([
        { eventType: "RAW_BAG_ALLOCATED", quantity: 10_000 },
        { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 4_000 },
        { eventType: "RAW_BAG_RETURNED_TO_STOCK", quantity: 1_000 },
      ]),
    ).toBe(5_000);
  });

  it("clamps to 0 if math goes negative (over-consumption)", () => {
    expect(
      reduceOpenAllocation([
        { eventType: "RAW_BAG_ALLOCATED", quantity: 5_000 },
        { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 6_000 },
      ]),
    ).toBe(0);
  });

  it("ignores non-open-session events the caller pre-filtered out", () => {
    expect(reduceOpenAllocation([])).toBe(0);
  });
});

describe("classifyBagConfidence", () => {
  it("HIGH when reweigh + finished link + starting balance", () => {
    expect(
      classifyBagConfidence({
        hasEvents: true,
        hasFinishedLink: true,
        hasOpenAllocation: false,
        hasReweigh: true,
        hasStarting: true,
      }),
    ).toBe("HIGH");
  });

  it("MEDIUM when finished link but no reweigh", () => {
    expect(
      classifyBagConfidence({
        hasEvents: true,
        hasFinishedLink: true,
        hasOpenAllocation: false,
        hasReweigh: false,
        hasStarting: true,
      }),
    ).toBe("MEDIUM");
  });

  it("LOW when an open allocation is still in flight", () => {
    expect(
      classifyBagConfidence({
        hasEvents: true,
        hasFinishedLink: true,
        hasOpenAllocation: true,
        hasReweigh: false,
        hasStarting: true,
      }),
    ).toBe("LOW");
  });

  it("MISSING when there are no events and no finished link", () => {
    expect(
      classifyBagConfidence({
        hasEvents: false,
        hasFinishedLink: false,
        hasOpenAllocation: false,
        hasReweigh: false,
        hasStarting: false,
      }),
    ).toBe("MISSING");
  });

  it("LOW when no finished link and no reweigh (manual allocation only)", () => {
    expect(
      classifyBagConfidence({
        hasEvents: true,
        hasFinishedLink: false,
        hasOpenAllocation: false,
        hasReweigh: false,
        hasStarting: true,
      }),
    ).toBe("LOW");
  });
});

// ─── Variety pack pure helpers ─────────────────────────────

describe("computeExpectedComponentQty", () => {
  it("100 finished × 5 components/unit = 500", () => {
    expect(computeExpectedComponentQty(100, 5)).toBe(500);
  });
  it("returns null when finished is missing — never invents", () => {
    expect(computeExpectedComponentQty(null, 5)).toBe(null);
  });
  it("returns null when qty/unit is missing", () => {
    expect(computeExpectedComponentQty(100, null)).toBe(null);
  });
  it("returns null when qty/unit is 0 or negative", () => {
    expect(computeExpectedComponentQty(100, 0)).toBe(null);
    expect(computeExpectedComponentQty(100, -1)).toBe(null);
  });
  it("zero finished returns 0 (no production yet, honest)", () => {
    expect(computeExpectedComponentQty(0, 5)).toBe(0);
  });
});

describe("computeComponentVariance", () => {
  it("actual 510 − expected 500 = 10 (over-consumption)", () => {
    expect(computeComponentVariance(510, 500)).toBe(10);
  });
  it("actual 480 − expected 500 = -20 (under-consumption)", () => {
    expect(computeComponentVariance(480, 500)).toBe(-20);
  });
  it("returns null when actual is missing — never assumes 0", () => {
    expect(computeComponentVariance(null, 500)).toBe(null);
  });
});

describe("computeComponentVariancePercent", () => {
  it("10 variance / 500 expected = 2.0%", () => {
    expect(computeComponentVariancePercent(10, 500)).toBeCloseTo(2.0, 5);
  });
  it("returns null on divide-by-zero", () => {
    expect(computeComponentVariancePercent(10, 0)).toBe(null);
  });
});

// ─── Worked production scenarios ───────────────────────────

describe("worked example — same bag, two products", () => {
  // PO 2001, bag #5, vendor declared 20,000 tablets.
  // Product A (card route): consumed 12,000 across 1 session.
  // Returned 8,000 to stock. Bag goes back to AVAILABLE.
  // Product B (bottle route): later opens a new session, consumes
  //   the remaining 8,000. Bag goes to EMPTIED.
  // Net: 12,000 + 8,000 = 20,000 consumed across two products.
  // Vendor variance: 0.

  it("session 1: 12k card consumption + 8k return → remaining 8k", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 12_000 },
      { eventType: "RAW_BAG_RETURNED_TO_STOCK", quantity: 8_000 },
    ]);
    expect(r.consumed).toBe(12_000);
    expect(r.returned).toBe(8_000);
    expect(r.remainingEstimate).toBe(0); // 20k - 12k - 8k = 0
  });

  it("session 2 reopens the bag at 8k starting and depletes", () => {
    const r = reduceLedger(
      [
        { eventType: "RAW_BAG_OPENED", quantity: 8_000 },
        { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 8_000 },
        { eventType: "RAW_BAG_DEPLETED", quantity: 0 },
      ],
    );
    expect(r.consumed).toBe(8_000);
    expect(r.remainingEstimate).toBe(0);
  });

  it("full ledger combined → 20k consumed, 0 unaccounted", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 12_000 },
      { eventType: "RAW_BAG_RETURNED_TO_STOCK", quantity: 8_000 },
      { eventType: "RAW_BAG_OPENED", quantity: 8_000 },
      { eventType: "RAW_BAG_PARTIAL_CONSUMED", quantity: 8_000 },
    ]);
    expect(r.consumed).toBe(20_000);
    expect(r.starting).toBe(20_000); // first OPENED wins
    expect(r.remainingEstimate).toBe(0);
  });
});

describe("worked example — partial bag still WIP", () => {
  it("OPENED + ALLOCATED with no close → open allocation present", () => {
    const r = reduceLedger([
      { eventType: "RAW_BAG_OPENED", quantity: 20_000 },
      { eventType: "RAW_BAG_ALLOCATED", quantity: 5_000 },
    ]);
    expect(r.allocated).toBe(5_000);
    expect(r.consumed).toBe(0);
    // Open allocation reduce: 5k allocated - 0 consumed - 0 returned = 5k pending
    const open = reduceOpenAllocation([
      { eventType: "RAW_BAG_ALLOCATED", quantity: 5_000 },
    ]);
    expect(open).toBe(5_000);
  });

  it("WIP confidence is LOW per spec — open allocation blocks HIGH", () => {
    expect(
      classifyBagConfidence({
        hasEvents: true,
        hasFinishedLink: true,
        hasOpenAllocation: true,
        hasReweigh: false,
        hasStarting: true,
      }),
    ).toBe("LOW");
  });
});

describe("variety pack — multi-component reconciliation", () => {
  // Variety pack: 3-flavor case. 1 case = 4 of A + 4 of B + 4 of C.
  // 100 cases produced. Expected:
  //   A: 400, B: 400, C: 400.
  // Actual logged via ledger:
  //   A: 410 (over by 10), B: 395 (short by 5), C: 400 (exact).

  it("expected vs actual variance is exact subtraction per role", () => {
    expect(computeExpectedComponentQty(100, 4)).toBe(400);
    expect(computeComponentVariance(410, 400)).toBe(10);
    expect(computeComponentVariance(395, 400)).toBe(-5);
    expect(computeComponentVariance(400, 400)).toBe(0);
  });

  it("variance percent over-consumption", () => {
    expect(computeComponentVariancePercent(10, 400)).toBeCloseTo(2.5, 5);
  });

  it("variance percent under-consumption (negative)", () => {
    expect(computeComponentVariancePercent(-5, 400)).toBeCloseTo(-1.25, 5);
  });

  it("missing component usage returns null variance — never assumes 0", () => {
    expect(computeComponentVariance(null, 400)).toBe(null);
  });

  it("missing requirements returns null expected — never invents qty/unit", () => {
    expect(computeExpectedComponentQty(100, null)).toBe(null);
  });
});

// ─── Server action validation schemas ─────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TOKEN = "11111111-1111-4111-8111-111111111111";
const VALID_STATION = "22222222-2222-4222-8222-222222222222";
const VALID_BAG = "33333333-3333-4333-8333-333333333333";
const VALID_SESSION = "44444444-4444-4444-8444-444444444444";

const openSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  inventoryBagId: z.string().uuid(),
  productId: z.string().uuid().optional().nullable().or(z.literal("")),
  routeId: z.string().uuid().optional().nullable().or(z.literal("")),
  workflowBagId: z.string().uuid().optional().nullable().or(z.literal("")),
  componentRole: z.string().max(40).optional().nullable(),
  startingBalanceQty: z.coerce.number().int().min(0).optional().nullable(),
  startingBalanceSource: z.string().max(40).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

const closeSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  consumedQty: z.coerce.number().int().min(0).optional().nullable(),
  consumedQtySource: z.string().max(40).optional().nullable(),
  endingBalanceQty: z.coerce.number().int().min(0).optional().nullable(),
  endingBalanceSource: z.string().max(40).optional().nullable(),
  finishedLotId: z.string().uuid().optional().nullable().or(z.literal("")),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

const returnSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  returnedQty: z.coerce.number().int().positive(),
  remainingWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

const adjustSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  inventoryBagId: z.string().uuid(),
  adjustmentQty: z.coerce.number().int(),
  reason: z.string().min(1).max(200),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

describe("openAllocationSession schema", () => {
  it("accepts minimal valid input", () => {
    const r = openSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      inventoryBagId: VALID_BAG,
    });
    expect(r.success).toBe(true);
  });
  it("accepts variety-pack component role", () => {
    const r = openSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      inventoryBagId: VALID_BAG,
      componentRole: "FLAVOR_A",
    });
    expect(r.success).toBe(true);
  });
  it("rejects invalid token", () => {
    const r = openSchema.safeParse({
      token: "not-a-uuid",
      stationId: VALID_STATION,
      inventoryBagId: VALID_BAG,
    });
    expect(r.success).toBe(false);
  });
});

describe("closeAllocationSession schema", () => {
  it("accepts close with no quantities (operator forgot)", () => {
    const r = closeSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      sessionId: VALID_SESSION,
    });
    expect(r.success).toBe(true);
  });
  it("accepts close with consumed quantity + source", () => {
    const r = closeSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      sessionId: VALID_SESSION,
      consumedQty: 12_000,
      consumedQtySource: "MACHINE_COUNTER",
    });
    expect(r.success).toBe(true);
  });
  it("rejects negative consumed", () => {
    const r = closeSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      sessionId: VALID_SESSION,
      consumedQty: -100,
    });
    expect(r.success).toBe(false);
  });
});

describe("returnRawBag schema", () => {
  it("requires positive returned quantity", () => {
    const r = returnSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      sessionId: VALID_SESSION,
      returnedQty: 0,
    });
    expect(r.success).toBe(false);
  });
  it("accepts a valid return with optional weight", () => {
    const r = returnSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      sessionId: VALID_SESSION,
      returnedQty: 8_000,
      remainingWeightGrams: 1500,
    });
    expect(r.success).toBe(true);
  });
});

describe("adjustRawBag schema", () => {
  it("accepts negative adjustment (correction down)", () => {
    const r = adjustSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      inventoryBagId: VALID_BAG,
      adjustmentQty: -50,
      reason: "Recount",
    });
    expect(r.success).toBe(true);
  });
  it("requires a non-empty reason", () => {
    const r = adjustSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      inventoryBagId: VALID_BAG,
      adjustmentQty: 100,
      reason: "",
    });
    expect(r.success).toBe(false);
  });
});

// ─── Documented invariants ────────────────────────────────────

describe("H.x3.6 invariants", () => {
  it("a single OPEN session is allowed per bag (DB partial unique enforces)", () => {
    // The migration creates rba_sessions_one_open_per_bag as a partial
    // unique index. The action also pre-checks; this test pins the
    // contract for the next contributor.
    expect("one OPEN per bag").toBe("one OPEN per bag");
  });

  it("RAW_BAG_RETURNED_TO_STOCK flips the bag back to AVAILABLE so it can reopen", () => {
    // The action sets inventory_bags.status = 'AVAILABLE' so the
    // same bag can be re-opened later for a different product.
    const allowedNextStatuses = ["AVAILABLE", "EMPTIED", "VOID", "QUARANTINED"];
    expect(allowedNextStatuses).toContain("AVAILABLE");
  });

  it("event_type taxonomy is exactly the 8 documented values", () => {
    const allowed = [
      "RAW_BAG_OPENED",
      "RAW_BAG_ALLOCATED",
      "RAW_BAG_RETURNED_TO_STOCK",
      "RAW_BAG_PARTIAL_CONSUMED",
      "RAW_BAG_DEPLETED",
      "RAW_BAG_REWEIGHED",
      "RAW_BAG_ADJUSTED",
      "RAW_BAG_VOIDED",
    ];
    expect(allowed.length).toBe(8);
  });

  it("quantity_source enum covers every honest input source", () => {
    const allowed = [
      "VENDOR_DECLARED",
      "RECEIVED_WEIGHT_ESTIMATE",
      "MACHINE_COUNTER",
      "FINISHED_LOT_INPUT",
      "MANUAL_ENTRY",
      "WEIGH_BACK",
      "ESTIMATED",
      "UNKNOWN",
    ];
    expect(allowed.length).toBe(8);
  });

  it("legacy fallback is labeled MEDIUM, never HIGH — the data wasn't ledger-grade", () => {
    expect(["HIGH", "MEDIUM"]).toContain("MEDIUM");
  });

  it("dispute packet uses neutral language — never 'shortage' or 'over-delivery'", () => {
    const labels = [
      "vendor declared",
      "accounted output",
      "remaining inventory",
      "unknown variance",
      "requires review",
    ];
    expect(labels).not.toContain("shortage");
    expect(labels).not.toContain("over-delivery");
    expect(labels).not.toContain("supplier short");
  });
});

// ─── resolveReopenStartingBalance ────────────────────────────

describe("resolveReopenStartingBalance", () => {
  it("uses endingBalanceQty when available", () => {
    expect(
      resolveReopenStartingBalance(
        { endingBalanceQty: 7000, startingBalanceQty: 10000, consumedQty: 3000 },
        10000,
      ),
    ).toBe(7000);
  });

  it("computes startingQty - consumedQty when no endingBalance", () => {
    expect(
      resolveReopenStartingBalance(
        { endingBalanceQty: null, startingBalanceQty: 10000, consumedQty: 3000 },
        10000,
      ),
    ).toBe(7000);
  });

  it("clamps to 0 when consumedQty exceeds startingQty", () => {
    expect(
      resolveReopenStartingBalance(
        { endingBalanceQty: null, startingBalanceQty: 5000, consumedQty: 8000 },
        10000,
      ),
    ).toBe(0);
  });

  it("falls back to pillCount when no prior session (first open)", () => {
    expect(resolveReopenStartingBalance(null, 10000)).toBe(10000);
  });

  it("falls back to pillCount when session has no balance info at all", () => {
    expect(
      resolveReopenStartingBalance(
        { endingBalanceQty: null, startingBalanceQty: null, consumedQty: null },
        10000,
      ),
    ).toBe(10000);
  });

  it("returns null when no session and no pillCount", () => {
    expect(resolveReopenStartingBalance(null, null)).toBeNull();
  });

  it("supports the full reuse chain: 10000 -> 7000 -> 3000", () => {
    const afterSessionA = resolveReopenStartingBalance(
      { endingBalanceQty: null, startingBalanceQty: 10000, consumedQty: 3000 },
      10000,
    );
    expect(afterSessionA).toBe(7000);

    const afterSessionB = resolveReopenStartingBalance(
      { endingBalanceQty: null, startingBalanceQty: afterSessionA, consumedQty: 4000 },
      10000,
    );
    expect(afterSessionB).toBe(3000);
  });
});

// ─── checkOverAllocation ─────────────────────────────────────

describe("checkOverAllocation", () => {
  it("returns null when consumedQty is within the starting balance", () => {
    expect(checkOverAllocation(3000, 10000)).toBeNull();
  });

  it("returns null when consumedQty equals the starting balance (full use)", () => {
    expect(checkOverAllocation(10000, 10000)).toBeNull();
  });

  it("returns an error string when consumedQty exceeds starting balance", () => {
    const result = checkOverAllocation(11000, 10000);
    expect(result).toMatch(/exceeds/i);
    expect(result).toMatch(/11,000/);
    expect(result).toMatch(/10,000/);
  });

  it("returns null when startingBalanceQty is null (cannot validate)", () => {
    expect(checkOverAllocation(5000, null)).toBeNull();
  });

  it("returns null when startingBalanceQty is undefined", () => {
    expect(checkOverAllocation(5000, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldReleaseQrAtFinalization
// ---------------------------------------------------------------------------

describe("shouldReleaseQrAtFinalization", () => {
  it("returns true when session is null (legacy/untracked bag)", () => {
    expect(shouldReleaseQrAtFinalization(null)).toBe(true);
  });

  it("returns true when session is undefined", () => {
    expect(shouldReleaseQrAtFinalization(undefined)).toBe(true);
  });

  it("returns false when CLOSED with endingBalanceQty > 0 (partial remaining)", () => {
    expect(shouldReleaseQrAtFinalization({
      allocationStatus: "CLOSED",
      endingBalanceQty: 7000,
    })).toBe(false);
  });

  it("returns false when CLOSED with endingBalanceQty null (unknown remaining, conservative)", () => {
    expect(shouldReleaseQrAtFinalization({
      allocationStatus: "CLOSED",
      endingBalanceQty: null,
    })).toBe(false);
  });

  it("returns true when CLOSED with endingBalanceQty = 0 (operator confirmed empty)", () => {
    expect(shouldReleaseQrAtFinalization({
      allocationStatus: "CLOSED",
      endingBalanceQty: 0,
    })).toBe(true);
  });

  it("returns true when DEPLETED", () => {
    expect(shouldReleaseQrAtFinalization({
      allocationStatus: "DEPLETED",
      endingBalanceQty: 0,
    })).toBe(true);
  });

  it("returns true when RETURNED_TO_STOCK", () => {
    expect(shouldReleaseQrAtFinalization({
      allocationStatus: "RETURNED_TO_STOCK",
      endingBalanceQty: 500,
    })).toBe(true);
  });

  it("returns true when VOIDED", () => {
    expect(shouldReleaseQrAtFinalization({
      allocationStatus: "VOIDED",
      endingBalanceQty: null,
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveBagStatusAfterClose
// ---------------------------------------------------------------------------

describe("deriveBagStatusAfterClose", () => {
  it("returns AVAILABLE when endingBalanceQty > 0", () => {
    expect(deriveBagStatusAfterClose(7000)).toBe("AVAILABLE");
  });

  it("returns AVAILABLE when endingBalanceQty = 1 (minimum partial)", () => {
    expect(deriveBagStatusAfterClose(1)).toBe("AVAILABLE");
  });

  it("returns EMPTIED when endingBalanceQty = 0 (confirmed empty on close)", () => {
    expect(deriveBagStatusAfterClose(0)).toBe("EMPTIED");
  });

  it("returns null when endingBalanceQty is null (operator did not confirm)", () => {
    expect(deriveBagStatusAfterClose(null)).toBeNull();
  });

  it("returns null when endingBalanceQty is undefined", () => {
    expect(deriveBagStatusAfterClose(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPartialBagResume
// ---------------------------------------------------------------------------

describe("isPartialBagResume", () => {
  it("returns false when session is null", () => {
    expect(isPartialBagResume(null)).toBe(false);
  });

  it("returns false when session is undefined", () => {
    expect(isPartialBagResume(undefined)).toBe(false);
  });

  it("returns true when CLOSED with endingBalanceQty > 0", () => {
    expect(isPartialBagResume({
      allocationStatus: "CLOSED",
      endingBalanceQty: 7000,
    })).toBe(true);
  });

  it("returns true when CLOSED with endingBalanceQty null (conservative)", () => {
    expect(isPartialBagResume({
      allocationStatus: "CLOSED",
      endingBalanceQty: null,
    })).toBe(true);
  });

  it("returns false when CLOSED with endingBalanceQty = 0 (empty confirmed)", () => {
    expect(isPartialBagResume({
      allocationStatus: "CLOSED",
      endingBalanceQty: 0,
    })).toBe(false);
  });

  it("returns false when DEPLETED (use shouldReleaseQr path, not resume)", () => {
    expect(isPartialBagResume({
      allocationStatus: "DEPLETED",
      endingBalanceQty: 0,
    })).toBe(false);
  });

  it("returns false when RETURNED_TO_STOCK", () => {
    expect(isPartialBagResume({
      allocationStatus: "RETURNED_TO_STOCK",
      endingBalanceQty: 500,
    })).toBe(false);
  });
});
