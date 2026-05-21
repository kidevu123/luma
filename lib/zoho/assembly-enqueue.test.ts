// ZOHO-ASSY-3 — Tests for the assembly enqueue service.
//
// buildZohoAssemblyOpInput — tested as a pure function (no mocks needed).
// enqueueZohoAssemblyOpsForFinishedLot — tested with mocked planner + DB.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks must appear before the module-under-test is imported ─────────
vi.mock("./assembly-planner", () => ({
  planZohoAssemblyForFinishedLot: vi.fn(),
}));

vi.mock("@/lib/db/queries/zoho-assembly", () => ({
  listZohoAssemblyOps:  vi.fn(),
  createZohoAssemblyOp: vi.fn(),
}));

import {
  buildZohoAssemblyOpInput,
  enqueueZohoAssemblyOpsForFinishedLot,
} from "./assembly-enqueue";
import { planZohoAssemblyForFinishedLot } from "./assembly-planner";
import {
  listZohoAssemblyOps,
  createZohoAssemblyOp,
} from "@/lib/db/queries/zoho-assembly";

import type {
  PlanTabletReceiveOp,
  PlanAssemblyOp,
  ZohoAssemblyPlanResult,
} from "./assembly-planner";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LOT_ID  = "11111111-0000-0000-0000-000000000001";
const BAG_A   = "aaaaaaaa-0000-0000-0000-000000000001";
const BAG_B   = "bbbbbbbb-0000-0000-0000-000000000001";
const PROD_ID = "dddddddd-0000-0000-0000-000000000001";
const TT_ID   = "tttttttt-0000-0000-0000-000000000001";
const PL_ID   = "pppppppp-0000-0000-0000-000000000001";

function makeTabletReceiveOp(overrides: Partial<PlanTabletReceiveOp> = {}): PlanTabletReceiveOp {
  return {
    opKind:               "TABLET_RECEIVE",
    opSequence:           1,
    idempotencyKey:       `luma:tablet_receive:${LOT_ID}:${BAG_A}`,
    sourceInventoryBagId: BAG_A,
    sourcePoLineId:       PL_ID,
    sourceTabletTypeId:   TT_ID,
    tabletTypeName:       "DHA 400mg",
    zohoTabletItemId:     "ZTAB-001",
    zohoPoId:             "ZPO-001",
    zohoLineItemId:       "ZLINE-001",
    quantity:             1200,
    componentRole:        null,
    statusPreview:        "READY",
    statusReason:         null,
    payloadPreview:       { zohoPoId: "ZPO-001", zohoLineItemId: "ZLINE-001", quantity: 1200 },
    ...overrides,
  };
}

function makeUnitAssembleOp(overrides: Partial<PlanAssemblyOp> = {}): PlanAssemblyOp {
  return {
    opKind:         "UNIT_ASSEMBLE",
    opSequence:     2,
    idempotencyKey: `luma:unit_assemble:${LOT_ID}`,
    zohoItemId:     "ZITEM-UNIT",
    quantity:       840,
    statusPreview:  "READY",
    statusReason:   null,
    bomLines:       [],
    payloadPreview: { zohoItemId: "ZITEM-UNIT", quantity: 840 },
    ...overrides,
  };
}

function makeDisplayAssembleOp(overrides: Partial<PlanAssemblyOp> = {}): PlanAssemblyOp {
  return {
    opKind:         "DISPLAY_ASSEMBLE",
    opSequence:     3,
    idempotencyKey: `luma:display_assemble:${LOT_ID}`,
    zohoItemId:     "ZITEM-DISP",
    quantity:       60,
    statusPreview:  "READY",
    statusReason:   null,
    bomLines:       [],
    payloadPreview: { zohoItemId: "ZITEM-DISP", quantity: 60 },
    ...overrides,
  };
}

function makePlan(ops: PlanAssemblyOp["opKind"] extends string ? Array<PlanTabletReceiveOp | PlanAssemblyOp> : never): ZohoAssemblyPlanResult {
  return {
    finishedLotId:    LOT_ID,
    finishedLotNumber: "FL-2026-001",
    product: { id: PROD_ID, name: "DHA 400mg NCF", sku: "DHA400", kind: "CARD",
      zohoItemIdUnit: "ZITEM-UNIT", zohoItemIdDisplay: null, zohoItemIdCase: null },
    ops,
    sourceMethod:  "LEDGER",
    overallStatus: "READY",
    issues:        [],
  };
}

function stubRow(idempotencyKey: string): ZohoAssemblyOp {
  return {
    id:                   "00000000-0000-0000-0000-000000000001",
    finishedLotId:        LOT_ID,
    opKind:               "UNIT_ASSEMBLE",
    zohoItemId:           null,
    quantity:             0,
    status:               "PENDING",
    idempotencyKey,
    zohoReferenceId:      null,
    requestPayload:       null,
    responsePayload:      null,
    lastError:            null,
    retryCount:           0,
    enqueuedAt:           new Date(),
    startedAt:            null,
    succeededAt:          null,
    failedAt:             null,
    resolvedManually:     false,
    resolvedNote:         null,
    resolvedByUserId:     null,
    sourceInventoryBagId: null,
    sourcePoLineId:       null,
    sourceTabletTypeId:   null,
    componentRole:        null,
    opSequence:           null,
  };
}

// ─── buildZohoAssemblyOpInput (pure) ─────────────────────────────────────────

describe("buildZohoAssemblyOpInput — TABLET_RECEIVE ops", () => {
  it("READY → status PENDING", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ statusPreview: "READY" }));
    expect(input.status).toBe("PENDING");
  });

  it("NEEDS_MAPPING → status NEEDS_MAPPING", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({
      statusPreview: "NEEDS_MAPPING",
      zohoTabletItemId: null,
    }));
    expect(input.status).toBe("NEEDS_MAPPING");
  });

  it("BLOCKED → status NEEDS_MAPPING (conservative mapping)", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ statusPreview: "BLOCKED" }));
    expect(input.status).toBe("NEEDS_MAPPING");
  });

  it("preserves opKind as TABLET_RECEIVE", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp());
    expect(input.opKind).toBe("TABLET_RECEIVE");
  });

  it("preserves quantity from consumedQty", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ quantity: 1500 }));
    expect(input.quantity).toBe(1500);
  });

  it("preserves idempotencyKey", () => {
    const op = makeTabletReceiveOp();
    const input = buildZohoAssemblyOpInput(LOT_ID, op);
    expect(input.idempotencyKey).toBe(`luma:tablet_receive:${LOT_ID}:${BAG_A}`);
  });

  it("preserves opSequence = 1", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp());
    expect(input.opSequence).toBe(1);
  });

  it("preserves sourceInventoryBagId", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ sourceInventoryBagId: BAG_A }));
    expect(input.sourceInventoryBagId).toBe(BAG_A);
  });

  it("preserves sourcePoLineId", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ sourcePoLineId: PL_ID }));
    expect(input.sourcePoLineId).toBe(PL_ID);
  });

  it("preserves sourceTabletTypeId", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ sourceTabletTypeId: TT_ID }));
    expect(input.sourceTabletTypeId).toBe(TT_ID);
  });

  it("preserves componentRole", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ componentRole: "FLAVOR_A" }));
    expect(input.componentRole).toBe("FLAVOR_A");
  });

  it("uses zohoTabletItemId as zohoItemId", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ zohoTabletItemId: "ZTAB-999" }));
    expect(input.zohoItemId).toBe("ZTAB-999");
  });

  it("stores payloadPreview as requestPayload", () => {
    const op = makeTabletReceiveOp();
    const input = buildZohoAssemblyOpInput(LOT_ID, op);
    expect(input.requestPayload).toEqual(op.payloadPreview);
  });

  it("null zohoTabletItemId becomes null zohoItemId", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeTabletReceiveOp({ zohoTabletItemId: null }));
    expect(input.zohoItemId).toBeNull();
  });
});

describe("buildZohoAssemblyOpInput — assembly ops", () => {
  it("READY UNIT_ASSEMBLE → status PENDING", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeUnitAssembleOp({ statusPreview: "READY" }));
    expect(input.status).toBe("PENDING");
  });

  it("NEEDS_MAPPING UNIT_ASSEMBLE → status NEEDS_MAPPING", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeUnitAssembleOp({
      statusPreview: "NEEDS_MAPPING",
      zohoItemId: null,
    }));
    expect(input.status).toBe("NEEDS_MAPPING");
  });

  it("preserves opKind UNIT_ASSEMBLE", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeUnitAssembleOp());
    expect(input.opKind).toBe("UNIT_ASSEMBLE");
  });

  it("preserves opSequence = 2 for UNIT_ASSEMBLE", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeUnitAssembleOp());
    expect(input.opSequence).toBe(2);
  });

  it("preserves opSequence = 3 for DISPLAY_ASSEMBLE", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeDisplayAssembleOp());
    expect(input.opSequence).toBe(3);
  });

  it("stores payloadPreview as requestPayload on assembly ops", () => {
    const op = makeUnitAssembleOp();
    const input = buildZohoAssemblyOpInput(LOT_ID, op);
    expect(input.requestPayload).toEqual({ zohoItemId: "ZITEM-UNIT", quantity: 840 });
  });

  it("has no source fields on assembly ops", () => {
    const input = buildZohoAssemblyOpInput(LOT_ID, makeUnitAssembleOp());
    expect(input.sourceInventoryBagId).toBeUndefined();
    expect(input.sourcePoLineId).toBeUndefined();
    expect(input.sourceTabletTypeId).toBeUndefined();
  });
});

// ─── enqueueZohoAssemblyOpsForFinishedLot (mocked) ───────────────────────────

const mockPlan = vi.mocked(planZohoAssemblyForFinishedLot);
const mockList = vi.mocked(listZohoAssemblyOps);
const mockCreate = vi.mocked(createZohoAssemblyOp);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(stubRow("any"));
});

describe("Scenario A — simple product: TABLET_RECEIVE + UNIT_ASSEMBLE created", () => {
  beforeEach(() => {
    mockPlan.mockResolvedValue(makePlan([
      makeTabletReceiveOp(),
      makeUnitAssembleOp(),
      makeDisplayAssembleOp({ statusPreview: "SKIPPED", quantity: 0 }),
    ]));
    mockList.mockResolvedValue([]);
  });

  it("returns correct counts", async () => {
    const r = await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(r?.enqueued).toBe(2);  // TABLET_RECEIVE + UNIT_ASSEMBLE
    expect(r?.skipped).toBe(1);   // DISPLAY_ASSEMBLE
    expect(r?.existing).toBe(0);
  });

  it("calls createZohoAssemblyOp exactly twice", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("creates TABLET_RECEIVE with status PENDING", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const receiveCall = mockCreate.mock.calls.find(
      ([i]) => i.opKind === "TABLET_RECEIVE",
    );
    expect(receiveCall?.[0].status).toBe("PENDING");
  });

  it("creates UNIT_ASSEMBLE with status PENDING", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const unitCall = mockCreate.mock.calls.find(
      ([i]) => i.opKind === "UNIT_ASSEMBLE",
    );
    expect(unitCall?.[0].status).toBe("PENDING");
  });

  it("does NOT call createZohoAssemblyOp for SKIPPED op", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const displayCall = mockCreate.mock.calls.find(
      ([i]) => i.opKind === "DISPLAY_ASSEMBLE",
    );
    expect(displayCall).toBeUndefined();
  });
});

describe("Scenario B — variety product: two TABLET_RECEIVE rows created", () => {
  beforeEach(() => {
    const bagAOp = makeTabletReceiveOp({
      inventoryBagId: BAG_A,
      idempotencyKey: `luma:tablet_receive:${LOT_ID}:${BAG_A}`,
      componentRole:  "PRIMARY",
    } as Partial<PlanTabletReceiveOp>);
    const bagBOp = makeTabletReceiveOp({
      sourceInventoryBagId: BAG_B,
      idempotencyKey: `luma:tablet_receive:${LOT_ID}:${BAG_B}`,
      componentRole:  "FLAVOR_A",
    });
    mockPlan.mockResolvedValue(makePlan([bagAOp, bagBOp, makeUnitAssembleOp()]));
    mockList.mockResolvedValue([]);
  });

  it("creates 3 rows (2 TABLET_RECEIVE + 1 UNIT_ASSEMBLE)", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("creates rows with different idempotency keys", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const keys = mockCreate.mock.calls.map(([i]) => i.idempotencyKey);
    expect(keys).toContain(`luma:tablet_receive:${LOT_ID}:${BAG_A}`);
    expect(keys).toContain(`luma:tablet_receive:${LOT_ID}:${BAG_B}`);
    expect(new Set(keys).size).toBe(3);
  });

  it("preserves componentRole on each TABLET_RECEIVE row", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const receiveCalls = mockCreate.mock.calls.filter(
      ([i]) => i.opKind === "TABLET_RECEIVE",
    );
    const roles = receiveCalls.map(([i]) => i.componentRole);
    expect(roles).toContain("PRIMARY");
    expect(roles).toContain("FLAVOR_A");
  });
});

describe("Scenario C — idempotency: repeated enqueue does not duplicate rows", () => {
  beforeEach(() => {
    mockPlan.mockResolvedValue(makePlan([makeTabletReceiveOp(), makeUnitAssembleOp()]));
  });

  it("first call creates 2 rows", async () => {
    mockList.mockResolvedValue([]);
    const r = await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(r?.enqueued).toBe(2);
    expect(r?.existing).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("second call creates 0 rows when both already exist", async () => {
    mockList.mockResolvedValue([
      stubRow(`luma:tablet_receive:${LOT_ID}:${BAG_A}`),
      stubRow(`luma:unit_assemble:${LOT_ID}`),
    ]);
    const r = await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(r?.enqueued).toBe(0);
    expect(r?.existing).toBe(2);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("partial re-enqueue creates only missing rows", async () => {
    // Only the TABLET_RECEIVE already exists; UNIT_ASSEMBLE is new.
    mockList.mockResolvedValue([
      stubRow(`luma:tablet_receive:${LOT_ID}:${BAG_A}`),
    ]);
    const r = await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(r?.enqueued).toBe(1);   // UNIT_ASSEMBLE
    expect(r?.existing).toBe(1);   // TABLET_RECEIVE
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0].opKind).toBe("UNIT_ASSEMBLE");
  });
});

describe("Scenario D — missing mapping creates NEEDS_MAPPING rows", () => {
  beforeEach(() => {
    mockPlan.mockResolvedValue(makePlan([
      makeTabletReceiveOp({
        statusPreview: "NEEDS_MAPPING",
        zohoTabletItemId: null,
        statusReason: "tablet type has no Zoho item ID",
      }),
      makeUnitAssembleOp({ statusPreview: "NEEDS_MAPPING", zohoItemId: null }),
    ]));
    mockList.mockResolvedValue([]);
  });

  it("still creates rows (not skipped) despite NEEDS_MAPPING", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("TABLET_RECEIVE row gets status NEEDS_MAPPING", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const call = mockCreate.mock.calls.find(([i]) => i.opKind === "TABLET_RECEIVE");
    expect(call?.[0].status).toBe("NEEDS_MAPPING");
  });

  it("UNIT_ASSEMBLE row gets status NEEDS_MAPPING", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const call = mockCreate.mock.calls.find(([i]) => i.opKind === "UNIT_ASSEMBLE");
    expect(call?.[0].status).toBe("NEEDS_MAPPING");
  });
});

describe("Scenario E — skipped display/case ops are not inserted", () => {
  beforeEach(() => {
    mockPlan.mockResolvedValue(makePlan([
      makeTabletReceiveOp(),
      makeUnitAssembleOp(),
      // DISPLAY and CASE both skipped
      makeDisplayAssembleOp({ statusPreview: "SKIPPED", quantity: 0, zohoItemId: null }),
      {
        opKind:         "CASE_ASSEMBLE",
        opSequence:     4,
        idempotencyKey: `luma:case_assemble:${LOT_ID}`,
        zohoItemId:     null,
        quantity:       0,
        statusPreview:  "SKIPPED",
        statusReason:   "No cases produced",
        bomLines:       [],
        payloadPreview: { zohoItemId: null, quantity: 0 },
      } satisfies PlanAssemblyOp,
    ]));
    mockList.mockResolvedValue([]);
  });

  it("creates exactly 2 rows (TABLET_RECEIVE + UNIT_ASSEMBLE)", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("DISPLAY_ASSEMBLE is never passed to createZohoAssemblyOp", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const displayCall = mockCreate.mock.calls.find(([i]) => i.opKind === "DISPLAY_ASSEMBLE");
    expect(displayCall).toBeUndefined();
  });

  it("CASE_ASSEMBLE is never passed to createZohoAssemblyOp", async () => {
    await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    const caseCall = mockCreate.mock.calls.find(([i]) => i.opKind === "CASE_ASSEMBLE");
    expect(caseCall).toBeUndefined();
  });

  it("skipped count equals 2", async () => {
    const r = await enqueueZohoAssemblyOpsForFinishedLot(LOT_ID);
    expect(r?.skipped).toBe(2);
  });
});

describe("Scenario F — lot not found returns null", () => {
  it("returns null when planZohoAssemblyForFinishedLot returns null", async () => {
    mockPlan.mockResolvedValue(null);
    const r = await enqueueZohoAssemblyOpsForFinishedLot("nonexistent-id");
    expect(r).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
