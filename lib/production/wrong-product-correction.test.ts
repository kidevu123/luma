// ADMIN-CORRECTION-WIZARD-1 — pure evaluator + preview builder for
// wrong-product corrections. Fail closed: every ambiguous state blocks.

import { describe, expect, it } from "vitest";
import {
  WRONG_PRODUCT_CORRECTION_SOURCE,
  computeExpectedConsumption,
  computeUnitsUnderProduct,
  evaluateWrongProductCorrection,
  buildWrongProductCorrectionPreview,
  type CorrectionProductFacts,
  type WrongProductCorrectionCounts,
} from "./wrong-product-correction";

function product(
  overrides: Partial<CorrectionProductFacts> = {},
): CorrectionProductFacts {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sku: "SKU-A",
    name: "Product A",
    kind: "CARD",
    tabletsPerUnit: 4,
    unitsPerDisplay: 20,
    displaysPerCase: 25,
    defaultShelfLifeDays: 365,
    isActive: true,
    allowsBagTabletType: true,
    ...overrides,
  };
}

const NEW_ID = "22222222-2222-4222-8222-222222222222";

function newProduct(
  overrides: Partial<CorrectionProductFacts> = {},
): CorrectionProductFacts {
  return product({
    id: NEW_ID,
    sku: "SKU-B",
    name: "Product B",
    unitsPerDisplay: 10,
    displaysPerCase: 12,
    ...overrides,
  });
}

const COUNTS_352182: WrongProductCorrectionCounts = {
  masterCases: 10,
  displaysMade: 44,
  looseCards: 0,
  bottlesCompleted: 0,
};

function baseArgs() {
  return {
    oldProduct: product(),
    newProduct: newProduct(),
    isFinalized: true,
    alreadyQuarantined: false,
    zohoOutputCommitted: false,
    lotStatus: null as string | null,
    allocationSessions: [
      { status: "DEPLETED", startingBalanceQty: 7223 },
    ],
    counts: COUNTS_352182,
  };
}

describe("computeUnitsUnderProduct", () => {
  it("computes cases*(upd*dpc) + displays*upd + loose (same formula as bag metrics)", () => {
    expect(computeUnitsUnderProduct(COUNTS_352182, product())).toBe(5880);
    expect(computeUnitsUnderProduct(COUNTS_352182, newProduct())).toBe(1640);
  });

  it("adds loose cards and bottles", () => {
    expect(
      computeUnitsUnderProduct(
        { masterCases: 0, displaysMade: 0, looseCards: 7, bottlesCompleted: 3 },
        product(),
      ),
    ).toBe(10);
  });

  it("returns null when case/display counts exist but packaging structure is missing", () => {
    expect(
      computeUnitsUnderProduct(COUNTS_352182, product({ unitsPerDisplay: null })),
    ).toBeNull();
    expect(
      computeUnitsUnderProduct(COUNTS_352182, product({ displaysPerCase: null })),
    ).toBeNull();
  });

  it("allows loose-only counts without packaging structure", () => {
    expect(
      computeUnitsUnderProduct(
        { masterCases: 0, displaysMade: 0, looseCards: 5, bottlesCompleted: 0 },
        product({ unitsPerDisplay: null, displaysPerCase: null }),
      ),
    ).toBe(5);
  });
});

describe("computeExpectedConsumption", () => {
  it("multiplies units by tablets per unit", () => {
    expect(computeExpectedConsumption(1640, 4)).toBe(6560);
  });
  it("returns null when either input is unknown", () => {
    expect(computeExpectedConsumption(null, 4)).toBeNull();
    expect(computeExpectedConsumption(1640, null)).toBeNull();
  });
});

describe("evaluateWrongProductCorrection — safe path", () => {
  it("allows a compatible same-route correction (receipt 352182 shape)", () => {
    const verdict = evaluateWrongProductCorrection(baseArgs());
    expect(verdict.blockers).toEqual([]);
    expect(verdict.allowed).toBe(true);
  });

  it("allows correction on a non-finalized workflow with no counts yet", () => {
    const verdict = evaluateWrongProductCorrection({
      ...baseArgs(),
      isFinalized: false,
      counts: null,
      allocationSessions: [{ status: "CLOSED", startingBalanceQty: 7223 }],
      lotStatus: null,
    });
    expect(verdict.blockers).toEqual([]);
    expect(verdict.allowed).toBe(true);
  });

  it("warns when the lot will be held and the Zoho op voided", () => {
    const verdict = evaluateWrongProductCorrection({
      ...baseArgs(),
      lotStatus: "RELEASED",
    });
    expect(verdict.allowed).toBe(true);
    const codes = verdict.warnings.map((w) => w.code);
    expect(codes).toContain("LOT_WILL_HOLD");
    expect(codes).toContain("ZOHO_OP_WILL_VOID");
  });

  it("warns when the corrected product has no shelf life configured", () => {
    const verdict = evaluateWrongProductCorrection({
      ...baseArgs(),
      newProduct: newProduct({ defaultShelfLifeDays: null }),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warnings.map((w) => w.code)).toContain("MISSING_SHELF_LIFE");
  });
});

describe("evaluateWrongProductCorrection — blockers", () => {
  function expectBlocked(args: ReturnType<typeof baseArgs>, code: string) {
    const verdict = evaluateWrongProductCorrection(args);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockers.map((b) => b.code)).toContain(code);
    for (const b of verdict.blockers) {
      expect(b.message.length).toBeGreaterThan(0);
      expect(b.recommendation.length).toBeGreaterThan(0);
    }
  }

  it("blocks when new product is missing", () => {
    expectBlocked({ ...baseArgs(), newProduct: null }, "PRODUCT_NOT_FOUND");
  });

  it("blocks correcting to the same product", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ id: product().id }) },
      "SAME_PRODUCT",
    );
  });

  it("blocks an inactive product", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ isActive: false }) },
      "PRODUCT_INACTIVE",
    );
  });

  it("blocks a route-incompatible product (CARD -> BOTTLE)", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ kind: "BOTTLE" }) },
      "ROUTE_INCOMPATIBLE",
    );
  });

  it("blocks VARIETY on either side", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ kind: "VARIETY" }) },
      "ROUTE_INCOMPATIBLE",
    );
    expectBlocked(
      {
        ...baseArgs(),
        oldProduct: product({ kind: "VARIETY" }),
        newProduct: newProduct({ kind: "VARIETY" }),
      },
      "ROUTE_INCOMPATIBLE",
    );
  });

  it("blocks when the new product does not allow the bag's tablet type", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ allowsBagTabletType: false }) },
      "TABLET_NOT_ALLOWED",
    );
  });

  it("blocks incomplete product setup (missing tablets per unit)", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ tabletsPerUnit: null }) },
      "PRODUCT_SETUP_INCOMPLETE",
    );
  });

  it("blocks incomplete packaging structure when case/display counts exist", () => {
    expectBlocked(
      { ...baseArgs(), newProduct: newProduct({ unitsPerDisplay: null }) },
      "PRODUCT_SETUP_INCOMPLETE",
    );
  });

  it("blocks a workflow that is already quarantined/recovered", () => {
    expectBlocked({ ...baseArgs(), alreadyQuarantined: true }, "ALREADY_QUARANTINED");
  });

  it("blocks when Zoho output is committed", () => {
    expectBlocked({ ...baseArgs(), zohoOutputCommitted: true }, "ZOHO_COMMITTED");
  });

  it("blocks shipped or recalled lots", () => {
    expectBlocked({ ...baseArgs(), lotStatus: "SHIPPED" }, "LOT_SHIPPED_OR_RECALLED");
    expectBlocked({ ...baseArgs(), lotStatus: "RECALLED" }, "LOT_SHIPPED_OR_RECALLED");
  });

  it("blocks when an allocation session is still OPEN", () => {
    expectBlocked(
      {
        ...baseArgs(),
        allocationSessions: [{ status: "OPEN", startingBalanceQty: 7223 }],
      },
      "ALLOCATION_OPEN",
    );
  });

  it("blocks ambiguous multi-session allocation state", () => {
    expectBlocked(
      {
        ...baseArgs(),
        allocationSessions: [
          { status: "CLOSED", startingBalanceQty: 7223 },
          { status: "DEPLETED", startingBalanceQty: 1000 },
        ],
      },
      "ALLOCATION_AMBIGUOUS",
    );
  });

  it("blocks when the corrected consumption would exceed the known starting balance", () => {
    expectBlocked(
      {
        ...baseArgs(),
        // New product consumes 1640 * 4 = 6560; starting balance only 6000.
        allocationSessions: [{ status: "DEPLETED", startingBalanceQty: 6000 }],
      },
      "NEGATIVE_REMAINING",
    );
  });
});

describe("buildWrongProductCorrectionPreview", () => {
  it("builds the full receipt-352182 preview", () => {
    const preview = buildWrongProductCorrectionPreview({
      ...baseArgs(),
      lotStatus: "RELEASED",
      hasUncommittedZohoOp: true,
    });
    expect(preview.oldRoute).toBe("CARD");
    expect(preview.newRoute).toBe("CARD");
    expect(preview.oldUnits).toBe(5880);
    expect(preview.newUnits).toBe(1640);
    expect(preview.oldExpectedConsumption).toBe(23520);
    expect(preview.newExpectedConsumption).toBe(6560);
    expect(preview.allocationImpact).toEqual({
      sessionStatus: "DEPLETED",
      startingBalanceQty: 7223,
      oldConsumed: 23520,
      newConsumed: 6560,
      oldEnding: 7223 - 23520,
      newEnding: 663,
    });
    expect(preview.finishedLotImpact).toBe("UPDATE_AND_HOLD");
    expect(preview.zohoImpact).toBe("VOID_UNCOMMITTED_REBUILD");
    expect(preview.poCloseoutImpact.length).toBeGreaterThan(0);
  });

  it("reports NONE impacts when no lot or op exists", () => {
    const preview = buildWrongProductCorrectionPreview({
      ...baseArgs(),
      hasUncommittedZohoOp: false,
    });
    expect(preview.finishedLotImpact).toBe("NONE");
    expect(preview.zohoImpact).toBe("NONE");
  });

  it("reports blocked impacts for committed Zoho output", () => {
    const preview = buildWrongProductCorrectionPreview({
      ...baseArgs(),
      lotStatus: "RELEASED",
      zohoOutputCommitted: true,
      hasUncommittedZohoOp: false,
    });
    expect(preview.finishedLotImpact).toBe("BLOCKED_COMMITTED");
    expect(preview.zohoImpact).toBe("BLOCKED_COMMITTED");
  });
});

describe("correction source constant", () => {
  it("is the audited admin source string", () => {
    expect(WRONG_PRODUCT_CORRECTION_SOURCE).toBe("ADMIN_WRONG_PRODUCT_CORRECTION");
  });
});
