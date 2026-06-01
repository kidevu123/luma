import { describe, it, expect } from "vitest";
import {
  analyzeCorrectionOptions,
  bag45SegmentSumFromMaterial,
  buildPhase2DryRunProposal,
  PHASE2_COUNTS,
  PHASE2_IDS,
  recommendCorrectionOption,
  validatePhase2Guards,
  assertPhase2ReadOnlyScript,
  type Phase2DbSnapshot,
} from "./bag45-phase2-pvc-timeline-dry-run";

const baseSnap: Phase2DbSnapshot = {
  bag45: {
    workflowEvents: [],
    materialEvents: [
      {
        id: "1",
        rollNumber: "Legacy PVC-02",
        lotId: PHASE2_IDS.legacyPvc02,
        eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
        occurredAt: "2026-05-30T22:00:00Z",
        segmentCount: 187,
        segmentReason: "SHIFT_END_SNAPSHOT",
        segmentGroupId: null,
        bagTotalAfter: 187,
        rollTotalAfter: null,
      },
      {
        id: "2",
        rollNumber: "Legacy PVC-02",
        lotId: PHASE2_IDS.legacyPvc02,
        eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
        occurredAt: "2026-06-01T11:16:00Z",
        segmentCount: 18,
        segmentReason: "PAUSE_SNAPSHOT",
        segmentGroupId: null,
        bagTotalAfter: 205,
        rollTotalAfter: null,
      },
    ],
    stage: "STARTED",
    segmentSumOnPvc: 205,
    has516: false,
    pvc1EventCount: 0,
  },
  bag24: {
    workflowEvents: [
      {
        eventType: "BLISTER_COMPLETE",
        occurredAt: "2026-06-01T21:01:31Z",
        reason: null,
        counterSnapshot: null,
        countTotal: 359,
      },
    ],
    materialEvents: [
      {
        id: "756",
        rollNumber: "Legacy PVC-02",
        lotId: PHASE2_IDS.legacyPvc02,
        eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
        occurredAt: "2026-06-01T20:33:21Z",
        segmentCount: 645,
        segmentReason: "ROLL_CHANGE",
        segmentGroupId: PHASE2_IDS.bag24RollChangeGroupId,
        bagTotalAfter: 1290,
        rollTotalAfter: 3244,
      },
      {
        id: "760",
        rollNumber: "PVC-2",
        lotId: PHASE2_IDS.pvc2,
        eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
        occurredAt: "2026-06-01T21:01:31Z",
        segmentCount: 359,
        segmentReason: "BAG_COMPLETE",
        segmentGroupId: null,
        bagTotalAfter: 1649,
        rollTotalAfter: 359,
      },
    ],
    rollChange645OnLegacyPvc02: true,
    rollChange645OnPvc1: false,
    has359Complete: true,
  },
  rolls: [
    {
      rollNumber: "Legacy PVC-02",
      lotId: PHASE2_IDS.legacyPvc02,
      status: "DEPLETED",
      segmentSum: 3449,
      maxRollTotal: 3449,
    },
    {
      rollNumber: "PVC-1",
      lotId: PHASE2_IDS.pvc1,
      status: "AVAILABLE",
      segmentSum: 0,
      maxRollTotal: null,
    },
    {
      rollNumber: "PVC-2",
      lotId: PHASE2_IDS.pvc2,
      status: "IN_USE",
      segmentSum: 359,
      maxRollTotal: 359,
    },
    {
      rollNumber: "Legacy FOIL-01",
      lotId: PHASE2_IDS.legacyFoil01,
      status: "IN_USE",
      segmentSum: 6655,
      maxRollTotal: 6655,
    },
  ],
  activeMounted: [
    { rollNumber: "Legacy FOIL-01", status: "IN_USE" },
    { rollNumber: "PVC-2", status: "IN_USE" },
  ],
};

describe("Bag 45 Phase 2 PVC timeline dry-run helpers", () => {
  it("Bag 45 516 belongs to Legacy PVC-02 proposal, not PVC-1", () => {
    const proposal = buildPhase2DryRunProposal(baseSnap);
    const pvc516 = proposal.bag45.materialEventsToAppend.find(
      (e) => e.segmentCount === 516 && e.lotId === PHASE2_IDS.legacyPvc02,
    );
    expect(pvc516).toBeDefined();
    expect(
      proposal.bag45.materialEventsToAppend.some(
        (e) => e.lotId === PHASE2_IDS.pvc1 && e.segmentCount === 516,
      ),
    ).toBe(false);
    const mountPvc1 = proposal.bag45.materialEventsToAppend.find(
      (e) => e.lotId === PHASE2_IDS.pvc1 && e.eventType === "ROLL_MOUNTED",
    );
    expect(mountPvc1).toBeDefined();
  });

  it("Bag 24 645 should belong to PVC-1 after correction, not Legacy PVC-02", () => {
    const proposal = buildPhase2DryRunProposal(baseSnap);
    expect(proposal.bag24.roll645Before.pvcLot).toBe(PHASE2_IDS.legacyPvc02);
    expect(proposal.bag24.roll645After.pvcLot).toBe(PHASE2_IDS.pvc1);
  });

  it("PVC-2 does not receive prior 645 segment in proposal", () => {
    const proposal = buildPhase2DryRunProposal(baseSnap);
    expect(proposal.bag45.rollDeltas["PVC-2"]).toBe(0);
    expect(proposal.rollsAfterBoth["PVC-2"]?.before).toBe(359);
    expect(proposal.rollsAfterBoth["PVC-2"]?.after).toBe(359);
    expect(proposal.bag24.untouched).toContain("PVC-2 359 BAG_COMPLETE segment");
  });

  it("duplicate 516 detection blocks", () => {
    const blocked = validatePhase2Guards({
      ...baseSnap,
      bag45: { ...baseSnap.bag45, has516: true },
    });
    expect(blocked.some((b) => b.includes("516"))).toBe(true);
  });

  it("Bag 24 359 remains untouched in proposal", () => {
    const proposal = buildPhase2DryRunProposal(baseSnap);
    expect(proposal.bag24.blister359Untouched).toBe(true);
    expect(proposal.bag24.untouched.some((u) => u.includes("359"))).toBe(true);
  });

  it("recommends Option E when append-only correction unsupported", () => {
    expect(recommendCorrectionOption()).toBe("E");
    const b = analyzeCorrectionOptions().find((o) => o.id === "B");
    expect(b?.feasible).toBe(false);
  });

  it("no write path in dry-run script module", () => {
    assertPhase2ReadOnlyScript(false);
    expect(() => assertPhase2ReadOnlyScript(true)).toThrow(/write paths/);
  });

  it("bag45 segment sum from PVC rows", () => {
    expect(bag45SegmentSumFromMaterial(baseSnap.bag45.materialEvents)).toBe(205);
    const proposal = buildPhase2DryRunProposal(baseSnap);
    expect(proposal.bag45.bagSegmentTotalAfter).toBe(
      PHASE2_COUNTS.bag45Phase1Total + PHASE2_COUNTS.bag45PvcChange,
    );
  });
});
