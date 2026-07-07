// BAG-PRODUCTION-SUMMARY-1 — pure per-bag production breakdown tests.
// Data honesty: missing is never rendered as zero, negative remaining is
// never clamped, sources are always labeled.

import { describe, expect, it } from "vitest";
import {
  computeBagProductionSummary,
  type BagProductionSummaryInput,
  type BagSummaryWorkflowInput,
} from "./bag-production-summary";

function workflow(
  overrides: Partial<BagSummaryWorkflowInput> = {},
): BagSummaryWorkflowInput {
  return {
    workflowBagId: "wf-1",
    productId: "prod-1",
    productName: "Product A",
    productKind: "CARD",
    tabletsPerUnit: 4,
    stage: "FINALIZED",
    isFinalized: true,
    finalizedAt: new Date("2026-06-03T20:46:32Z"),
    excludedFromOutput: false,
    recoveryStatus: null,
    metrics: {
      masterCases: 10,
      displaysMade: 44,
      looseCards: 0,
      damagedPackaging: 0,
      rippedCards: 1,
      unitsYielded: 1640,
    },
    deepestOutput: null,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<BagProductionSummaryInput> = {},
): BagProductionSummaryInput {
  return {
    inventoryBagId: "bag-1",
    receiveId: "rcv-1",
    receiptNumber: "352182",
    poId: "po-1",
    poNumber: "PO-00238",
    tabletName: "MIT B Chocolate Brown",
    supplierLot: "LOT-9",
    qrToken: "BAG-abc",
    bagStatus: "EMPTIED",
    pillCount: 7223,
    declaredPillCount: 7200,
    workflows: [workflow()],
    allocationSessions: [
      {
        sessionId: "sess-1",
        status: "DEPLETED",
        startingBalanceQty: 7223,
        endingBalanceQty: 0,
        endingBalanceSource: "ALLOCATION_REPAIR_CLOSEOUT",
        consumedQty: 6560,
        openedAt: new Date("2026-06-03T20:00:00Z"),
      },
    ],
    finishedLots: [
      { id: "lot-1", lotNumber: "352182", status: "RELEASED", workflowBagId: "wf-1" },
    ],
    zoho: { opId: "op-1", status: "NEEDS_MAPPING", reason: null },
    ...overrides,
  };
}

describe("received tablets", () => {
  it("uses pill count as Actual, falling back to declared as Supplier-declared", () => {
    const s = computeBagProductionSummary(baseInput());
    expect(s.receivedTablets).toBe(7223);
    expect(s.receivedSource).toBe("Actual");

    const declaredOnly = computeBagProductionSummary(
      baseInput({ pillCount: null }),
    );
    expect(declaredOnly.receivedTablets).toBe(7200);
    expect(declaredOnly.receivedSource).toBe("Supplier-declared");
  });

  it("marks received Missing (not zero) when neither count exists", () => {
    const s = computeBagProductionSummary(
      baseInput({ pillCount: null, declaredPillCount: null }),
    );
    expect(s.receivedTablets).toBeNull();
    expect(s.receivedSource).toBe("Missing");
    expect(s.percentComplete).toBeNull();
    expect(s.flags.needsReview).toBe(true);
  });
});

describe("produced tablets", () => {
  it("untouched available bag: produced 0, remaining = received, 0% complete", () => {
    const s = computeBagProductionSummary(
      baseInput({
        bagStatus: "AVAILABLE",
        workflows: [],
        allocationSessions: [],
        finishedLots: [],
        zoho: null,
      }),
    );
    expect(s.producedTablets).toBe(0);
    expect(s.producedSource).toBe("No production recorded");
    expect(s.expectedRemainingTablets).toBe(7223);
    expect(s.percentComplete).toBe(0);
    expect(s.nextAction).toMatch(/start workflow/i);
  });

  it("card route: converts packaging units to tablets via tablets-per-unit", () => {
    const s = computeBagProductionSummary(baseInput());
    // 1640 units × 4 tablets = 6560 tablets
    expect(s.producedTablets).toBe(6560);
    expect(s.producedSource).toBe("Packaging counts");
    expect(s.expectedRemainingTablets).toBe(7223 - 6560);
    expect(s.percentComplete).toBe(91);
    expect(s.outputCounts).toEqual({
      cases: 10,
      displays: 44,
      loose: 0,
      damaged: 0,
      ripped: 1,
      unitsYielded: 1640,
    });
  });

  it("bottle route works the same through units yielded", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [
          workflow({
            productKind: "BOTTLE",
            tabletsPerUnit: 30,
            metrics: {
              masterCases: 0,
              displaysMade: 0,
              looseCards: 120,
              damagedPackaging: 0,
              rippedCards: 0,
              unitsYielded: 120,
            },
          }),
        ],
      }),
    );
    expect(s.producedTablets).toBe(3600);
  });

  it("falls back to deepest stage output when metrics are absent (sealing labeled)", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [
          workflow({
            isFinalized: false,
            stage: "SEALED",
            metrics: null,
            deepestOutput: { stage: "SEALING", units: 500 },
          }),
        ],
        finishedLots: [],
        zoho: null,
      }),
    );
    expect(s.producedTablets).toBe(2000);
    expect(s.producedSource).toBe("Sealing counts");
  });

  it("missing tablets-per-unit → produced unknown, needs review, never a fake number", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [workflow({ tabletsPerUnit: null })],
      }),
    );
    expect(s.producedTablets).toBeNull();
    expect(s.producedSource).toBe("Unknown");
    expect(s.flags.consumptionUnknown).toBe(true);
    expect(s.flags.needsReview).toBe(true);
    expect(s.percentComplete).toBeNull();
  });

  it("recovered/excluded workflow output does not count as produced but is flagged", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [
          workflow({
            excludedFromOutput: true,
            recoveryStatus: "WRONG_ROUTE_RECOVERED",
          }),
        ],
        finishedLots: [],
        zoho: null,
      }),
    );
    expect(s.producedTablets).toBe(0);
    expect(s.workflow?.excludedFromOutput).toBe(true);
    expect(s.nextAction).toMatch(/wrong route recovered/i);
  });

  it("multiple workflows: totals produced, sets flag and count", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [
          workflow(),
          workflow({
            workflowBagId: "wf-2",
            metrics: {
              masterCases: 0,
              displaysMade: 10,
              looseCards: 5,
              damagedPackaging: 0,
              rippedCards: 0,
              unitsYielded: 205,
            },
          }),
        ],
      }),
    );
    expect(s.producedTablets).toBe(6560 + 820);
    expect(s.flags.multipleWorkflows).toBe(true);
    expect(s.workflowCount).toBe(2);
  });
});

describe("remaining", () => {
  it("recorded remaining from CLOSED session ending balance with source label", () => {
    const s = computeBagProductionSummary(
      baseInput({
        allocationSessions: [
          {
            sessionId: "sess-1",
            status: "CLOSED",
            startingBalanceQty: 7223,
            endingBalanceQty: 1020,
            endingBalanceSource: "SUPERVISOR_ESTIMATE",
            consumedQty: 6203,
            openedAt: new Date("2026-06-03T20:00:00Z"),
          },
        ],
      }),
    );
    expect(s.recordedRemainingTablets).toBe(1020);
    expect(s.remainingSource).toBe("Supervisor estimate");
    expect(s.flags.partialRemaining).toBe(true);
  });

  it("RETURNED_TO_STOCK shows recorded remaining; DEPLETED shows 0", () => {
    const returned = computeBagProductionSummary(
      baseInput({
        allocationSessions: [
          {
            sessionId: "s",
            status: "RETURNED_TO_STOCK",
            startingBalanceQty: 7223,
            endingBalanceQty: 663,
            endingBalanceSource: "SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT",
            consumedQty: 6560,
            openedAt: null,
          },
        ],
      }),
    );
    expect(returned.recordedRemainingTablets).toBe(663);
    expect(returned.remainingSource).toBe("System-derived");

    const depleted = computeBagProductionSummary(baseInput());
    expect(depleted.recordedRemainingTablets).toBe(0);
  });

  it("open allocation: no recorded remaining; expected remaining still shown", () => {
    const s = computeBagProductionSummary(
      baseInput({
        allocationSessions: [
          {
            sessionId: "s",
            status: "OPEN",
            startingBalanceQty: 7223,
            endingBalanceQty: null,
            endingBalanceSource: null,
            consumedQty: null,
            openedAt: null,
          },
        ],
        finishedLots: [],
        zoho: null,
      }),
    );
    expect(s.recordedRemainingTablets).toBeNull();
    expect(s.expectedRemainingTablets).toBe(663);
    expect(s.allocation?.isOpen).toBe(true);
  });

  it("flags mismatch when expected and recorded remaining differ", () => {
    const s = computeBagProductionSummary(
      baseInput({
        allocationSessions: [
          {
            sessionId: "s",
            status: "CLOSED",
            startingBalanceQty: 7223,
            endingBalanceQty: 1020,
            endingBalanceSource: "SUPERVISOR_ESTIMATE",
            consumedQty: 6203,
            openedAt: null,
          },
        ],
      }),
    );
    // expected 663 vs recorded 1020
    expect(s.flags.remainingMismatch).toBe(true);
    expect(s.remainingDifference).toBe(1020 - 663);
  });

  it("over-consumption is shown negative, never clamped to zero", () => {
    const s = computeBagProductionSummary(
      baseInput({
        pillCount: 5000,
        declaredPillCount: null,
      }),
    );
    expect(s.expectedRemainingTablets).toBe(5000 - 6560);
    expect(s.expectedRemainingTablets).toBeLessThan(0);
    expect(s.flags.overConsumed).toBe(true);
  });

  it("split bag (multiple sessions) sets splitBag flag", () => {
    const s = computeBagProductionSummary(
      baseInput({
        allocationSessions: [
          {
            sessionId: "s1",
            status: "CLOSED",
            startingBalanceQty: 7223,
            endingBalanceQty: 3000,
            endingBalanceSource: "SUPERVISOR_ESTIMATE",
            consumedQty: 4223,
            openedAt: new Date("2026-06-01T00:00:00Z"),
          },
          {
            sessionId: "s2",
            status: "OPEN",
            startingBalanceQty: 3000,
            endingBalanceQty: null,
            endingBalanceSource: null,
            consumedQty: null,
            openedAt: new Date("2026-06-05T00:00:00Z"),
          },
        ],
      }),
    );
    expect(s.flags.splitBag).toBe(true);
    // Latest session is OPEN → no recorded remaining yet.
    expect(s.allocation?.isOpen).toBe(true);
    expect(s.recordedRemainingTablets).toBeNull();
  });
});

describe("next action", () => {
  it("finalized awaiting lot → issue finished lot", () => {
    const s = computeBagProductionSummary(
      baseInput({ finishedLots: [], zoho: null }),
    );
    expect(s.nextAction).toMatch(/issue finished lot/i);
  });

  it("on floor → finalize workflow", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [
          workflow({ isFinalized: false, stage: "BLISTERED", metrics: null, deepestOutput: null }),
        ],
        finishedLots: [],
        zoho: null,
      }),
    );
    expect(s.nextAction).toMatch(/finalize/i);
  });

  it("pending QC lot → release", () => {
    const s = computeBagProductionSummary(
      baseInput({
        finishedLots: [
          { id: "lot-1", lotNumber: "352182", status: "PENDING_QC", workflowBagId: "wf-1" },
        ],
        zoho: null,
      }),
    );
    expect(s.nextAction).toMatch(/release/i);
  });

  it("released with Zoho ready to queue → queue Zoho; committed → done", () => {
    const ready = computeBagProductionSummary(
      baseInput({ zoho: { opId: "op-1", status: "READY_TO_QUEUE", reason: null } }),
    );
    expect(ready.nextAction).toMatch(/queue zoho/i);

    const committed = computeBagProductionSummary(
      baseInput({ zoho: { opId: "op-1", status: "COMMITTED", reason: null } }),
    );
    expect(committed.nextAction).toBe("Done");
  });

  it("released with Zoho needs mapping → fix mapping", () => {
    const s = computeBagProductionSummary(baseInput());
    expect(s.nextAction).toMatch(/mapping/i);
  });

  it("emptied bag with no workflow fails closed to needs review", () => {
    const s = computeBagProductionSummary(
      baseInput({
        workflows: [],
        allocationSessions: [],
        finishedLots: [],
        zoho: null,
      }),
    );
    expect(s.nextAction).toMatch(/needs review/i);
  });
});
