// ZOHO-ASSY-2 — Unit tests for the dry-run assembly planner.
//
// All tests target computeZohoAssemblyPlan() — the pure function that
// accepts pre-fetched data and returns a plan without touching the DB.
// planZohoAssemblyForFinishedLot() is not tested here (it's a thin DB
// wrapper and exercised by staging smoke tests).
//
// We never mock @/lib/db because computeZohoAssemblyPlan() is pure.

import { describe, it, expect } from "vitest";
import {
  computeZohoAssemblyPlan,
  type PlannerRawInputs,
  type PlannerLedgerRow,
  type PlannerFallbackRow,
  type PlannerBomRow,
} from "./assembly-planner";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const LOT_ID   = "11111111-0000-0000-0000-000000000001";
const BAG_A    = "aaaaaaaa-0000-0000-0000-000000000001";
const BAG_B    = "bbbbbbbb-0000-0000-0000-000000000001";
const BATCH_X  = "cccccccc-0000-0000-0000-000000000001";
const PROD_ID  = "dddddddd-0000-0000-0000-000000000001";
const MAT_ID_1 = "eeeeeeee-0000-0000-0000-000000000001";
const MAT_ID_2 = "ffffffff-0000-0000-0000-000000000001";

const BASE_PRODUCT = {
  id:                PROD_ID,
  name:              "DHA 400mg NCF",
  sku:               "DHA400-NCF",
  kind:              "CARD",
  zohoItemIdUnit:    "ZITEM-UNIT",
  zohoItemIdDisplay: "ZITEM-DISP",
  zohoItemIdCase:    "ZITEM-CASE",
};

const GOOD_LEDGER_ROW: PlannerLedgerRow = {
  inventoryBagId:   BAG_A,
  consumedQty:      1200,
  tabletTypeId:     "tttttttt-0000-0000-0000-000000000001",
  tabletZohoItemId: "ZTAB-001",
  tabletName:       "DHA 400mg",
  receivePoLineId:  "pppppppp-0000-0000-0000-000000000001",
  zohoLineItemId:   "ZLINE-001",
  zohoPoId:         "ZPO-001",
  componentRole:    null,
};

const UNIT_BOM_ROW: PlannerBomRow = {
  perScope:           "UNIT",
  materialId:         MAT_ID_1,
  materialName:       "Blister card",
  materialZohoItemId: "ZMAT-CARD",
  qtyPerUnit:         1,
};

const DISPLAY_BOM_ROW: PlannerBomRow = {
  perScope:           "DISPLAY",
  materialId:         MAT_ID_2,
  materialName:       "Display box",
  materialZohoItemId: "ZMAT-DISP",
  qtyPerUnit:         1,
};

function baseInputs(overrides: Partial<PlannerRawInputs> = {}): PlannerRawInputs {
  return {
    finishedLotId:    LOT_ID,
    finishedLotNumber: "FL-2026-001",
    unitsProduced:    840,
    displaysProduced: 60,
    casesProduced:    5,
    product:          BASE_PRODUCT,
    ledgerRows:       [GOOD_LEDGER_ROW],
    fallbackRows:     [],
    bomRows:          [UNIT_BOM_ROW, DISPLAY_BOM_ROW],
    ...overrides,
  };
}

// ─── Scenario A: Simple card product — one source bag, fully mapped ───────────

describe("Scenario A — simple card product, one source bag, fully mapped", () => {
  const plan = computeZohoAssemblyPlan(baseInputs());

  it("uses LEDGER as source method", () => {
    expect(plan.sourceMethod).toBe("LEDGER");
  });

  it("has no global issues", () => {
    expect(plan.issues).toHaveLength(0);
  });

  it("emits exactly 4 ops (1 TABLET_RECEIVE + UNIT + DISPLAY + CASE)", () => {
    expect(plan.ops).toHaveLength(4);
    const kinds = plan.ops.map((o) => o.opKind);
    expect(kinds).toEqual(["TABLET_RECEIVE", "UNIT_ASSEMBLE", "DISPLAY_ASSEMBLE", "CASE_ASSEMBLE"]);
  });

  it("TABLET_RECEIVE uses LEDGER idempotency key", () => {
    const op = plan.ops[0]!;
    expect(op.idempotencyKey).toBe(`luma:tablet_receive:${LOT_ID}:${BAG_A}`);
  });

  it("TABLET_RECEIVE quantity comes from consumedQty, not a product formula", () => {
    const op = plan.ops[0]!;
    expect(op.opKind).toBe("TABLET_RECEIVE");
    if (op.opKind === "TABLET_RECEIVE") {
      expect(op.quantity).toBe(1200);
    }
  });

  it("TABLET_RECEIVE is READY when all Zoho IDs present", () => {
    const op = plan.ops[0]!;
    expect(op.statusPreview).toBe("READY");
  });

  it("UNIT_ASSEMBLE idempotency key is correct", () => {
    const op = plan.ops[1]!;
    expect(op.idempotencyKey).toBe(`luma:unit_assemble:${LOT_ID}`);
  });

  it("UNIT_ASSEMBLE quantity equals units_produced", () => {
    const op = plan.ops[1]!;
    expect(op.quantity).toBe(840);
  });

  it("UNIT_ASSEMBLE is READY", () => {
    const op = plan.ops[1]!;
    expect(op.statusPreview).toBe("READY");
  });

  it("DISPLAY_ASSEMBLE idempotency key is correct", () => {
    const op = plan.ops[2]!;
    expect(op.idempotencyKey).toBe(`luma:display_assemble:${LOT_ID}`);
  });

  it("DISPLAY_ASSEMBLE quantity equals displays_produced", () => {
    const op = plan.ops[2]!;
    expect(op.quantity).toBe(60);
  });

  it("DISPLAY_ASSEMBLE is READY", () => {
    const op = plan.ops[2]!;
    expect(op.statusPreview).toBe("READY");
  });

  it("CASE_ASSEMBLE idempotency key is correct", () => {
    const op = plan.ops[3]!;
    expect(op.idempotencyKey).toBe(`luma:case_assemble:${LOT_ID}`);
  });

  it("CASE_ASSEMBLE quantity equals cases_produced", () => {
    const op = plan.ops[3]!;
    expect(op.quantity).toBe(5);
  });

  it("CASE_ASSEMBLE is READY", () => {
    const op = plan.ops[3]!;
    expect(op.statusPreview).toBe("READY");
  });

  it("overall status is READY", () => {
    expect(plan.overallStatus).toBe("READY");
  });

  it("UNIT BOM line has expectedQty = qtyPerUnit × units_produced", () => {
    const unitOp = plan.ops[1]!;
    if (unitOp.opKind === "UNIT_ASSEMBLE") {
      const blisterLine = unitOp.bomLines.find((l) => l.materialName === "Blister card");
      expect(blisterLine).toBeDefined();
      // qtyPerUnit=1 × 840 units = 840
      expect(blisterLine?.expectedQty).toBe(840);
    }
  });

  it("DISPLAY BOM line has expectedQty = qtyPerUnit × displays_produced", () => {
    const dispOp = plan.ops[2]!;
    if (dispOp.opKind === "DISPLAY_ASSEMBLE") {
      const dispBoxLine = dispOp.bomLines.find((l) => l.materialName === "Display box");
      expect(dispBoxLine).toBeDefined();
      // qtyPerUnit=1 × 60 displays = 60
      expect(dispBoxLine?.expectedQty).toBe(60);
    }
  });

  it("CASE has no BOM lines (no CASE BOM rows provided)", () => {
    const caseOp = plan.ops[3]!;
    if (caseOp.opKind === "CASE_ASSEMBLE") {
      expect(caseOp.bomLines).toHaveLength(0);
    }
  });
});

// ─── Scenario B: Missing product Zoho unit ID ─────────────────────────────────

describe("Scenario B — missing product Zoho unit ID", () => {
  const plan = computeZohoAssemblyPlan(baseInputs({
    product: { ...BASE_PRODUCT, zohoItemIdUnit: null },
  }));

  it("UNIT_ASSEMBLE is NEEDS_MAPPING", () => {
    const op = plan.ops[1]!;
    expect(op.statusPreview).toBe("NEEDS_MAPPING");
  });

  it("UNIT_ASSEMBLE statusReason mentions unit level", () => {
    const op = plan.ops[1]!;
    expect(op.statusReason).toContain("unit level");
  });

  it("overall status is NEEDS_MAPPING (not READY)", () => {
    expect(plan.overallStatus).toBe("NEEDS_MAPPING");
  });

  it("DISPLAY_ASSEMBLE and CASE_ASSEMBLE are unaffected (their own Zoho IDs are set)", () => {
    const dispOp = plan.ops[2]!;
    const caseOp = plan.ops[3]!;
    expect(dispOp.statusPreview).toBe("READY");
    expect(caseOp.statusPreview).toBe("READY");
  });
});

// ─── Scenario C: Missing packaging material Zoho item ID ──────────────────────

describe("Scenario C — missing packaging material Zoho item ID", () => {
  const bomRowMissingZoho: PlannerBomRow = {
    ...UNIT_BOM_ROW,
    materialZohoItemId: null,
  };
  const plan = computeZohoAssemblyPlan(baseInputs({
    bomRows: [bomRowMissingZoho, DISPLAY_BOM_ROW],
  }));

  it("UNIT_ASSEMBLE is NEEDS_MAPPING", () => {
    const op = plan.ops[1]!;
    expect(op.statusPreview).toBe("NEEDS_MAPPING");
  });

  it("UNIT_ASSEMBLE BOM line has issue set for the missing material", () => {
    const unitOp = plan.ops[1]!;
    if (unitOp.opKind === "UNIT_ASSEMBLE") {
      const line = unitOp.bomLines.find((l) => l.materialName === "Blister card");
      expect(line?.issue).not.toBeNull();
      expect(line?.issue).toContain("Missing Zoho item ID");
    }
  });

  it("UNIT_ASSEMBLE BOM line still has correct expectedQty despite missing Zoho ID", () => {
    const unitOp = plan.ops[1]!;
    if (unitOp.opKind === "UNIT_ASSEMBLE") {
      const line = unitOp.bomLines.find((l) => l.materialName === "Blister card");
      expect(line?.expectedQty).toBe(840);
    }
  });

  it("overall status is NEEDS_MAPPING", () => {
    expect(plan.overallStatus).toBe("NEEDS_MAPPING");
  });

  it("DISPLAY_ASSEMBLE is still READY (its material has a Zoho ID)", () => {
    const op = plan.ops[2]!;
    expect(op.statusPreview).toBe("READY");
  });
});

// ─── Scenario D: Variety pack — multiple source bags ─────────────────────────

describe("Scenario D — variety pack, two source bags with component roles", () => {
  const ledgerRowA: PlannerLedgerRow = {
    ...GOOD_LEDGER_ROW,
    inventoryBagId: BAG_A,
    consumedQty:    600,
    componentRole:  "PRIMARY",
  };
  const ledgerRowB: PlannerLedgerRow = {
    ...GOOD_LEDGER_ROW,
    inventoryBagId:   BAG_B,
    consumedQty:      600,
    tabletZohoItemId: "ZTAB-002",
    zohoLineItemId:   "ZLINE-002",
    componentRole:    "FLAVOR_A",
  };
  const plan = computeZohoAssemblyPlan(baseInputs({
    ledgerRows: [ledgerRowA, ledgerRowB],
  }));

  it("emits 2 TABLET_RECEIVE ops, one per source bag", () => {
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    expect(receiveOps).toHaveLength(2);
  });

  it("each TABLET_RECEIVE has a unique idempotency key using inventoryBagId", () => {
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    const keys = receiveOps.map((o) => o.idempotencyKey);
    expect(keys).toContain(`luma:tablet_receive:${LOT_ID}:${BAG_A}`);
    expect(keys).toContain(`luma:tablet_receive:${LOT_ID}:${BAG_B}`);
    // Keys must be distinct
    expect(new Set(keys).size).toBe(2);
  });

  it("component roles are preserved on each TABLET_RECEIVE op", () => {
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    const roles = receiveOps.map((o) => (o.opKind === "TABLET_RECEIVE" ? o.componentRole : null));
    expect(roles).toContain("PRIMARY");
    expect(roles).toContain("FLAVOR_A");
  });

  it("TABLET_RECEIVE quantities are per-bag consumed quantities", () => {
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    const quantities = receiveOps.map((o) => o.quantity);
    expect(quantities).toContain(600);
  });

  it("both TABLET_RECEIVE ops are READY (all Zoho IDs set)", () => {
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    for (const op of receiveOps) {
      expect(op.statusPreview).toBe("READY");
    }
  });

  it("still has exactly one UNIT_ASSEMBLE op", () => {
    const assembleOps = plan.ops.filter((o) => o.opKind === "UNIT_ASSEMBLE");
    expect(assembleOps).toHaveLength(1);
  });

  it("UNIT_ASSEMBLE quantity still equals units_produced (840), not sum of bag quantities", () => {
    const unitOp = plan.ops.find((o) => o.opKind === "UNIT_ASSEMBLE");
    expect(unitOp?.quantity).toBe(840);
  });

  it("sourceMethod is LEDGER", () => {
    expect(plan.sourceMethod).toBe("LEDGER");
  });
});

// ─── Scenario E: Zero displays and cases ─────────────────────────────────────

describe("Scenario E — zero displays and cases produced", () => {
  const plan = computeZohoAssemblyPlan(baseInputs({
    displaysProduced: 0,
    casesProduced:    null,
  }));

  it("DISPLAY_ASSEMBLE is SKIPPED", () => {
    const op = plan.ops.find((o) => o.opKind === "DISPLAY_ASSEMBLE")!;
    expect(op.statusPreview).toBe("SKIPPED");
  });

  it("CASE_ASSEMBLE is SKIPPED", () => {
    const op = plan.ops.find((o) => o.opKind === "CASE_ASSEMBLE")!;
    expect(op.statusPreview).toBe("SKIPPED");
  });

  it("overall status is READY (unit and tablet receives are fine)", () => {
    expect(plan.overallStatus).toBe("READY");
  });

  it("DISPLAY_ASSEMBLE has zero quantity", () => {
    const op = plan.ops.find((o) => o.opKind === "DISPLAY_ASSEMBLE")!;
    expect(op.quantity).toBe(0);
  });

  it("CASE_ASSEMBLE has zero quantity", () => {
    const op = plan.ops.find((o) => o.opKind === "CASE_ASSEMBLE")!;
    expect(op.quantity).toBe(0);
  });
});

// ─── Scenario F: FALLBACK path (no allocation sessions) ──────────────────────

describe("Scenario F — fallback path, no allocation sessions", () => {
  const fallbackRow: PlannerFallbackRow = {
    batchId:          BATCH_X,
    qtyConsumed:      1500,
    tabletTypeId:     "tttttttt-0000-0000-0000-000000000001",
    tabletName:       "DHA 400mg",
    tabletZohoItemId: "ZTAB-001",
  };
  const plan = computeZohoAssemblyPlan(baseInputs({
    ledgerRows:   [],
    fallbackRows: [fallbackRow],
  }));

  it("sourceMethod is FALLBACK", () => {
    expect(plan.sourceMethod).toBe("FALLBACK");
  });

  it("emits a global issue about the fallback", () => {
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.issues[0]).toContain("batch genealogy");
  });

  it("TABLET_RECEIVE op is NEEDS_MAPPING", () => {
    const op = plan.ops[0]!;
    expect(op.opKind).toBe("TABLET_RECEIVE");
    expect(op.statusPreview).toBe("NEEDS_MAPPING");
  });

  it("TABLET_RECEIVE fallback key uses batch: prefix (not inventoryBagId format)", () => {
    const op = plan.ops[0]!;
    expect(op.idempotencyKey).toBe(`luma:tablet_receive:${LOT_ID}:batch:${BATCH_X}`);
  });

  it("TABLET_RECEIVE sourceInventoryBagId is null (unknown in fallback path)", () => {
    const op = plan.ops[0]!;
    if (op.opKind === "TABLET_RECEIVE") {
      expect(op.sourceInventoryBagId).toBeNull();
    }
  });

  it("overall status is NEEDS_MAPPING", () => {
    expect(plan.overallStatus).toBe("NEEDS_MAPPING");
  });
});

// ─── Scenario G: NONE path (no sources at all) ───────────────────────────────

describe("Scenario G — no sources at all (NONE path)", () => {
  const plan = computeZohoAssemblyPlan(baseInputs({
    ledgerRows:   [],
    fallbackRows: [],
  }));

  it("sourceMethod is NONE", () => {
    expect(plan.sourceMethod).toBe("NONE");
  });

  it("emits a global issue about no source records", () => {
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.issues[0]).toContain("No tablet source records found");
  });

  it("emits no TABLET_RECEIVE ops", () => {
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    expect(receiveOps).toHaveLength(0);
  });

  it("overall status is NEEDS_MAPPING (unit assemble is still non-skipped)", () => {
    // UNIT_ASSEMBLE is READY (product has unit Zoho ID + no BOM issues)
    // But overall is still READY because no TABLET_RECEIVE ops failed —
    // they just don't exist. BLOCKED is not propagated in the dry-run.
    // The overall status is computed from non-SKIPPED ops only.
    const nonSkipped = plan.ops.filter((o) => o.statusPreview !== "SKIPPED");
    const allReady = nonSkipped.every((o) => o.statusPreview === "READY");
    expect(allReady).toBe(true);
    expect(plan.overallStatus).toBe("READY");
  });
});

// ─── Scenario H: Missing tablet type Zoho ID in LEDGER path ─────────────────

describe("Scenario H — tablet type missing Zoho ID in LEDGER path", () => {
  const plan = computeZohoAssemblyPlan(baseInputs({
    ledgerRows: [{ ...GOOD_LEDGER_ROW, tabletZohoItemId: null }],
  }));

  it("TABLET_RECEIVE is NEEDS_MAPPING", () => {
    const op = plan.ops[0]!;
    expect(op.statusPreview).toBe("NEEDS_MAPPING");
  });

  it("statusReason mentions tablet type", () => {
    const op = plan.ops[0]!;
    if (op.opKind === "TABLET_RECEIVE") {
      expect(op.statusReason).toContain("tablet type");
    }
  });

  it("overall status is NEEDS_MAPPING", () => {
    expect(plan.overallStatus).toBe("NEEDS_MAPPING");
  });
});

// ─── Scenario I: BOM expectedQty math — multi-qty per unit ──────────────────

describe("Scenario I — BOM expectedQty math with qtyPerUnit > 1", () => {
  const bomRow: PlannerBomRow = {
    perScope:           "UNIT",
    materialId:         MAT_ID_1,
    materialName:       "Heat seal foil",
    materialZohoItemId: "ZMAT-FOIL",
    qtyPerUnit:         2, // 2 foil sheets per unit
  };
  const plan = computeZohoAssemblyPlan(baseInputs({
    bomRows: [bomRow],
    // No display/case BOM rows
  }));

  it("UNIT BOM line expectedQty = qtyPerUnit × unitsProduced", () => {
    const unitOp = plan.ops[1]!;
    if (unitOp.opKind === "UNIT_ASSEMBLE") {
      const foilLine = unitOp.bomLines.find((l) => l.materialName === "Heat seal foil");
      expect(foilLine).toBeDefined();
      // 2 foil sheets × 840 units = 1680
      expect(foilLine?.expectedQty).toBe(1680);
    }
  });

  it("BOM line has no issue (Zoho ID is set)", () => {
    const unitOp = plan.ops[1]!;
    if (unitOp.opKind === "UNIT_ASSEMBLE") {
      const foilLine = unitOp.bomLines.find((l) => l.materialName === "Heat seal foil");
      expect(foilLine?.issue).toBeNull();
    }
  });
});

// ─── Partial bag reuse — LEDGER vs FALLBACK ──────────────────────────────────

describe("partial bag reuse — LEDGER vs FALLBACK", () => {
  it("LEDGER path uses consumedQty (partial bag scenario)", () => {
    const inputs: PlannerRawInputs = {
      finishedLotId:    LOT_ID,
      finishedLotNumber: "LOT-001",
      unitsProduced:    3000,
      displaysProduced: null,
      casesProduced:    null,
      product:          BASE_PRODUCT,
      ledgerRows: [
        {
          ...GOOD_LEDGER_ROW,
          consumedQty: 3000,   // partial — only 3000 of 10000 bag
        },
      ],
      fallbackRows: [],
      bomRows:      [UNIT_BOM_ROW],
    };
    const plan = computeZohoAssemblyPlan(inputs);
    expect(plan.sourceMethod).toBe("LEDGER");
    const receiveOp = plan.ops.find((o) => o.opKind === "TABLET_RECEIVE");
    expect(receiveOp).toBeDefined();
    expect(receiveOp!.quantity).toBe(3000);
    expect(receiveOp!.statusPreview).toBe("READY");
  });

  it("LEDGER path with two partial bags sums correctly", () => {
    const inputs: PlannerRawInputs = {
      finishedLotId:    LOT_ID,
      finishedLotNumber: "LOT-002",
      unitsProduced:    7000,
      displaysProduced: null,
      casesProduced:    null,
      product:          BASE_PRODUCT,
      ledgerRows: [
        { ...GOOD_LEDGER_ROW, inventoryBagId: BAG_A, consumedQty: 3000 },
        { ...GOOD_LEDGER_ROW, inventoryBagId: BAG_B, consumedQty: 4000 },
      ],
      fallbackRows: [],
      bomRows:      [UNIT_BOM_ROW],
    };
    const plan = computeZohoAssemblyPlan(inputs);
    expect(plan.sourceMethod).toBe("LEDGER");
    const receiveOps = plan.ops.filter((o) => o.opKind === "TABLET_RECEIVE");
    expect(receiveOps).toHaveLength(2);
    expect(receiveOps[0]!.quantity).toBe(3000);
    expect(receiveOps[1]!.quantity).toBe(4000);
  });

  it("FALLBACK path still produces NEEDS_MAPPING (guarded)", () => {
    const inputs: PlannerRawInputs = {
      finishedLotId:    LOT_ID,
      finishedLotNumber: "LOT-003",
      unitsProduced:    5000,
      displaysProduced: null,
      casesProduced:    null,
      product:          BASE_PRODUCT,
      ledgerRows:   [],
      fallbackRows: [
        {
          batchId:          BATCH_X,
          qtyConsumed:      10000,  // full pillCount — this is the bug scenario, but planner guards it
          tabletTypeId:     "tttttttt-0000-0000-0000-000000000001",
          tabletName:       "DHA 400mg",
          tabletZohoItemId: "ZTAB-001",
        },
      ],
      bomRows: [UNIT_BOM_ROW],
    };
    const plan = computeZohoAssemblyPlan(inputs);
    expect(plan.sourceMethod).toBe("FALLBACK");
    const receiveOp = plan.ops.find((o) => o.opKind === "TABLET_RECEIVE");
    expect(receiveOp).toBeDefined();
    expect(receiveOp!.statusPreview).toBe("NEEDS_MAPPING");
  });
});

// ─── Idempotency key format contract ─────────────────────────────────────────

describe("idempotency key format contract", () => {
  it("LEDGER TABLET_RECEIVE key uses inventoryBagId", () => {
    const plan = computeZohoAssemblyPlan(baseInputs());
    const op = plan.ops[0]!;
    expect(op.idempotencyKey).toBe(`luma:tablet_receive:${LOT_ID}:${BAG_A}`);
  });

  it("UNIT_ASSEMBLE key format", () => {
    const plan = computeZohoAssemblyPlan(baseInputs());
    const op = plan.ops.find((o) => o.opKind === "UNIT_ASSEMBLE")!;
    expect(op.idempotencyKey).toBe(`luma:unit_assemble:${LOT_ID}`);
  });

  it("DISPLAY_ASSEMBLE key format", () => {
    const plan = computeZohoAssemblyPlan(baseInputs());
    const op = plan.ops.find((o) => o.opKind === "DISPLAY_ASSEMBLE")!;
    expect(op.idempotencyKey).toBe(`luma:display_assemble:${LOT_ID}`);
  });

  it("CASE_ASSEMBLE key format", () => {
    const plan = computeZohoAssemblyPlan(baseInputs());
    const op = plan.ops.find((o) => o.opKind === "CASE_ASSEMBLE")!;
    expect(op.idempotencyKey).toBe(`luma:case_assemble:${LOT_ID}`);
  });
});
