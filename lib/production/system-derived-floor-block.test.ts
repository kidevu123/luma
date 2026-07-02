import { describe, it, expect, vi } from "vitest";

// The resolution module imports @/lib/db at top level; stub it so the pure
// builder can be imported without a real database.
vi.mock("@/lib/db", () => ({ db: {} }));

import { buildFloorOpenAllocationBlock } from "./system-derived-allocation-resolution";

describe("buildFloorOpenAllocationBlock — eligible", () => {
  const block = buildFloorOpenAllocationBlock({
    inventoryBagId: "inv-1",
    cardId: "card-1",
    resolution: {
      available: true,
      sessionId: "sess-1",
      workflowBagId: "wf-1",
      inventoryBagId: "inv-1",
      previousProductName: "Hyroxi Mit A - BlueRaz",
      eligible: true,
      startingTabletCount: 20000,
      derivedConsumedTablets: 12000,
      derivedRemainingTablets: 8000,
      outputStage: "SEALING",
      outputUnits: 3000,
      tabletsPerUnit: 4,
    },
  });

  it("uses the CAN_USE_CALCULATED_REMAINING blocker with the full calculation", () => {
    expect(block.blocker).toBe("OPEN_ALLOCATION_CAN_USE_CALCULATED_REMAINING");
    expect(block.eligible).toBe(true);
    expect(block.startingTabletCount).toBe(20000);
    expect(block.derivedConsumedTablets).toBe(12000);
    expect(block.derivedRemainingTablets).toBe(8000);
    expect(block.outputUnits).toBe(3000);
    expect(block.tabletsPerUnit).toBe(4);
    expect(block.outputStageLabel).toMatch(/sealing/);
    expect(block.previousProductName).toBe("Hyroxi Mit A - BlueRaz");
    expect(block.inventoryBagId).toBe("inv-1");
    expect(block.cardId).toBe("card-1");
  });
});

describe("buildFloorOpenAllocationBlock — ineligible", () => {
  it("uses NEEDS_MANUAL with the precise reason (no calc numbers)", () => {
    const block = buildFloorOpenAllocationBlock({
      inventoryBagId: "inv-2",
      cardId: null,
      resolution: {
        available: false,
        sessionId: "sess-2",
        workflowBagId: "wf-2",
        previousProductName: "Variety Pack",
        reason: "MISSING_TABLETS_PER_UNIT",
        message: "This product has no tablets-per-unit configured (e.g. a variety pack)…",
      },
    });
    expect(block.blocker).toBe("OPEN_ALLOCATION_NEEDS_MANUAL");
    expect(block.eligible).toBe(false);
    expect(block.reason).toBe("MISSING_TABLETS_PER_UNIT");
    expect(block.message).toMatch(/tablets-per-unit/i);
    expect(block.startingTabletCount).toBeUndefined();
    expect(block.derivedRemainingTablets).toBeUndefined();
  });
});
