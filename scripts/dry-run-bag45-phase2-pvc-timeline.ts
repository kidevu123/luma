#!/usr/bin/env npx tsx
/**
 * P0 Phase 2 — Bag 45 / Bag 24 PVC timeline DRY-RUN ONLY.
 *
 * Usage:
 *   npx tsx scripts/dry-run-bag45-phase2-pvc-timeline.ts
 *   npx tsx scripts/dry-run-bag45-phase2-pvc-timeline.ts --json
 *
 * No --apply. No DB writes. No projector rebuild.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  analyzeCorrectionOptions,
  bag45SegmentSumFromMaterial,
  buildPhase2DryRunProposal,
  PHASE2_COUNTS,
  PHASE2_IDS,
  recommendCorrectionOption,
  validatePhase2Guards,
  type MaterialRow,
  type Phase2DbSnapshot,
  type RollSnapshot,
  type WorkflowRow,
} from "@/lib/ops/bag45-phase2-pvc-timeline-dry-run";

async function loadSnapshot(): Promise<Phase2DbSnapshot> {
  type WeRow = {
    workflow_bag_id: string;
    event_type: string;
    occurred_at: string;
    reason: string | null;
    counter_snapshot: number | null;
    count_total: number | null;
  };
  const workflowRows = (await db.execute<WeRow>(sql`
    SELECT workflow_bag_id::text,
           event_type,
           occurred_at::text,
           payload->>'reason' AS reason,
           (payload->>'counter_snapshot_count')::int AS counter_snapshot,
           (payload->>'count_total')::int AS count_total
    FROM workflow_events
    WHERE workflow_bag_id IN (
      ${PHASE2_IDS.bag45WorkflowBagId}::uuid,
      ${PHASE2_IDS.bag24WorkflowBagId}::uuid
    )
    ORDER BY occurred_at, id
  `)) as unknown as WeRow[];

  type MatRow = {
    workflow_bag_id: string;
    id: string;
    roll_number: string;
    lot_id: string;
    event_type: string;
    occurred_at: string;
    segment_count: number | null;
    segment_reason: string | null;
    segment_group_id: string | null;
    bag_total: number | null;
    roll_total: number | null;
  };
  const matRows = (await db.execute<MatRow>(sql`
    SELECT mie.workflow_bag_id::text,
           mie.id::text,
           pl.roll_number,
           mie.packaging_lot_id::text AS lot_id,
           mie.event_type,
           mie.occurred_at::text,
           (mie.payload->>'counter_segment_count')::int AS segment_count,
           mie.payload->>'segment_reason' AS segment_reason,
           mie.payload->>'segment_group_id' AS segment_group_id,
           (mie.payload->>'active_bag_total_after_segment')::int AS bag_total,
           (mie.payload->>'roll_total_after_segment')::int AS roll_total
    FROM material_inventory_events mie
    JOIN packaging_lots pl ON pl.id = mie.packaging_lot_id
    WHERE mie.workflow_bag_id IN (
      ${PHASE2_IDS.bag45WorkflowBagId}::uuid,
      ${PHASE2_IDS.bag24WorkflowBagId}::uuid
    )
       OR (mie.payload->>'workflow_bag_id')::uuid IN (
      ${PHASE2_IDS.bag45WorkflowBagId}::uuid,
      ${PHASE2_IDS.bag24WorkflowBagId}::uuid
    )
    ORDER BY mie.occurred_at, mie.id
  `)) as unknown as MatRow[];

  const mapWe = (rows: WeRow[]): WorkflowRow[] =>
    rows.map((r) => ({
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      reason: r.reason,
      counterSnapshot: r.counter_snapshot,
      countTotal: r.count_total,
    }));

  const mapMat = (rows: MatRow[]): MaterialRow[] =>
    rows.map((r) => ({
      id: r.id,
      rollNumber: r.roll_number,
      lotId: r.lot_id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      segmentCount: r.segment_count,
      segmentReason: r.segment_reason,
      segmentGroupId: r.segment_group_id,
      bagTotalAfter: r.bag_total,
      rollTotalAfter: r.roll_total,
    }));

  const bag45We = workflowRows.filter(
    (r) => r.workflow_bag_id === PHASE2_IDS.bag45WorkflowBagId,
  );
  const bag24We = workflowRows.filter(
    (r) => r.workflow_bag_id === PHASE2_IDS.bag24WorkflowBagId,
  );
  const bag45Mat = mapMat(
    matRows.filter((r) => r.workflow_bag_id === PHASE2_IDS.bag45WorkflowBagId),
  );
  const bag24Mat = mapMat(
    matRows.filter((r) => r.workflow_bag_id === PHASE2_IDS.bag24WorkflowBagId),
  );

  type RbsRow = { stage: string };
  const [rbs] = (await db.execute<RbsRow>(sql`
    SELECT stage::text FROM read_bag_state
    WHERE workflow_bag_id = ${PHASE2_IDS.bag45WorkflowBagId}::uuid
  `)) as unknown as RbsRow[];

  type RollRow = {
    roll_number: string;
    lot_id: string;
    status: string;
    seg_sum: number;
    max_roll_total: number | null;
  };
  const rolls = (await db.execute<RollRow>(sql`
    SELECT pl.roll_number, pl.id::text AS lot_id, pl.status::text,
      COALESCE(SUM((ev.payload->>'counter_segment_count')::int)
        FILTER (WHERE ev.event_type='ROLL_COUNTER_SEGMENT_RECORDED'),0)::int AS seg_sum,
      MAX((ev.payload->>'roll_total_after_segment')::int)
        FILTER (WHERE ev.event_type='ROLL_COUNTER_SEGMENT_RECORDED') AS max_roll_total
    FROM packaging_lots pl
    LEFT JOIN material_inventory_events ev ON ev.packaging_lot_id = pl.id
    WHERE pl.id IN (
      ${PHASE2_IDS.legacyPvc02}::uuid, ${PHASE2_IDS.pvc1}::uuid,
      ${PHASE2_IDS.pvc2}::uuid, ${PHASE2_IDS.legacyFoil01}::uuid
    )
    GROUP BY pl.roll_number, pl.id, pl.status
    ORDER BY pl.roll_number
  `)) as unknown as RollRow[];

  type MountRow = { roll_number: string; status: string };
  const active = (await db.execute<MountRow>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id, ev.event_type, ev.machine_id
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_DEPLETED')
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT pl.roll_number, pl.status::text
    FROM packaging_lots pl
    JOIN latest_event le ON le.packaging_lot_id = pl.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND le.machine_id = ${PHASE2_IDS.blisterMachineId}::uuid
  `)) as unknown as MountRow[];

  const seg516 = bag45Mat.some((r) => r.segmentCount === PHASE2_COUNTS.bag45PvcChange);
  const pvc1Bag45 = bag45Mat.filter((r) => r.lotId === PHASE2_IDS.pvc1).length;

  const bag24Pvc645Legacy = bag24Mat.some(
    (r) =>
      r.lotId === PHASE2_IDS.legacyPvc02 &&
      r.segmentCount === PHASE2_COUNTS.bag24RollChange &&
      r.segmentReason === "ROLL_CHANGE",
  );
  const bag24Pvc645Pvc1 = bag24Mat.some(
    (r) =>
      r.lotId === PHASE2_IDS.pvc1 &&
      r.segmentCount === PHASE2_COUNTS.bag24RollChange,
  );

  return {
    bag45: {
      workflowEvents: mapWe(bag45We),
      materialEvents: bag45Mat,
      stage: rbs?.stage ?? null,
      segmentSumOnPvc: bag45SegmentSumFromMaterial(bag45Mat),
      has516: seg516,
      pvc1EventCount: pvc1Bag45,
    },
    bag24: {
      workflowEvents: mapWe(bag24We),
      materialEvents: bag24Mat,
      rollChange645OnLegacyPvc02: bag24Pvc645Legacy,
      rollChange645OnPvc1: bag24Pvc645Pvc1,
      has359Complete: bag24We.some(
        (r) =>
          r.event_type === "BLISTER_COMPLETE" &&
          r.count_total === PHASE2_COUNTS.bag24BlisterComplete,
      ),
    },
    rolls: rolls.map(
      (r): RollSnapshot => ({
        rollNumber: r.roll_number,
        lotId: r.lot_id,
        status: r.status,
        segmentSum: r.seg_sum,
        maxRollTotal: r.max_roll_total,
      }),
    ),
    activeMounted: active.map((r) => ({
      rollNumber: r.roll_number,
      status: r.status,
    })),
  };
}

function printSnapshot(snap: Phase2DbSnapshot): void {
  console.log("=== CURRENT DB SNAPSHOT (read-only) ===\n");
  console.log("Bag 45 workflow:", snap.bag45.workflowEvents);
  console.log("Bag 45 material:", snap.bag45.materialEvents);
  console.log("Bag 45 stage:", snap.bag45.stage, "PVC seg sum:", snap.bag45.segmentSumOnPvc);
  console.log("\nBag 24 workflow:", snap.bag24.workflowEvents);
  console.log("Bag 24 material:", snap.bag24.materialEvents);
  console.log("\nRolls:", snap.rolls);
  console.log("Active mounted:", snap.activeMounted);
}

function printProposal(proposal: ReturnType<typeof buildPhase2DryRunProposal>): void {
  console.log("\n=== PHASE 2 DRY-RUN PROPOSAL (no writes) ===\n");
  console.log("Bag 45 workflow append:", proposal.bag45.workflowEventsToAppend);
  console.log("Bag 45 material append:", proposal.bag45.materialEventsToAppend);
  console.log(
    "Bag 45 totals:",
    proposal.bag45.bagSegmentTotalBefore,
    "->",
    proposal.bag45.bagSegmentTotalAfter,
  );
  console.log("Bag 45 roll deltas:", proposal.bag45.rollDeltas);
  console.log("\nBag 24 untouched:", proposal.bag24.untouched);
  console.log("Bag 24 correction required:", proposal.bag24.correctionRequired);
  console.log("645 before:", proposal.bag24.roll645Before);
  console.log("645 after:", proposal.bag24.roll645After);
  console.log("359 untouched:", proposal.bag24.blister359Untouched);
  console.log("\nRoll totals after both corrections:", proposal.rollsAfterBoth);
  console.log("Audit proposed:", proposal.auditRowsProposed);
  console.log("Projector rebuild:", proposal.projectorRebuild);
  console.log("Schema gap:", proposal.schemaGap);
}

async function main() {
  const jsonOut = process.argv.includes("--json");
  const snap = await loadSnapshot();
  const blockers = validatePhase2Guards(snap);
  const options = analyzeCorrectionOptions();
  const recommended = recommendCorrectionOption(options);
  const proposal = buildPhase2DryRunProposal(snap);

  if (jsonOut) {
    console.log(
      JSON.stringify({ snap, blockers, options, recommended, proposal }, null, 2),
    );
    return;
  }

  printSnapshot(snap);
  console.log("\n=== CORRECTION OPTIONS ===");
  for (const o of options) {
    console.log(`  ${o.id}: feasible=${o.feasible} — ${o.summary}`);
    console.log(`     risk: ${o.risk}`);
  }
  console.log("\nRecommended:", recommended);
  if (blockers.length) console.log("\nBlockers:", blockers);
  printProposal(proposal);
  console.log("\n*** DRY RUN ONLY — no apply path in this script ***");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
