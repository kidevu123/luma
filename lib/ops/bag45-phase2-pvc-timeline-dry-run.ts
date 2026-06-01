/**
 * P0 Phase 2 — Bag 45 / Bag 24 PVC timeline dry-run (read-only).
 * No inserts, updates, deletes, or projector rebuilds.
 */

export const PHASE2_IDS = {
  bag45WorkflowBagId: "a8eeb5a8-ac95-45da-85d0-19ee766e2d3a",
  bag24WorkflowBagId: "008870c4-6f43-4862-862f-51f7b7ba6853",
  legacyPvc02: "2869ae2a-3b31-4e00-a684-dcc611c82d09",
  pvc1: "ecacd4a2-cbe5-406b-8b5e-a33b1e2a2f0e",
  pvc2: "d083d7c2-c138-48fa-a356-150ecb594370",
  legacyFoil01: "0ecd1290-b54d-438d-961b-e794db03fa67",
  bag24RollChangeGroupId: "cd1d0ac3-f271-4ebb-8acf-ba613ac40d42",
  blisterStationId: "12492e4b-dac7-46fb-b860-b7ea483fbd9e",
  blisterMachineId: "c65ea16e-7e15-4749-888b-a7b058cfdf53",
} as const;

export const PHASE2_COUNTS = {
  bag45Phase1Total: 205,
  bag45PvcChange: 516,
  bag24RollChange: 645,
  bag24BlisterComplete: 359,
} as const;

export const BAG45_PVC_CHANGE_AT_ISO = "2026-06-01T17:23:00.000Z";

export type RollSnapshot = {
  rollNumber: string;
  lotId: string;
  status: string;
  segmentSum: number;
  maxRollTotal: number | null;
};

export type MaterialRow = {
  id: string;
  rollNumber: string;
  lotId: string;
  eventType: string;
  occurredAt: string;
  segmentCount: number | null;
  segmentReason: string | null;
  segmentGroupId: string | null;
  bagTotalAfter: number | null;
  rollTotalAfter: number | null;
};

export type WorkflowRow = {
  eventType: string;
  occurredAt: string;
  reason: string | null;
  counterSnapshot: number | null;
  countTotal: number | null;
};

export type Phase2DbSnapshot = {
  bag45: {
    workflowEvents: WorkflowRow[];
    materialEvents: MaterialRow[];
    stage: string | null;
    segmentSumOnPvc: number;
    has516: boolean;
    pvc1EventCount: number;
  };
  bag24: {
    workflowEvents: WorkflowRow[];
    materialEvents: MaterialRow[];
    rollChange645OnLegacyPvc02: boolean;
    rollChange645OnPvc1: boolean;
    has359Complete: boolean;
  };
  rolls: RollSnapshot[];
  activeMounted: Array<{ rollNumber: string; status: string }>;
};

export type Phase2Proposal = {
  bag45: {
    workflowEventsToAppend: Array<{ eventType: string; occurredAt: string; note: string }>;
    materialEventsToAppend: Array<{
      rollNumber: string;
      lotId: string;
      eventType: string;
      segmentCount: number | null;
      segmentReason: string | null;
      note: string;
    }>;
    bagSegmentTotalBefore: number;
    bagSegmentTotalAfter: number;
    rollDeltas: Record<string, number>;
  };
  bag24: {
    untouched: string[];
    correctionRequired: string[];
    roll645Before: { pvcLot: string; pvcRoll: string; auditOldLot: string };
    roll645After: { pvcLot: string; pvcRoll: string };
    blister359Untouched: boolean;
  };
  rollsAfterBoth: Record<string, { before: number; after: number; statusNote: string }>;
  auditRowsProposed: string[];
  projectorRebuild: {
    required: boolean;
    scope: "full_roll_usage" | "scoped_replay" | "none";
    reason: string;
  };
  schemaGap: string | null;
};

export type CorrectionOptionId = "A" | "B" | "C" | "D" | "E";

export type CorrectionOptionAnalysis = {
  id: CorrectionOptionId;
  summary: string;
  feasible: boolean;
  risk: string;
};

export function bag45SegmentSumFromMaterial(rows: MaterialRow[]): number {
  const pvcRows = rows.filter(
    (r) =>
      r.lotId === PHASE2_IDS.legacyPvc02 &&
      r.eventType === "ROLL_COUNTER_SEGMENT_RECORDED",
  );
  return pvcRows.reduce((s, r) => s + (r.segmentCount ?? 0), 0);
}

export function analyzeCorrectionOptions(): CorrectionOptionAnalysis[] {
  return [
    {
      id: "A",
      summary:
        "Apply Bag 45 516 only; leave Bag 24 645 as Legacy PVC-02 → PVC-2.",
      feasible: false,
      risk:
        "Legacy PVC-02 already DEPLETED at Bag 24 645; backdated 516 depletion conflicts. PVC-1 never appears on 645. Roll genealogy permanently wrong.",
    },
    {
      id: "B",
      summary:
        "Append offset/correction events for Bag 24 645 without editing originals.",
      feasible: false,
      risk:
        "No ROLL_COUNTER_SEGMENT void/supersede event type. MATERIAL_ESTIMATED_VOIDED is packaging-consumption only. rebuildRollUsage sums all segments — negative offset would need schema + projector support.",
    },
    {
      id: "C",
      summary: "Supersede segment group cd1d0ac3… with corrected PVC-1 → PVC-2 group.",
      feasible: false,
      risk:
        "No supersede flag on material_inventory_events. Projectors ignore correction metadata unless new event type + rebuild logic added.",
    },
    {
      id: "D",
      summary: "Direct payload edit: change Bag 24 PVC 645 lot from Legacy PVC-02 to PVC-1.",
      feasible: true,
      risk:
        "Breaks append-only audit. roll_total_after_segment and DEPLETED final_yield become inconsistent. Not acceptable for production traceability.",
    },
    {
      id: "E",
      summary:
        "Insert backdated Bag 45 516 + PVC-1 mount; replay/rebuild roll timeline; re-attribute Bag 24 645 to PVC-1 during replay.",
      feasible: true,
      risk:
        "Largest scope. Requires maintenance window, rebuildRollUsage + packaging_lot status replay, explicit Sahil approval. Safest honest genealogy if done in occurred_at order.",
    },
  ];
}

export function recommendCorrectionOption(
  options: CorrectionOptionAnalysis[] = analyzeCorrectionOptions(),
): CorrectionOptionId {
  return "E";
}

export function buildPhase2DryRunProposal(
  snap: Phase2DbSnapshot,
): Phase2Proposal {
  const bag45Before = snap.bag45.segmentSumOnPvc;
  const bag45After = bag45Before + PHASE2_COUNTS.bag45PvcChange;

  const legacyPvcBefore =
    snap.rolls.find((r) => r.lotId === PHASE2_IDS.legacyPvc02)?.segmentSum ?? 0;
  const pvc1Before = snap.rolls.find((r) => r.lotId === PHASE2_IDS.pvc1)?.segmentSum ?? 0;
  const pvc2Before = snap.rolls.find((r) => r.lotId === PHASE2_IDS.pvc2)?.segmentSum ?? 0;
  const foilBefore =
    snap.rolls.find((r) => r.lotId === PHASE2_IDS.legacyFoil01)?.segmentSum ?? 0;

  // After full correction: move Bag 24's 645 from Legacy PVC-02 to PVC-1 lifetime.
  const legacyPvcAfter =
    legacyPvcBefore + PHASE2_COUNTS.bag45PvcChange - PHASE2_COUNTS.bag24RollChange;
  const pvc1After = pvc1Before + PHASE2_COUNTS.bag24RollChange;
  const foilAfter =
    foilBefore + PHASE2_COUNTS.bag45PvcChange; // 516 on bag45 + 645 already on bag24 FOIL

  return {
    bag45: {
      workflowEventsToAppend: [
        {
          eventType: "BAG_PAUSED",
          occurredAt: BAG45_PVC_CHANGE_AT_ISO,
          note: "reason=pvc_swap, counter_snapshot_count=516 (optional UI parity)",
        },
        {
          eventType: "BAG_RESUMED",
          occurredAt: "2026-06-01T17:23:01.000Z",
          note: "resume after PVC change",
        },
      ],
      materialEventsToAppend: [
        {
          rollNumber: "Legacy PVC-02",
          lotId: PHASE2_IDS.legacyPvc02,
          eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
          segmentCount: PHASE2_COUNTS.bag45PvcChange,
          segmentReason: "ROLL_CHANGE",
          note: "516 closes Legacy PVC-02 segment on Bag 45; FOIL mirror row also required",
        },
        {
          rollNumber: "Legacy FOIL-01",
          lotId: PHASE2_IDS.legacyFoil01,
          eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
          segmentCount: PHASE2_COUNTS.bag45PvcChange,
          segmentReason: "ROLL_CHANGE",
          note: "FOIL receives 516 per changeRollAction model",
        },
        {
          rollNumber: "Legacy PVC-02",
          lotId: PHASE2_IDS.legacyPvc02,
          eventType: "ROLL_DEPLETED",
          segmentCount: null,
          segmentReason: null,
          note: "Deplete after 516; final_yield includes bag45 segments + 516",
        },
        {
          rollNumber: "PVC-1",
          lotId: PHASE2_IDS.pvc1,
          eventType: "ROLL_MOUNTED",
          segmentCount: null,
          segmentReason: null,
          note: "PVC-1 mounted after 516; does NOT receive 516 segment",
        },
      ],
      bagSegmentTotalBefore: bag45Before,
      bagSegmentTotalAfter: bag45After,
      rollDeltas: {
        "Legacy PVC-02": PHASE2_COUNTS.bag45PvcChange,
        "Legacy FOIL-01": PHASE2_COUNTS.bag45PvcChange,
        "PVC-1": 0,
        "PVC-2": 0,
      },
    },
    bag24: {
      untouched: [
        "BLISTER_COMPLETE count_total=359",
        "BAG_RELEASED",
        "FOIL 645 + 359 segments (lot unchanged)",
        "PVC-2 359 BAG_COMPLETE segment",
        "Original audit 380 row (historical record)",
      ],
      correctionRequired: [
        "645 PVC segment group cd1d0ac3…: re-attribute from Legacy PVC-02 to PVC-1",
        "ROLL_DEPLETED target: PVC-1 not Legacy PVC-02 at 16:33",
        "ROLL_MOUNTED PVC-2 remains but prior roll should be PVC-1",
      ],
      roll645Before: {
        pvcLot: PHASE2_IDS.legacyPvc02,
        pvcRoll: "Legacy PVC-02",
        auditOldLot: PHASE2_IDS.legacyPvc02,
      },
      roll645After: {
        pvcLot: PHASE2_IDS.pvc1,
        pvcRoll: "PVC-1",
      },
      blister359Untouched: snap.bag24.has359Complete,
    },
    rollsAfterBoth: {
      "Legacy PVC-02": {
        before: legacyPvcBefore,
        after: legacyPvcAfter,
        statusNote: "DEPLETED after Bag 45 516 (not after Bag 24 645)",
      },
      "PVC-1": {
        before: pvc1Before,
        after: pvc1After,
        statusNote: "IN_USE after Bag 45 516; DEPLETED after Bag 24 645",
      },
      "PVC-2": {
        before: pvc2Before,
        after: pvc2Before,
        statusNote: "IN_USE; unchanged — 359 BAG_COMPLETE only; 645 never belonged on PVC-2",
      },
      "Legacy FOIL-01": {
        before: foilBefore,
        after: foilAfter,
        statusNote: "+516 from Bag 45; 645+359 already on Bag 24",
      },
    },
    auditRowsProposed: [
      "live_ops_backfill.bag45_phase2_pvc_change_dry_run",
      "live_ops_backfill.bag24_roll645_attribution_correction_dry_run",
    ],
    projectorRebuild: {
      required: true,
      scope: "full_roll_usage",
      reason:
        "read_roll_usage sums all ROLL_COUNTER_SEGMENT_RECORDED; lot status (DEPLETED/IN_USE) must be replayed in occurred_at order after backdated inserts and Bag 24 correction.",
    },
    schemaGap:
      "No append-only ROLL_COUNTER_SEGMENT correction event type. Bag 24 fix requires Option E replay or new migration for correction events before apply.",
  };
}

export function assertPhase2ReadOnlyScript(hasWritePath: boolean): void {
  if (hasWritePath) {
    throw new Error("Phase 2 dry-run script must not include write paths");
  }
}

export function validatePhase2Guards(snap: Phase2DbSnapshot): string[] {
  const blockers: string[] = [];
  if (snap.bag45.has516) blockers.push("Bag 45 already has 516 segment");
  if (snap.bag45.pvc1EventCount > 0) blockers.push("PVC-1 already tied to Bag 45");
  if (!snap.bag24.rollChange645OnLegacyPvc02) {
    blockers.push("Expected Bag 24 645 on Legacy PVC-02 — state changed");
  }
  if (snap.bag24.rollChange645OnPvc1) {
    blockers.push("Bag 24 645 already on PVC-1 — correction may be done");
  }
  return blockers;
}
