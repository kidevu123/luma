import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planMaterialChangeRecovery,
  type MaterialChangeRecoveryContext,
  type MaterialChangeRecoveryInput,
} from "./material-change-recovery";

const BASE_INPUT: MaterialChangeRecoveryInput = {
  workflowBagId: "bag-1",
  stationId: "station-blister",
  eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
  oldRollLotId: "pvc-old",
  newRollLotId: "pvc-new",
  segmentCount: 516,
  materialRole: "PVC",
  reason: "historical_backfill",
  oldRollEndState: "removed_partial",
  requestedByUserId: "admin-1",
  endingWeightGrams: 1200,
};

const BASE_CONTEXT: MaterialChangeRecoveryContext = {
  workflowBag: {
    id: "bag-1",
    finalizedAt: null,
    finishedLotIds: [],
    lineageState: "HIGH",
  },
  station: {
    id: "station-blister",
    machineId: "machine-blister",
  },
  rolls: [
    {
      lotId: "pvc-old",
      rollNumber: "Legacy PVC-02",
      role: "PVC",
      status: "IN_USE",
      activeAtBoundary: true,
      stationId: "station-blister",
      machineId: "machine-blister",
      segmentTotal: 205,
    },
    {
      lotId: "foil-active",
      rollNumber: "Legacy FOIL-01",
      role: "FOIL",
      status: "IN_USE",
      activeAtBoundary: true,
      stationId: "station-blister",
      machineId: "machine-blister",
      segmentTotal: 205,
    },
    {
      lotId: "pvc-new",
      rollNumber: "PVC-1",
      role: "PVC",
      status: "AVAILABLE",
      activeAtBoundary: false,
      segmentTotal: 0,
    },
  ],
  activeRollsAtBoundary: [
    {
      lotId: "pvc-old",
      rollNumber: "Legacy PVC-02",
      role: "PVC",
      status: "IN_USE",
      activeAtBoundary: true,
      stationId: "station-blister",
      machineId: "machine-blister",
      segmentTotal: 205,
    },
    {
      lotId: "foil-active",
      rollNumber: "Legacy FOIL-01",
      role: "FOIL",
      status: "IN_USE",
      activeAtBoundary: true,
      stationId: "station-blister",
      machineId: "machine-blister",
      segmentTotal: 205,
    },
  ],
  existingSegments: [],
  boundaryWorkflowEventId: "event-boundary",
};

function plan(
  input: Partial<MaterialChangeRecoveryInput> = {},
  context: Partial<MaterialChangeRecoveryContext> = {},
) {
  return planMaterialChangeRecovery(
    { ...BASE_INPUT, ...input },
    { ...BASE_CONTEXT, ...context },
  );
}

describe("MATERIAL-CHANGE-RECOVERY-DRY-RUN-1 · planner", () => {
  it("plans partial old-roll removal without assigning prior count to replacement", () => {
    const result = plan();

    expect(result.eligibility).toBe("WARNING");
    expect(result.blockers).toEqual([]);
    expect(result.afterStatePreview.expectedOldRollStatus).toBe("AVAILABLE");
    expect(result.afterStatePreview.expectedNewRollStatus).toBe("IN_USE");
    expect(result.afterStatePreview.segmentAttribution.oldRoll).toEqual({
      lotId: "pvc-old",
      count: 516,
    });
    expect(result.afterStatePreview.segmentAttribution.pairedRoll).toEqual({
      lotId: "foil-active",
      count: 516,
    });
    expect(result.afterStatePreview.segmentAttribution.replacementRoll).toEqual({
      lotId: "pvc-new",
      count: 0,
    });
    const replacementSegments = result.proposedEvents.filter(
      (event) =>
        event.eventType === "ROLL_COUNTER_SEGMENT_RECORDED" &&
        event.packagingLotId === "pvc-new",
    );
    expect(replacementSegments).toHaveLength(0);
    expect(result.proposedEvents.map((event) => event.eventType)).toEqual([
      "ROLL_COUNTER_SEGMENT_RECORDED",
      "ROLL_COUNTER_SEGMENT_RECORDED",
      "ROLL_UNMOUNTED",
      "ROLL_MOUNTED",
    ]);
  });

  it("plans depleted old-roll preview when selected", () => {
    const result = plan({
      oldRollEndState: "depleted",
      endingWeightGrams: null,
    });

    expect(result.eligibility).toBe("WARNING");
    expect(result.afterStatePreview.expectedOldRollStatus).toBe("DEPLETED");
    expect(result.proposedEvents.map((event) => event.eventType)).toContain(
      "ROLL_DEPLETED",
    );
  });

  it("blocks missing reason", () => {
    const result = plan({ reason: "" });

    expect(result.eligibility).toBe("BLOCKED");
    expect(result.blockers.map((b) => b.code)).toContain("MISSING_REASON");
    expect(result.proposedEvents).toEqual([]);
  });

  it("blocks when old and new roll are the same", () => {
    const result = plan({ newRollLotId: "pvc-old" });

    expect(result.eligibility).toBe("BLOCKED");
    expect(result.blockers.map((b) => b.code)).toContain("SAME_OLD_NEW_ROLL");
  });

  it("blocks negative and nonnumeric segment counts", () => {
    expect(plan({ segmentCount: -1 }).blockers.map((b) => b.code)).toContain(
      "INVALID_SEGMENT_COUNT",
    );
    expect(plan({ segmentCount: "abc" }).blockers.map((b) => b.code)).toContain(
      "INVALID_SEGMENT_COUNT",
    );
  });

  it("blocks counter reversal without explicit policy", () => {
    const result = plan({
      segmentCount: 10,
      minimumExpectedSegmentCount: 20,
      allowCounterReversal: false,
    });

    expect(result.blockers.map((b) => b.code)).toContain(
      "COUNTER_REVERSAL_UNSUPPORTED",
    );
  });

  it("blocks when the old roll is not active at the boundary", () => {
    const result = plan(
      {},
      {
        activeRollsAtBoundary: BASE_CONTEXT.activeRollsAtBoundary.filter(
          (roll) => roll.lotId !== "pvc-old",
        ),
      },
    );

    expect(result.blockers.map((b) => b.code)).toContain(
      "OLD_ROLL_NOT_ACTIVE_AT_BOUNDARY",
    );
  });

  it("blocks when replacement roll is already active", () => {
    const result = plan(
      {},
      {
        rolls: BASE_CONTEXT.rolls.map((roll) =>
          roll.lotId === "pvc-new"
            ? { ...roll, status: "IN_USE", activeAtBoundary: true }
            : roll,
        ),
      },
    );

    expect(result.blockers.map((b) => b.code)).toContain(
      "NEW_ROLL_ACTIVE_CONFLICT",
    );
  });

  it("blocks ambiguous active paired rolls", () => {
    const result = plan(
      {},
      {
        activeRollsAtBoundary: [
          ...BASE_CONTEXT.activeRollsAtBoundary,
          {
            lotId: "foil-second",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
          },
        ],
      },
    );

    expect(result.blockers.map((b) => b.code)).toContain(
      "AMBIGUOUS_ACTIVE_ROLLS",
    );
  });

  it("blocks equivalent existing segment to prevent double-counting", () => {
    const result = plan(
      {},
      {
        existingSegments: [
          {
            workflowBagId: "bag-1",
            packagingLotId: "pvc-old",
            role: "PVC",
            segmentCount: 516,
            oldLotId: "pvc-old",
            newLotId: "pvc-new",
          },
        ],
      },
    );

    expect(result.blockers.map((b) => b.code)).toContain("DUPLICATE_SEGMENT_RISK");
  });

  it("blocks finalized bags", () => {
    const result = plan(
      {},
      {
        workflowBag: {
          ...BASE_CONTEXT.workflowBag!,
          finalizedAt: "2026-06-02T16:00:00.000Z",
        },
      },
    );

    expect(result.blockers.map((b) => b.code)).toContain("FINALIZED_BAG_BOUNDARY");
  });

  it("blocks finished-lot boundary for now", () => {
    const result = plan(
      {},
      {
        workflowBag: {
          ...BASE_CONTEXT.workflowBag!,
          finishedLotIds: ["finished-lot-1"],
        },
      },
    );

    expect(result.blockers.map((b) => b.code)).toContain("FINISHED_LOT_BOUNDARY");
  });

  it("warns when ending weight is missing for partial recovery", () => {
    const result = plan({ endingWeightGrams: null });

    expect(result.eligibility).toBe("WARNING");
    expect(result.warnings.map((w) => w.code)).toContain(
      "ENDING_WEIGHT_MISSING_FOR_PARTIAL",
    );
  });

  it("warns honestly for legacy or incomplete lineage", () => {
    const result = plan(
      {},
      {
        workflowBag: {
          ...BASE_CONTEXT.workflowBag!,
          isLegacy: true,
          lineageState: "LOW",
        },
      },
    );

    expect(result.warnings.map((w) => w.code)).toContain(
      "LEGACY_OR_INCOMPLETE_LINEAGE",
    );
  });

  it("warns when boundary cannot be tied cleanly to a known workflow event", () => {
    const result = plan({}, { boundaryWorkflowEventId: null });

    expect(result.warnings.map((w) => w.code)).toContain("BOUNDARY_EVENT_NOT_LINKED");
  });

  it("marks all proposed events as preview-only and not persisted", () => {
    const result = plan();

    expect(result.proposedEvents.length).toBeGreaterThan(0);
    expect(result.proposedEvents.every((event) => event.previewOnly)).toBe(true);
    expect(result.proposedEvents.every((event) => event.willPersist === false)).toBe(
      true,
    );
  });

  it("lists affected read models including roll usage and material lot state", () => {
    const result = plan();

    expect(result.affectedReadModels).toContain("read_roll_usage");
    expect(result.affectedReadModels).toContain("read_material_lot_state");
    expect(result.affectedReadModels).toContain("finished_lot_packaging_genealogy");
  });

  it("Bag 45-style fixture produces a clear dry-run preview", () => {
    const result = plan({
      segmentCount: 516,
      reason: "historical_backfill",
      oldRollEndState: "depleted",
      endingWeightGrams: null,
    });

    expect(result.eligibility).toBe("WARNING");
    expect(result.proposedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
          packagingLotId: "pvc-old",
          counterSegmentCount: 516,
          previewOnly: true,
        }),
        expect.objectContaining({
          eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
          packagingLotId: "foil-active",
          counterSegmentCount: 516,
          previewOnly: true,
        }),
        expect.objectContaining({
          eventType: "ROLL_DEPLETED",
          packagingLotId: "pvc-old",
          previewOnly: true,
        }),
        expect.objectContaining({
          eventType: "ROLL_MOUNTED",
          packagingLotId: "pvc-new",
          previewOnly: true,
        }),
      ]),
    );
  });
});

describe("MATERIAL-CHANGE-RECOVERY-DRY-RUN-1 · mutation guards", () => {
  const src = readFileSync(join(__dirname, "material-change-recovery.ts"), "utf8");

  it("does not import DB, schema, projector, or server action modules", () => {
    expect(src).not.toMatch(/@\/lib\/db/);
    expect(src).not.toMatch(/@\/lib\/projector/);
    expect(src).not.toMatch(/projectEvent/);
    expect(src).not.toMatch(/writeAudit/);
    expect(src).not.toMatch(/"use server"/);
  });

  it("does not expose direct mutation helper names", () => {
    expect(src).not.toMatch(/applyMaterialChangeRecovery/);
    expect(src).not.toMatch(/confirmMaterialChangeRecovery/);
    expect(src).not.toMatch(/insert\(/);
    expect(src).not.toMatch(/update\(/);
    expect(src).not.toMatch(/delete\(/);
  });
});
