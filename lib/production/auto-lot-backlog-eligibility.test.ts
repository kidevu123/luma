import { describe, expect, it } from "vitest";
import {
  assertAutoLotRepairAllowed,
  evaluateAutoLotBacklogRow,
  type AutoLotBacklogRowInput,
} from "./auto-lot-backlog-eligibility";

// Bug B: bag 1890-29 numbers — start 20000, produced 4906 units × 4 tabs = 19624 consumed, ending 376.
const BAG_1890_29_BASE: AutoLotBacklogRowInput = {
  workflowBagId: "69e6225d-e6a6-4586-9e17-15b037abc529",
  productId: "prod-x",
  productName: "Product X",
  inventoryBagId: "inv-1890-29",
  ambiguousSourceBagCount: 1,
  inventoryPillCount: 20000,
  lastClosedSessionEndingBalance: 376,
  lastClosedSessionStartingBalance: 20000,
  lastClosedSessionConsumedQty: 19624,
  lastClosedSessionWorkflowBagId: "69e6225d-e6a6-4586-9e17-15b037abc529",
  tabletsPerUnit: 4,
  unitsPerDisplay: 10,
  displaysPerCase: 10,
  defaultShelfLifeDays: 365,
  inventoryReceiptNumber: "1890-29",
  workflowReceiptNumber: null,
  unitsYielded: 4906,
  counts: { masterCases: 49, displaysMade: 0, looseCards: 6 },
  finalizedAt: new Date("2026-08-01T12:00:00Z"),
  excludedFromOutput: false,
  hasFinishedLot: false,
  openAllocationSessionId: null,
  openAllocationStartingBalance: null,
  openAllocationOnOtherWorkflow: false,
  zohoOutputCommitted: false,
  lotNumberConflict: false,
};

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

// Bug B regression tests — same-workflow-closed-session double-count prevention.
describe("evaluateAutoLotBacklogRow — same-workflow closed session (Bug B)", () => {
  it(
    "READY_TO_AUTO_ISSUE when last closed session belongs to this workflow and consumed == expected (bag 1890-29 real numbers)",
    () => {
      // The last closed session is for THIS workflow bag: start 20000, consumed 19624 (4906 × 4), ending 376.
      // Expected consumption from output = 4906 × 4 = 19624. Consumed matches → ledger already settled.
      const r = evaluateAutoLotBacklogRow(BAG_1890_29_BASE);
      expect(r.code).toBe("READY_TO_AUTO_ISSUE");
      expect(r.action).toBe("AUTO_ISSUE_NOW");
      // expectedEnding should reflect what the closed session recorded, not re-subtract from starting.
      expect(r.expectedEndingBalanceQty).toBe(376);
      expect(r.expectedConsumedQty).toBe(19624);
    },
  );

  it(
    "MANUAL_REVIEW_REQUIRED when same-workflow closed session consumed != expected production counts",
    () => {
      // Recorded consumedQty 15000, but expected from production = 4906 × 4 = 19624. Disagreement.
      const r = evaluateAutoLotBacklogRow({
        ...BAG_1890_29_BASE,
        lastClosedSessionConsumedQty: 15000,
      });
      expect(r.code).toBe("MANUAL_REVIEW_REQUIRED");
      expect(r.action).toBe("REVIEW_MANUALLY");
      expect(r.nextStep).toMatch(/correct the allocation closeout/i);
    },
  );

  it(
    "uses normal reopen-base behaviour when last closed session belongs to a DIFFERENT workflow (regression pin)",
    () => {
      // The last closed session was for a different run → normal reopen base path.
      // Starting balance inferred from ending balance of prior session (5000 ending).
      // Then re-subtracts consumption for this run (4906 × 4 = 19624) → 5000 - 19624 < 0 → NEGATIVE_ENDING_BALANCE.
      const r = evaluateAutoLotBacklogRow({
        ...BAG_1890_29_BASE,
        lastClosedSessionWorkflowBagId: "other-workflow-id",
        lastClosedSessionEndingBalance: 5000,
        lastClosedSessionStartingBalance: 20000,
        lastClosedSessionConsumedQty: 15000,
        openAllocationSessionId: null,
        openAllocationStartingBalance: null,
        inventoryPillCount: null,
      });
      // Expected: 5000 starting − 19624 expected = negative → NEGATIVE_ENDING_BALANCE
      expect(r.code).toBe("NEGATIVE_ENDING_BALANCE");
    },
  );
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
