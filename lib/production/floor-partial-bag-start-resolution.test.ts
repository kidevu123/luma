import { describe, expect, it } from "vitest";
import {
  RAW_BAG_START_OPERATOR_MESSAGES,
  classifyRawBagStartFromInventoryContext,
} from "./floor-partial-bag-start-resolution";

type AllocationStatus = "OPEN" | "CLOSED" | "RETURNED_TO_STOCK" | "DEPLETED" | "VOIDED";

const closed = (endingBalanceQty: number | null) => ({
  allocationStatus: "CLOSED" as AllocationStatus,
  endingBalanceQty,
  closedAt: new Date("2026-01-01T00:00:00Z"),
});

describe("classifyRawBagStartFromInventoryContext", () => {
  it("returns UNLINKED when no inventory context", () => {
    const r = classifyRawBagStartFromInventoryContext(null);
    expect(r.status).toBe("UNLINKED");
    expect(r.canStart).toBe(false);
    expect(r.operatorMessage).toMatch(/not been linked/i);
  });

  it("returns PARTIAL_NEEDS_REVIEW for partial workflow with zero allocation sessions (bag-card-104 class)", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-1",
      inventoryStatus: "AVAILABLE",
      sessions: [],
      hasPartialPackagingWorkflow: true,
      hasActiveNonFinalizedWorkflow: false,
    });
    expect(r.status).toBe("PARTIAL_NEEDS_REVIEW");
    expect(r.canStart).toBe(false);
    expect(r.operatorMessage).toBe(
      RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_NEEDS_REVIEW,
    );
    expect(r.operatorMessage).not.toMatch(/not been linked/i);
  });

  it("returns PARTIAL_READY when partial bag matches canRestartAvailablePartialRawBag", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-2",
      inventoryStatus: "AVAILABLE",
      sessions: [
        {
          allocationStatus: "RETURNED_TO_STOCK",
          endingBalanceQty: 5000,
          closedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ],
      hasPartialPackagingWorkflow: true,
      hasActiveNonFinalizedWorkflow: false,
    });
    expect(r.status).toBe("PARTIAL_READY");
    expect(r.canStart).toBe(true);
  });

  it("returns PARTIAL_READY even when a stale non-finalized legacy workflow exists (bag-card-104 after void repair + resolve)", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "a23bec0d-36e8-4b65-a172-a605eb22c559",
      inventoryStatus: "AVAILABLE",
      sessions: [
        {
          allocationStatus: "RETURNED_TO_STOCK",
          endingBalanceQty: 3598,
          closedAt: new Date("2026-06-03T21:50:05Z"),
        },
      ],
      hasPartialPackagingWorkflow: true,
      hasActiveNonFinalizedWorkflow: true,
    });
    expect(r.status).toBe("PARTIAL_READY");
    expect(r.canStart).toBe(true);
    expect(r.operatorMessage).toBe("");
  });

  it("returns PARTIAL_NEEDS_ALLOCATION_CLOSEOUT when OPEN session remains", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-3",
      inventoryStatus: "AVAILABLE",
      sessions: [
        {
          allocationStatus: "OPEN",
          endingBalanceQty: null,
          closedAt: null,
        },
      ],
      hasPartialPackagingWorkflow: true,
      hasActiveNonFinalizedWorkflow: false,
    });
    expect(r.status).toBe("PARTIAL_NEEDS_ALLOCATION_CLOSEOUT");
    expect(r.canStart).toBe(false);
    expect(r.operatorMessage).toMatch(/allocation session still open/i);
  });

  it("returns UNLINKED receive-first only when inventory is truly missing", () => {
    const r = classifyRawBagStartFromInventoryContext(null);
    expect(r.operatorMessage).toBe(RAW_BAG_START_OPERATOR_MESSAGES.UNLINKED);
  });

  it("returns DEPLETED for EMPTIED inventory", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-4",
      inventoryStatus: "EMPTIED",
      sessions: [closed(0)],
      hasPartialPackagingWorkflow: true,
      hasActiveNonFinalizedWorkflow: false,
    });
    expect(r.status).toBe("DEPLETED");
    expect(r.canStart).toBe(false);
  });

  it("returns DEPLETED when all allocation sessions are DEPLETED", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-5",
      inventoryStatus: "AVAILABLE",
      sessions: [
        {
          allocationStatus: "DEPLETED",
          endingBalanceQty: 0,
          closedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      hasPartialPackagingWorkflow: true,
      hasActiveNonFinalizedWorkflow: false,
    });
    expect(r.status).toBe("DEPLETED");
  });

  it("returns ACTIVE_ELSEWHERE when a non-finalized workflow exists", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-6",
      inventoryStatus: "AVAILABLE",
      sessions: [],
      hasPartialPackagingWorkflow: false,
      hasActiveNonFinalizedWorkflow: true,
    });
    expect(r.status).toBe("ACTIVE_ELSEWHERE");
    expect(r.canStart).toBe(false);
  });

  it("returns FRESH_READY for linked AVAILABLE bag without partial workflow", () => {
    const r = classifyRawBagStartFromInventoryContext({
      inventoryBagId: "inv-7",
      inventoryStatus: "AVAILABLE",
      sessions: [],
      hasPartialPackagingWorkflow: false,
      hasActiveNonFinalizedWorkflow: false,
    });
    expect(r.status).toBe("FRESH_READY");
    expect(r.canStart).toBe(true);
  });
});

describe("FLOOR-PARTIAL-BAG-START-RESOLUTION-1 · operator messages", () => {
  it("Needs review message does not claim bag is unlinked", () => {
    expect(RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_NEEDS_REVIEW).toMatch(
      /inventory review/i,
    );
    expect(RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_NEEDS_REVIEW).not.toMatch(
      /not been linked/i,
    );
  });
});
