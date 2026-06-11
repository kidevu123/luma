import { describe, expect, it } from "vitest";
import {
  assertAutoLotRepairAllowed,
  evaluateAutoLotBacklogRow,
  type AutoLotBacklogRowInput,
} from "./auto-lot-backlog-eligibility";

const BASE: AutoLotBacklogRowInput = {
  workflowBagId: "wf-1",
  productId: "prod-1",
  productName: "Pink Rozay",
  inventoryBagId: "inv-1",
  ambiguousSourceBagCount: 1,
  inventoryPillCount: 5000,
  lastClosedSessionEndingBalance: null,
  lastClosedSessionStartingBalance: null,
  lastClosedSessionConsumedQty: null,
  tabletsPerUnit: 1,
  unitsPerDisplay: 20,
  displaysPerCase: 20,
  defaultShelfLifeDays: 365,
  inventoryReceiptNumber: "352315",
  workflowReceiptNumber: null,
  unitsYielded: 4002,
  counts: { masterCases: 9, displaysMade: 20, looseCards: 2 },
  finalizedAt: new Date("2026-06-01T12:00:00Z"),
  excludedFromOutput: false,
  hasFinishedLot: false,
  openAllocationSessionId: "sess-1",
  openAllocationStartingBalance: 5000,
  openAllocationOnOtherWorkflow: false,
  zohoOutputCommitted: false,
  lotNumberConflict: false,
};

describe("evaluateAutoLotBacklogRow", () => {
  it("ready when open allocation and product math are valid", () => {
    const r = evaluateAutoLotBacklogRow(BASE);
    expect(r.code).toBe("READY_TO_AUTO_ISSUE");
    expect(r.action).toBe("AUTO_ISSUE_NOW");
    expect(r.expectedConsumedQty).toBe(4002);
    expect(r.expectedEndingBalanceQty).toBe(998);
  });

  it("repairable when allocation session missing but source is deterministic", () => {
    const r = evaluateAutoLotBacklogRow({
      ...BASE,
      openAllocationSessionId: null,
      openAllocationStartingBalance: null,
    });
    expect(r.code).toBe("MISSING_ALLOCATION_SESSION");
    expect(r.action).toBe("REPAIR_ALLOCATION");
    expect(r.expectedConsumedQty).toBe(4002);
  });

  it("blocks when product is missing", () => {
    const r = evaluateAutoLotBacklogRow({ ...BASE, productId: null });
    expect(r.code).toBe("MISSING_PRODUCT");
    expect(r.action).toBe("REVIEW_MANUALLY");
  });

  it("blocks when tabletsPerUnit is missing", () => {
    const r = evaluateAutoLotBacklogRow({ ...BASE, tabletsPerUnit: null });
    expect(r.code).toBe("MISSING_TABLETS_PER_UNIT");
    expect(r.action).toBe("FIX_PRODUCT_SETUP");
  });

  it("blocks negative ending balance", () => {
    const r = evaluateAutoLotBacklogRow({
      ...BASE,
      openAllocationStartingBalance: 1000,
    });
    expect(r.code).toBe("NEGATIVE_ENDING_BALANCE");
    expect(r.expectedEndingBalanceQty).toBeLessThan(0);
  });

  it("blocks when finished lot already exists", () => {
    const r = evaluateAutoLotBacklogRow({ ...BASE, hasFinishedLot: true });
    expect(r.code).toBe("FINISHED_LOT_EXISTS");
  });

  it("blocks when Zoho output committed", () => {
    const r = evaluateAutoLotBacklogRow({ ...BASE, zohoOutputCommitted: true });
    expect(r.code).toBe("ZOHO_OUTPUT_COMMITTED");
  });

  it("blocks ambiguous multiple source bags", () => {
    const r = evaluateAutoLotBacklogRow({
      ...BASE,
      ambiguousSourceBagCount: 2,
    });
    expect(r.code).toBe("MULTIPLE_SOURCE_BAGS_NEED_REVIEW");
  });

  it("Pink Rozay 4002 units × tabletsPerUnit 1 = 4002", () => {
    const r = evaluateAutoLotBacklogRow(BASE);
    expect(r.expectedConsumedQty).toBe(4002);
  });

  it("Choco Drift 4 tabs/unit still computes via product structure", () => {
    const r = evaluateAutoLotBacklogRow({
      ...BASE,
      tabletsPerUnit: 4,
      unitsYielded: 100,
    });
    expect(r.expectedConsumedQty).toBe(400);
  });
});

describe("assertAutoLotRepairAllowed", () => {
  it("allows ready rows", () => {
    expect(assertAutoLotRepairAllowed(evaluateAutoLotBacklogRow(BASE))).toEqual({
      ok: true,
    });
  });

  it("allows repair when session missing but ending computable", () => {
    const evaluation = evaluateAutoLotBacklogRow({
      ...BASE,
      openAllocationSessionId: null,
      openAllocationStartingBalance: null,
    });
    expect(assertAutoLotRepairAllowed(evaluation)).toEqual({ ok: true });
  });

  it("refuses missing starting balance for auto repair", () => {
    const evaluation = evaluateAutoLotBacklogRow({
      ...BASE,
      openAllocationSessionId: null,
      openAllocationStartingBalance: null,
      inventoryPillCount: null,
      lastClosedSessionEndingBalance: null,
    });
    const r = assertAutoLotRepairAllowed(evaluation);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_STARTING_BALANCE");
    }
  });

  it("refuses consumed=0 path", () => {
    const evaluation = evaluateAutoLotBacklogRow({
      ...BASE,
      unitsYielded: 0,
      counts: { masterCases: 0, displaysMade: 0, looseCards: 0 },
    });
    const r = assertAutoLotRepairAllowed(evaluation);
    expect(r.ok).toBe(false);
  });
});
