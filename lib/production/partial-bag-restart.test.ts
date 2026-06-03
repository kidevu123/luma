import { describe, it, expect } from "vitest";
import {
  canRestartAvailablePartialRawBag,
  canResumeFinalizedWorkflowOnInventoryBag,
} from "./partial-bag-restart";
import type { PartialBagSession } from "./partial-bags";

const closedPartial: PartialBagSession = {
  allocationStatus: "CLOSED",
  endingBalanceQty: 5000,
  closedAt: new Date("2026-05-01"),
};

const closedEmpty: PartialBagSession = {
  allocationStatus: "CLOSED",
  endingBalanceQty: 0,
  closedAt: new Date("2026-05-01"),
};

describe("canRestartAvailablePartialRawBag", () => {
  it("true for AVAILABLE bag with closed partial session", () => {
    expect(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "AVAILABLE",
        sessions: [closedPartial],
      }),
    ).toBe(true);
  });

  it("false when inventory is not AVAILABLE", () => {
    expect(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "IN_USE",
        sessions: [closedPartial],
      }),
    ).toBe(false);
  });

  it("false when OPEN session exists", () => {
    expect(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "AVAILABLE",
        sessions: [
          closedPartial,
          { allocationStatus: "OPEN", endingBalanceQty: null, closedAt: null },
        ],
      }),
    ).toBe(false);
  });

  it("false for fresh bag with no sessions", () => {
    expect(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "AVAILABLE",
        sessions: [],
      }),
    ).toBe(false);
  });
});

describe("canResumeFinalizedWorkflowOnInventoryBag", () => {
  it("true for AVAILABLE partial bag", () => {
    expect(
      canResumeFinalizedWorkflowOnInventoryBag({
        inventoryStatus: "AVAILABLE",
        sessions: [closedPartial],
      }),
    ).toBe(true);
  });

  it("true for IN_USE with partial ending balance before status flips", () => {
    expect(
      canResumeFinalizedWorkflowOnInventoryBag({
        inventoryStatus: "IN_USE",
        sessions: [closedPartial],
      }),
    ).toBe(true);
  });

  it("false when depleted (zero ending balance only)", () => {
    expect(
      canResumeFinalizedWorkflowOnInventoryBag({
        inventoryStatus: "AVAILABLE",
        sessions: [closedEmpty],
      }),
    ).toBe(false);
  });
});
