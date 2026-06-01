/**
 * P0 Phase 2 — Bag 45 / Bag 24 PVC timeline maintenance apply (Option E).
 * Dry-run by default. Controlled updates to Bag 24 material rows are
 * audited and limited to this script.
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  materialInventoryEvents,
  packagingLots,
} from "@/lib/db/schema";
import {
  BAG45_PVC_CHANGE_AT_ISO,
  buildPhase2DryRunProposal,
  PHASE2_COUNTS,
  PHASE2_IDS,
  type MaterialRow,
  type Phase2DbSnapshot,
  type RollSnapshot,
  validatePhase2Guards,
  type WorkflowRow,
} from "@/lib/ops/bag45-phase2-pvc-timeline-dry-run";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";
import { projectEvent } from "@/lib/projector";
import type { AccountabilityForEvent } from "@/lib/production/station-operator-session";
import { withAccountabilityPayload } from "@/lib/production/station-operator-session";

export const PHASE2_CONFIRM_STRING = "APPLY_BAG45_PHASE2_PVC_TIMELINE" as const;

export const BAG24_ROLL_CHANGE_AT_ISO = "2026-06-01T20:33:21.000Z";

export const PHASE2_EXPECTED_TOTALS = {
  legacyPvc02: 3320,
  pvc1: 645,
  pvc2: 635,
  legacyFoil01Delta: 516,
} as const;

export const PHASE2_AUDIT_ACTIONS = {
  bag45: "live_ops_backfill.bag45_phase2_pvc_change",
  bag24: "live_ops_backfill.bag24_roll645_attribution_correction",
} as const;

/** Tables this script is allowed to mutate on apply. */
export const PHASE2_ALLOWED_WRITE_TABLES = [
  "workflow_events",
  "material_inventory_events",
  "packaging_lots",
  "audit_log",
  "read_roll_usage",
  "read_material_lot_state",
] as const;

export type Bag45Phase2CliOptions = {
  apply: boolean;
  confirm: string | null;
  auditReason: string | null;
  skipRebuild: boolean;
};

export type Bag24MaterialRow = MaterialRow & {
  packagingMaterialId: string;
  payload: Record<string, unknown>;
};

export type Bag24CorrectionSpec = {
  eventId: string;
  eventType: string;
  field: string;
  beforeLotId: string;
  afterLotId: string;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
};

export type Phase2ApplyState = Phase2DbSnapshot & {
  bag45WorkflowBagId: string;
  bag24WorkflowBagId: string;
  bag45HasPhase1: boolean;
  bag24: Phase2DbSnapshot["bag24"] & {
    materialRowsDetailed: Bag24MaterialRow[];
    pvc645SegmentRow: Bag24MaterialRow | null;
    pvc645DepletedRow: Bag24MaterialRow | null;
    pvc2MountRow: Bag24MaterialRow | null;
    foil645Row: Bag24MaterialRow | null;
    blister359Rows: Bag24MaterialRow[];
  };
  activePvcRollNumber: string | null;
};

export type Phase2ApplyProposal = {
  bag45WorkflowInserts: Array<{
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }>;
  bag45MaterialInserts: Array<{
    eventType: string;
    rollNumber: string;
    lotId: string;
    segmentCount: number | null;
    segmentReason: string | null;
    occurredAt: string;
    segmentGroupId: string | null;
  }>;
  bag24Corrections: Bag24CorrectionSpec[];
  bag24UntouchedEventIds: string[];
  auditActions: string[];
  rebuildSteps: string[];
  rollTotalsBefore: Record<string, number>;
  rollTotalsAfter: Record<string, number>;
  rollStatusAfter: Record<string, string>;
  bag45SegmentTotalBefore: number;
  bag45SegmentTotalAfter: number;
  warnings: string[];
};

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

const LIVE_OPS_ACCOUNTABILITY: AccountabilityForEvent = {
  enteredByUserId: null,
  accountableEmployeeId: null,
  accountabilitySource: "LEGACY_TEXT",
  accountableEmployeeNameSnapshot: "live_ops_backfill",
  isStable: false,
};

function readFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

export function parseBag45Phase2Cli(argv: string[]): Bag45Phase2CliOptions {
  return {
    apply: argv.includes("--apply"),
    confirm: readFlag(argv, "--confirm") ?? null,
    auditReason: readFlag(argv, "--audit-reason") ?? null,
    skipRebuild: argv.includes("--skip-rebuild"),
  };
}

export function validatePhase2ApplyGate(
  opts: Bag45Phase2CliOptions,
): { ok: true } | { ok: false; error: string } {
  if (!opts.apply) return { ok: true };
  if (opts.confirm !== PHASE2_CONFIRM_STRING) {
    return {
      ok: false,
      error: `Apply requires --confirm ${PHASE2_CONFIRM_STRING}`,
    };
  }
  if (!opts.auditReason || opts.auditReason.trim() === "") {
    return { ok: false, error: "Apply requires --audit-reason" };
  }
  return { ok: true };
}

export function detectBag45HasPhase1(workflowEvents: WorkflowRow[]): boolean {
  const pause187 = workflowEvents.some(
    (e) =>
      e.eventType === "BAG_PAUSED" &&
      e.reason === "shift_end" &&
      e.counterSnapshot === 187,
  );
  const pause18 = workflowEvents.some(
    (e) =>
      e.eventType === "BAG_PAUSED" &&
      e.reason === "machine_jam" &&
      e.counterSnapshot === 18,
  );
  return pause187 && pause18;
}

export function buildBag24CorrectionSpecs(
  state: Pick<
    Phase2ApplyState,
    "bag24" | "rolls"
  >,
): Bag24CorrectionSpec[] {
  const seg = state.bag24.pvc645SegmentRow;
  const dep = state.bag24.pvc645DepletedRow;
  if (!seg || !dep) return [];

  const pvc1MaterialId =
    state.bag24.materialRowsDetailed.find((r) => r.lotId === PHASE2_IDS.pvc1)
      ?.packagingMaterialId ?? "";

  const corrections: Bag24CorrectionSpec[] = [
    {
      eventId: seg.id,
      eventType: seg.eventType,
      field: "packaging_lot_id + payload.material_lot_id",
      beforeLotId: PHASE2_IDS.legacyPvc02,
      afterLotId: PHASE2_IDS.pvc1,
      beforeSnapshot: {
        packaging_lot_id: seg.lotId,
        roll_number: seg.rollNumber,
        segment_count: seg.segmentCount,
        roll_total_after_segment: seg.rollTotalAfter,
      },
      afterSnapshot: {
        packaging_lot_id: PHASE2_IDS.pvc1,
        roll_number: "PVC-1",
        segment_count: PHASE2_COUNTS.bag24RollChange,
        roll_total_after_segment: PHASE2_COUNTS.bag24RollChange,
        packaging_material_id: pvc1MaterialId,
      },
    },
    {
      eventId: dep.id,
      eventType: dep.eventType,
      field: "packaging_lot_id + payload.material_lot_id + final_roll_yield",
      beforeLotId: PHASE2_IDS.legacyPvc02,
      afterLotId: PHASE2_IDS.pvc1,
      beforeSnapshot: {
        packaging_lot_id: dep.lotId,
        roll_number: dep.rollNumber,
      },
      afterSnapshot: {
        packaging_lot_id: PHASE2_IDS.pvc1,
        roll_number: "PVC-1",
        final_roll_yield_blisters: PHASE2_COUNTS.bag24RollChange,
        packaging_material_id: pvc1MaterialId,
      },
    },
  ];
  return corrections;
}

export function buildPhase2ApplyProposal(state: Phase2ApplyState): Phase2ApplyProposal {
  const dry = buildPhase2DryRunProposal(state);
  const segmentGroupId = randomUUID();

  const legacyPvcBefore =
    state.rolls.find((r) => r.lotId === PHASE2_IDS.legacyPvc02)?.segmentSum ?? 0;
  const pvc1Before =
    state.rolls.find((r) => r.lotId === PHASE2_IDS.pvc1)?.segmentSum ?? 0;
  const pvc2Before =
    state.rolls.find((r) => r.lotId === PHASE2_IDS.pvc2)?.segmentSum ?? 0;
  const foilBefore =
    state.rolls.find((r) => r.lotId === PHASE2_IDS.legacyFoil01)?.segmentSum ?? 0;

  const legacyPvcAfter = legacyPvcBefore + PHASE2_COUNTS.bag45PvcChange - PHASE2_COUNTS.bag24RollChange;
  const pvc1After = pvc1Before + PHASE2_COUNTS.bag24RollChange;
  const foilAfter = foilBefore + PHASE2_COUNTS.bag45PvcChange;

  const bag24Corrections = buildBag24CorrectionSpecs(state);
  const untouchedIds = [
    ...(state.bag24.foil645Row ? [state.bag24.foil645Row.id] : []),
    ...(state.bag24.pvc2MountRow ? [state.bag24.pvc2MountRow.id] : []),
    ...state.bag24.blister359Rows.map((r) => r.id),
  ];

  return {
    bag45WorkflowInserts: [
      {
        eventType: "BAG_PAUSED",
        occurredAt: BAG45_PVC_CHANGE_AT_ISO,
        payload: {
          reason: "pvc_swap",
          counter_snapshot_count: PHASE2_COUNTS.bag45PvcChange,
          counter_snapshot_reason: "ROLL_CHANGE",
          counter_snapshot_unit: "good_blisters_since_last_reset",
          counter_snapshot_source: "live_ops_backfill",
          backfill_source: "live_ops.bag45_phase2",
        },
      },
      {
        eventType: "BAG_RESUMED",
        occurredAt: "2026-06-01T17:23:01.000Z",
        payload: { backfill_source: "live_ops.bag45_phase2" },
      },
    ],
    bag45MaterialInserts: [
      {
        eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
        rollNumber: "Legacy PVC-02",
        lotId: PHASE2_IDS.legacyPvc02,
        segmentCount: PHASE2_COUNTS.bag45PvcChange,
        segmentReason: "ROLL_CHANGE",
        occurredAt: BAG45_PVC_CHANGE_AT_ISO,
        segmentGroupId,
      },
      {
        eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
        rollNumber: "Legacy FOIL-01",
        lotId: PHASE2_IDS.legacyFoil01,
        segmentCount: PHASE2_COUNTS.bag45PvcChange,
        segmentReason: "ROLL_CHANGE",
        occurredAt: BAG45_PVC_CHANGE_AT_ISO,
        segmentGroupId,
      },
      {
        eventType: "ROLL_DEPLETED",
        rollNumber: "Legacy PVC-02",
        lotId: PHASE2_IDS.legacyPvc02,
        segmentCount: null,
        segmentReason: null,
        occurredAt: BAG45_PVC_CHANGE_AT_ISO,
        segmentGroupId,
      },
      {
        eventType: "ROLL_MOUNTED",
        rollNumber: "PVC-1",
        lotId: PHASE2_IDS.pvc1,
        segmentCount: null,
        segmentReason: null,
        occurredAt: BAG45_PVC_CHANGE_AT_ISO,
        segmentGroupId,
      },
    ],
    bag24Corrections,
    bag24UntouchedEventIds: untouchedIds,
    auditActions: [PHASE2_AUDIT_ACTIONS.bag45, PHASE2_AUDIT_ACTIONS.bag24],
    rebuildSteps: [
      "replayPackagingLotStatuses (Legacy PVC-02, PVC-1, PVC-2, Legacy FOIL-01)",
      "rebuildRollUsage (full read_roll_usage)",
      "rebuildMaterialLotState (full read_material_lot_state)",
    ],
    rollTotalsBefore: {
      "Legacy PVC-02": legacyPvcBefore,
      "PVC-1": pvc1Before,
      "PVC-2": pvc2Before,
      "Legacy FOIL-01": foilBefore,
    },
    rollTotalsAfter: {
      "Legacy PVC-02": legacyPvcAfter,
      "PVC-1": pvc1After,
      "PVC-2": pvc2Before,
      "Legacy FOIL-01": foilAfter,
    },
    rollStatusAfter: {
      "Legacy PVC-02": "DEPLETED",
      "PVC-1": "DEPLETED",
      "PVC-2": "IN_USE",
      "Legacy FOIL-01": "IN_USE",
    },
    bag45SegmentTotalBefore: dry.bag45.bagSegmentTotalBefore,
    bag45SegmentTotalAfter: dry.bag45.bagSegmentTotalAfter,
    warnings: [
      "Bag 24 existing material rows will be corrected in a controlled audited script because append-only roll voiding is unsupported.",
      dry.schemaGap ?? "",
    ].filter(Boolean),
  };
}

export function validatePhase2ApplyGuards(
  state: Phase2ApplyState,
): string[] {
  const blockers = [...validatePhase2Guards(state)];

  if (state.bag45WorkflowBagId !== PHASE2_IDS.bag45WorkflowBagId) {
    blockers.push(
      `Bag 45 workflow_bag_id mismatch: ${state.bag45WorkflowBagId}`,
    );
  }
  if (state.bag24WorkflowBagId !== PHASE2_IDS.bag24WorkflowBagId) {
    blockers.push(
      `Bag 24 workflow_bag_id mismatch: ${state.bag24WorkflowBagId}`,
    );
  }
  if (!state.bag45HasPhase1) {
    blockers.push("Bag 45 missing Phase 1 pause events (187 shift_end + 18 machine_jam)");
  }
  if (!state.bag24.pvc645SegmentRow) {
    blockers.push("Bag 24 missing 645 PVC ROLL_COUNTER_SEGMENT on Legacy PVC-02");
  }
  if (!state.bag24.pvc645DepletedRow) {
    blockers.push("Bag 24 missing ROLL_DEPLETED on Legacy PVC-02 in group cd1d0ac3…");
  }
  if (!state.bag24.pvc2MountRow) {
    blockers.push("Bag 24 missing ROLL_MOUNTED PVC-2 in roll-change group");
  }
  if (!state.bag24.has359Complete) {
    blockers.push("Bag 24 missing BLISTER_COMPLETE count_total=359");
  }
  if (state.bag24.blister359Rows.length < 2) {
    blockers.push("Bag 24 expected FOIL + PVC-2 BAG_COMPLETE rows for 359");
  }
  if (!state.bag24.foil645Row) {
    blockers.push("Bag 24 missing FOIL 645 segment");
  }
  if (state.activePvcRollNumber !== "PVC-2") {
    blockers.push(
      `Active blister PVC is ${state.activePvcRollNumber ?? "none"}, expected PVC-2 for safe end-state`,
    );
  }

  const proposal = buildPhase2ApplyProposal(state);
  if (
    proposal.bag45MaterialInserts.some(
      (m) => m.lotId === PHASE2_IDS.pvc1 && m.segmentCount === PHASE2_COUNTS.bag45PvcChange,
    )
  ) {
    blockers.push("Proposal would assign 516 to PVC-1");
  }
  if (proposal.bag24Corrections.length !== 2) {
    blockers.push("Expected exactly 2 Bag 24 PVC correction rows");
  }

  return blockers;
}

export function assertPhase2ProposalIntegrity(proposal: Phase2ApplyProposal): void {
  const pvc516 = proposal.bag45MaterialInserts.find(
    (m) =>
      m.lotId === PHASE2_IDS.legacyPvc02 &&
      m.segmentCount === PHASE2_COUNTS.bag45PvcChange,
  );
  if (!pvc516) throw new Error("Bag 45 516 must be on Legacy PVC-02");
  if (
    proposal.bag45MaterialInserts.some(
      (m) => m.lotId === PHASE2_IDS.pvc1 && m.eventType === "ROLL_COUNTER_SEGMENT_RECORDED",
    )
  ) {
    throw new Error("PVC-1 must not receive 516 segment");
  }
  const mountPvc1 = proposal.bag45MaterialInserts.find(
    (m) => m.lotId === PHASE2_IDS.pvc1 && m.eventType === "ROLL_MOUNTED",
  );
  if (!mountPvc1) throw new Error("PVC-1 ROLL_MOUNTED required after Bag 45 516");

  for (const c of proposal.bag24Corrections) {
    if (c.afterLotId !== PHASE2_IDS.pvc1) {
      throw new Error(`Bag 24 correction must target PVC-1, got ${c.afterLotId}`);
    }
  }
  if (proposal.rollTotalsAfter["PVC-2"] !== proposal.rollTotalsBefore["PVC-2"]) {
    throw new Error("PVC-2 total must remain unchanged");
  }
}

export function assertPhase2ApplySourceGuard(source: string): void {
  const zohoImport = /from\s+["']@?\/?.*zoho/i;
  const deleteWorkflow = new RegExp("DELETE FROM workflow_" + "events");
  const deleteMaterial = new RegExp("DELETE FROM material_" + "inventory_events");
  const migrateCmd = new RegExp("drizzle-kit migrate");
  if (zohoImport.test(source)) {
    throw new Error("Phase 2 apply source guard failed: zoho import");
  }
  if (migrateCmd.test(source)) {
    throw new Error("Phase 2 apply source guard failed: migrations");
  }
  if (deleteWorkflow.test(source)) {
    throw new Error("Phase 2 apply source guard failed: delete workflow events");
  }
  if (deleteMaterial.test(source)) {
    throw new Error("Phase 2 apply source guard failed: delete material events");
  }
}

async function loadLotMaterialId(lotId: string): Promise<string> {
  const [row] = await db
    .select({ packagingMaterialId: packagingLots.packagingMaterialId })
    .from(packagingLots)
    .where(eq(packagingLots.id, lotId));
  if (!row?.packagingMaterialId) {
    throw new Error(`packaging_material_id not found for lot ${lotId}`);
  }
  return row.packagingMaterialId;
}

export async function loadPhase2ApplyState(): Promise<Phase2ApplyState> {
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
    packaging_material_id: string;
    event_type: string;
    occurred_at: string;
    segment_count: number | null;
    segment_reason: string | null;
    segment_group_id: string | null;
    bag_total: number | null;
    roll_total: number | null;
    payload: Record<string, unknown>;
  };
  const matRows = (await db.execute<MatRow>(sql`
    SELECT mie.workflow_bag_id::text,
           mie.id::text,
           pl.roll_number,
           mie.packaging_lot_id::text AS lot_id,
           mie.packaging_material_id::text AS packaging_material_id,
           mie.event_type,
           mie.occurred_at::text,
           (mie.payload->>'counter_segment_count')::int AS segment_count,
           mie.payload->>'segment_reason' AS segment_reason,
           mie.payload->>'segment_group_id' AS segment_group_id,
           (mie.payload->>'active_bag_total_after_segment')::int AS bag_total,
           (mie.payload->>'roll_total_after_segment')::int AS roll_total,
           mie.payload
    FROM material_inventory_events mie
    JOIN packaging_lots pl ON pl.id = mie.packaging_lot_id
    WHERE mie.workflow_bag_id = ${PHASE2_IDS.bag24WorkflowBagId}::uuid
       OR mie.workflow_bag_id = ${PHASE2_IDS.bag45WorkflowBagId}::uuid
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

  const mapMatDetailed = (rows: MatRow[]): Bag24MaterialRow[] =>
    rows.map((r) => ({
      id: r.id,
      rollNumber: r.roll_number,
      lotId: r.lot_id,
      packagingMaterialId: r.packaging_material_id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      segmentCount: r.segment_count,
      segmentReason: r.segment_reason,
      segmentGroupId: r.segment_group_id,
      bagTotalAfter: r.bag_total,
      rollTotalAfter: r.roll_total,
      payload: r.payload ?? {},
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
  const bag24MatDetailed = mapMatDetailed(
    matRows.filter((r) => r.workflow_bag_id === PHASE2_IDS.bag24WorkflowBagId),
  );

  const groupRows = bag24MatDetailed.filter(
    (r) => r.segmentGroupId === PHASE2_IDS.bag24RollChangeGroupId,
  );
  const pvc645SegmentRow =
    groupRows.find(
      (r) =>
        r.eventType === "ROLL_COUNTER_SEGMENT_RECORDED" &&
        r.lotId === PHASE2_IDS.legacyPvc02 &&
        r.segmentCount === PHASE2_COUNTS.bag24RollChange,
    ) ?? null;
  const pvc645DepletedRow =
    groupRows.find(
      (r) =>
        r.eventType === "ROLL_DEPLETED" && r.lotId === PHASE2_IDS.legacyPvc02,
    ) ?? null;
  const pvc2MountRow =
    groupRows.find(
      (r) => r.eventType === "ROLL_MOUNTED" && r.lotId === PHASE2_IDS.pvc2,
    ) ?? null;
  const foil645Row =
    groupRows.find(
      (r) =>
        r.eventType === "ROLL_COUNTER_SEGMENT_RECORDED" &&
        r.lotId === PHASE2_IDS.legacyFoil01 &&
        r.segmentCount === PHASE2_COUNTS.bag24RollChange,
    ) ?? null;
  const blister359Rows = bag24MatDetailed.filter(
    (r) =>
      r.eventType === "ROLL_COUNTER_SEGMENT_RECORDED" &&
      r.segmentReason === "BAG_COMPLETE" &&
      r.segmentCount === PHASE2_COUNTS.bag24BlisterComplete,
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

  type MountRow = { roll_number: string; status: string; role: string };
  const active = (await db.execute<MountRow>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id, ev.event_type, ev.machine_id, ev.payload
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_DEPLETED')
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT pl.roll_number, pl.status::text,
      COALESCE(le.payload->>'roll_role', 'PVC') AS role
    FROM packaging_lots pl
    JOIN latest_event le ON le.packaging_lot_id = pl.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND le.machine_id = ${PHASE2_IDS.blisterMachineId}::uuid
  `)) as unknown as MountRow[];

  const activePvc = active.find((r) => r.role === "PVC")?.roll_number ?? null;

  const seg516 = bag45Mat.some((r) => r.segmentCount === PHASE2_COUNTS.bag45PvcChange);
  const pvc1Bag45 = bag45Mat.filter((r) => r.lotId === PHASE2_IDS.pvc1).length;

  return {
    bag45: {
      workflowEvents: mapWe(bag45We),
      materialEvents: bag45Mat,
      stage: rbs?.stage ?? null,
      segmentSumOnPvc: bag45Mat
        .filter(
          (r) =>
            r.lotId === PHASE2_IDS.legacyPvc02 &&
            r.eventType === "ROLL_COUNTER_SEGMENT_RECORDED",
        )
        .reduce((s, r) => s + (r.segmentCount ?? 0), 0),
      has516: seg516,
      pvc1EventCount: pvc1Bag45,
    },
    bag24: {
      workflowEvents: mapWe(bag24We),
      materialEvents: bag24MatDetailed.map(
        ({ payload: _p, packagingMaterialId: _m, ...rest }) => rest,
      ),
      rollChange645OnLegacyPvc02: pvc645SegmentRow != null,
      rollChange645OnPvc1: bag24MatDetailed.some(
        (r) =>
          r.lotId === PHASE2_IDS.pvc1 &&
          r.segmentCount === PHASE2_COUNTS.bag24RollChange &&
          r.segmentReason === "ROLL_CHANGE",
      ),
      has359Complete: bag24We.some(
        (r) =>
          r.event_type === "BLISTER_COMPLETE" &&
          r.count_total === PHASE2_COUNTS.bag24BlisterComplete,
      ),
      materialRowsDetailed: bag24MatDetailed,
      pvc645SegmentRow,
      pvc645DepletedRow,
      pvc2MountRow,
      foil645Row,
      blister359Rows,
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
    bag45WorkflowBagId: PHASE2_IDS.bag45WorkflowBagId,
    bag24WorkflowBagId: PHASE2_IDS.bag24WorkflowBagId,
    bag45HasPhase1: detectBag45HasPhase1(mapWe(bag45We)),
    activePvcRollNumber: activePvc,
  };
}

async function computeLegacyYieldAtDepletion(
  tx: Tx,
  depletionAt: Date,
  includeNewSegment: number,
): Promise<number> {
  type SumRow = { total: number };
  const [row] = (await tx.execute<SumRow>(sql`
    SELECT COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND packaging_lot_id = ${PHASE2_IDS.legacyPvc02}::uuid
      AND occurred_at <= ${depletionAt.toISOString()}::timestamptz
  `)) as unknown as SumRow[];
  return (row?.total ?? 0) + includeNewSegment;
}

async function insertRollChangeSegment(
  tx: Tx,
  args: {
    workflowBagId: string;
    lotId: string;
    packagingMaterialId: string;
    role: "PVC" | "FOIL";
    counterSegmentCount: number;
    occurredAt: Date;
    segmentGroupId: string;
    auditReason: string;
  },
): Promise<void> {
  type CountRow = { n: number; total: number };
  const bagPriorRows = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND workflow_bag_id = ${args.workflowBagId}::uuid
  `)) as unknown as CountRow[];
  const bagSegmentSequence = (bagPriorRows[0]?.n ?? 0) + 1;
  const activeBagTotalAfterSegment =
    (bagPriorRows[0]?.total ?? 0) + args.counterSegmentCount;

  const rollPriorRows = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND packaging_lot_id = ${args.lotId}::uuid
      AND occurred_at <= ${args.occurredAt.toISOString()}::timestamptz
  `)) as unknown as CountRow[];
  const rollSegmentSequence = (rollPriorRows[0]?.n ?? 0) + 1;
  const rollTotalAfterSegment =
    (rollPriorRows[0]?.total ?? 0) + args.counterSegmentCount;

  await tx.insert(materialInventoryEvents).values({
    eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
    packagingMaterialId: args.packagingMaterialId,
    packagingLotId: args.lotId,
    workflowBagId: args.workflowBagId,
    machineId: PHASE2_IDS.blisterMachineId,
    stationId: PHASE2_IDS.blisterStationId,
    quantityUnits: args.counterSegmentCount,
    unitOfMeasure: "blisters",
    occurredAt: args.occurredAt,
    source: "live_ops.bag45_phase2_backfill",
    payload: withAccountabilityPayload(
      {
        roll_role: args.role,
        material_lot_id: args.lotId,
        counter_segment_count: args.counterSegmentCount,
        segment_reason: "ROLL_CHANGE",
        bag_segment_sequence: bagSegmentSequence,
        roll_segment_sequence: rollSegmentSequence,
        active_bag_total_after_segment: activeBagTotalAfterSegment,
        roll_total_after_segment: rollTotalAfterSegment,
        workflow_bag_id: args.workflowBagId,
        machine_id: PHASE2_IDS.blisterMachineId,
        confidence: "HIGH",
        segment_group_id: args.segmentGroupId,
        source_action: "live_ops_phase2_pvc_change",
        backfill_source: "live_ops.bag45_phase2",
        audit_reason: args.auditReason,
      },
      LIVE_OPS_ACCOUNTABILITY,
    ),
  });
}

export async function replayPackagingLotStatuses(
  tx: Tx,
  lotIds: string[],
): Promise<void> {
  for (const lotId of lotIds) {
    type EvRow = { event_type: string };
    const events = (await tx.execute<EvRow>(sql`
      SELECT event_type
      FROM material_inventory_events
      WHERE packaging_lot_id = ${lotId}::uuid
        AND event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_DEPLETED')
      ORDER BY occurred_at ASC, id ASC
    `)) as unknown as EvRow[];

    let status: "AVAILABLE" | "IN_USE" | "DEPLETED" = "AVAILABLE";
    for (const ev of events) {
      if (ev.event_type === "ROLL_MOUNTED") status = "IN_USE";
      if (ev.event_type === "ROLL_UNMOUNTED") status = "AVAILABLE";
      if (ev.event_type === "ROLL_DEPLETED") status = "DEPLETED";
    }
    await tx
      .update(packagingLots)
      .set({ status })
      .where(eq(packagingLots.id, lotId));
  }
}

async function applyBag24Corrections(
  tx: Tx,
  proposal: Phase2ApplyProposal,
  auditReason: string,
): Promise<void> {
  const pvc1MaterialId = await loadLotMaterialId(PHASE2_IDS.pvc1);
  const [pvc1Lot] = await tx
    .select({ netWeightGrams: packagingLots.netWeightGrams })
    .from(packagingLots)
    .where(eq(packagingLots.id, PHASE2_IDS.pvc1));

  for (const spec of proposal.bag24Corrections) {
    const eventId = Number(spec.eventId);
    if (spec.eventType === "ROLL_COUNTER_SEGMENT_RECORDED") {
      const [existing] = await tx
        .select({ payload: materialInventoryEvents.payload })
        .from(materialInventoryEvents)
        .where(eq(materialInventoryEvents.id, eventId));
      const payload = {
        ...((existing?.payload ?? {}) as Record<string, unknown>),
        material_lot_id: PHASE2_IDS.pvc1,
        roll_total_after_segment: PHASE2_COUNTS.bag24RollChange,
        roll_role: "PVC",
        correction_source: "live_ops.bag45_phase2",
        audit_reason: auditReason,
        correction_note: "645 re-attributed from Legacy PVC-02 to PVC-1",
      };
      await tx
        .update(materialInventoryEvents)
        .set({
          packagingLotId: PHASE2_IDS.pvc1,
          packagingMaterialId: pvc1MaterialId,
          payload,
        })
        .where(eq(materialInventoryEvents.id, eventId));
    } else if (spec.eventType === "ROLL_DEPLETED") {
      const gramsPerBlister =
        pvc1Lot?.netWeightGrams != null && PHASE2_COUNTS.bag24RollChange > 0
          ? pvc1Lot.netWeightGrams / PHASE2_COUNTS.bag24RollChange
          : null;
      const [existing] = await tx
        .select({ payload: materialInventoryEvents.payload })
        .from(materialInventoryEvents)
        .where(eq(materialInventoryEvents.id, eventId));
      const payload = {
        ...((existing?.payload ?? {}) as Record<string, unknown>),
        material_lot_id: PHASE2_IDS.pvc1,
        roll_role: "PVC",
        final_roll_yield_blisters: PHASE2_COUNTS.bag24RollChange,
        grams_per_blister: gramsPerBlister,
        correction_source: "live_ops.bag45_phase2",
        audit_reason: auditReason,
        correction_note: "ROLL_DEPLETED re-attributed from Legacy PVC-02 to PVC-1",
      };
      await tx
        .update(materialInventoryEvents)
        .set({
          packagingLotId: PHASE2_IDS.pvc1,
          packagingMaterialId: pvc1MaterialId,
          payload,
        })
        .where(eq(materialInventoryEvents.id, eventId));
    }
  }
}

async function verifyPostApplyTotals(
  tx: Tx,
  proposal: Phase2ApplyProposal,
): Promise<string[]> {
  type RollRow = { roll_number: string; seg_sum: number; status: string };
  const rows = (await tx.execute<RollRow>(sql`
    SELECT pl.roll_number, pl.status::text,
      COALESCE(SUM((ev.payload->>'counter_segment_count')::int)
        FILTER (WHERE ev.event_type='ROLL_COUNTER_SEGMENT_RECORDED'),0)::int AS seg_sum
    FROM packaging_lots pl
    LEFT JOIN material_inventory_events ev ON ev.packaging_lot_id = pl.id
    WHERE pl.id IN (
      ${PHASE2_IDS.legacyPvc02}::uuid, ${PHASE2_IDS.pvc1}::uuid,
      ${PHASE2_IDS.pvc2}::uuid, ${PHASE2_IDS.legacyFoil01}::uuid
    )
    GROUP BY pl.roll_number, pl.id, pl.status
  `)) as unknown as RollRow[];

  const failures: string[] = [];
  const byName = Object.fromEntries(rows.map((r) => [r.roll_number, r]));
  const expected = proposal.rollTotalsAfter;
  for (const [name, exp] of Object.entries(expected)) {
    const actual = byName[name]?.seg_sum;
    if (actual !== exp) {
      failures.push(`${name} segment sum ${actual} != expected ${exp}`);
    }
  }
  for (const [name, expStatus] of Object.entries(proposal.rollStatusAfter)) {
    const actual = byName[name]?.status;
    if (actual !== expStatus) {
      failures.push(`${name} status ${actual} != expected ${expStatus}`);
    }
  }
  return failures;
}

function printPhase2Proposal(
  state: Phase2ApplyState,
  proposal: Phase2ApplyProposal,
  blockers: string[],
  mode: "DRY-RUN" | "APPLY",
): void {
  console.log(`=== Bag 45 Phase 2 PVC timeline — ${mode} ===\n`);

  console.log("--- 1. Current Bag 45 ---");
  console.log("  stage:", state.bag45.stage);
  console.log("  workflow:", state.bag45.workflowEvents.length, "events");
  console.log("  material:", state.bag45.materialEvents.length, "events");
  console.log("  PVC segment sum:", state.bag45.segmentSumOnPvc);
  console.log("  has516:", state.bag45.has516);

  console.log("\n--- 2. Current Bag 24 ---");
  console.log("  workflow:", state.bag24.workflowEvents.length, "events");
  console.log("  material:", state.bag24.materialEvents.length, "events");
  console.log("  645 on Legacy PVC-02:", state.bag24.rollChange645OnLegacyPvc02);
  console.log("  359 complete:", state.bag24.has359Complete);

  console.log("\n--- 3. Current roll totals/status ---");
  for (const r of state.rolls) {
    console.log(`  ${r.rollNumber}: sum=${r.segmentSum} status=${r.status}`);
  }
  console.log("  active mounted:", state.activeMounted);

  console.log("\n--- 4. Proposed Bag 45 inserts ---");
  console.log("  workflow:", proposal.bag45WorkflowInserts);
  console.log("  material:", proposal.bag45MaterialInserts);

  console.log("\n--- 5. Proposed Bag 24 corrections ---");
  for (const c of proposal.bag24Corrections) {
    console.log(`  event ${c.eventId} ${c.eventType}:`, c.beforeSnapshot, "->", c.afterSnapshot);
  }
  console.log("  untouched event ids:", proposal.bag24UntouchedEventIds);

  console.log("\n--- 6. Audit rows ---");
  for (const a of proposal.auditActions) console.log(" ", a);

  console.log("\n--- 7. Rebuild steps ---");
  for (const s of proposal.rebuildSteps) console.log(" ", s);

  console.log("\n--- 8. Roll totals before/after ---");
  console.log("  before:", proposal.rollTotalsBefore);
  console.log("  after:", proposal.rollTotalsAfter);

  console.log("\n--- 9. Status after ---");
  console.log(" ", proposal.rollStatusAfter);

  console.log("\n--- 10. Controlled correction warning ---");
  console.log(
    "  Bag 24 existing material rows WILL be corrected (lot_id + payload) because append-only roll voiding is unsupported.",
  );
  for (const w of proposal.warnings) console.log("  !", w);

  if (blockers.length) {
    console.log("\n--- BLOCKERS ---");
    for (const b of blockers) console.log("  x", b);
  }
}

export async function runBag45Phase2Apply(
  opts: Bag45Phase2CliOptions,
): Promise<{
  applied: boolean;
  proposal: Phase2ApplyProposal | null;
  error?: string;
}> {
  assertPhase2ApplySourceGuard(
    "Phase 2 maintenance apply — workflow_events material_inventory_events packaging_lots audit_log read_roll_usage read_material_lot_state",
  );

  const gate = validatePhase2ApplyGate(opts);
  if (!gate.ok) {
    return { applied: false, proposal: null, error: gate.error };
  }

  const state = await loadPhase2ApplyState();
  const blockers = validatePhase2ApplyGuards(state);
  const proposal = buildPhase2ApplyProposal(state);
  assertPhase2ProposalIntegrity(proposal);

  printPhase2Proposal(state, proposal, blockers, opts.apply ? "APPLY" : "DRY-RUN");

  if (blockers.length) {
    return {
      applied: false,
      proposal,
      error: blockers.join("; "),
    };
  }

  if (!opts.apply) {
    console.log("\nNo writes performed (dry-run default).");
    return { applied: false, proposal };
  }

  const auditReason = opts.auditReason!;
  const pvcChangeAt = new Date(BAG45_PVC_CHANGE_AT_ISO);
  const segmentGroupId =
    proposal.bag45MaterialInserts.find((m) => m.segmentGroupId)?.segmentGroupId ??
    randomUUID();

  const legacyPvcMaterialId = await loadLotMaterialId(PHASE2_IDS.legacyPvc02);
  const legacyFoilMaterialId = await loadLotMaterialId(PHASE2_IDS.legacyFoil01);
  const pvc1MaterialId = await loadLotMaterialId(PHASE2_IDS.pvc1);

  const [legacyLot] = await db
    .select({ netWeightGrams: packagingLots.netWeightGrams })
    .from(packagingLots)
    .where(eq(packagingLots.id, PHASE2_IDS.legacyPvc02));
  const [pvc1Lot] = await db
    .select({ status: packagingLots.status, netWeightGrams: packagingLots.netWeightGrams })
    .from(packagingLots)
    .where(eq(packagingLots.id, PHASE2_IDS.pvc1));

  await db.transaction(async (tx) => {
    const workflowBagId = PHASE2_IDS.bag45WorkflowBagId;

    for (const spec of proposal.bag45WorkflowInserts) {
      await projectEvent(tx, {
        workflowBagId,
        stationId: PHASE2_IDS.blisterStationId,
        eventType: spec.eventType as Parameters<typeof projectEvent>[1]["eventType"],
        payload: { ...spec.payload, audit_reason: auditReason },
        occurredAt: new Date(spec.occurredAt),
        accountabilitySource: LIVE_OPS_ACCOUNTABILITY.accountabilitySource,
        accountableEmployeeNameSnapshot:
          LIVE_OPS_ACCOUNTABILITY.accountableEmployeeNameSnapshot,
      });
    }

    await insertRollChangeSegment(tx, {
      workflowBagId,
      lotId: PHASE2_IDS.legacyPvc02,
      packagingMaterialId: legacyPvcMaterialId,
      role: "PVC",
      counterSegmentCount: PHASE2_COUNTS.bag45PvcChange,
      occurredAt: pvcChangeAt,
      segmentGroupId,
      auditReason,
    });
    await insertRollChangeSegment(tx, {
      workflowBagId,
      lotId: PHASE2_IDS.legacyFoil01,
      packagingMaterialId: legacyFoilMaterialId,
      role: "FOIL",
      counterSegmentCount: PHASE2_COUNTS.bag45PvcChange,
      occurredAt: pvcChangeAt,
      segmentGroupId,
      auditReason,
    });

    const legacyFinalYield = await computeLegacyYieldAtDepletion(
      tx,
      pvcChangeAt,
      PHASE2_COUNTS.bag45PvcChange,
    );
    const legacyGramsPerBlister =
      legacyLot?.netWeightGrams != null && legacyFinalYield > 0
        ? legacyLot.netWeightGrams / legacyFinalYield
        : null;

    await tx.insert(materialInventoryEvents).values({
      eventType: "ROLL_DEPLETED",
      packagingMaterialId: legacyPvcMaterialId,
      packagingLotId: PHASE2_IDS.legacyPvc02,
      workflowBagId,
      machineId: PHASE2_IDS.blisterMachineId,
      stationId: PHASE2_IDS.blisterStationId,
      occurredAt: pvcChangeAt,
      unitOfMeasure: "g",
      source: "live_ops.bag45_phase2_backfill",
      payload: withAccountabilityPayload(
        {
          roll_role: "PVC",
          material_lot_id: PHASE2_IDS.legacyPvc02,
          final_roll_yield_blisters: legacyFinalYield,
          net_weight_grams: legacyLot?.netWeightGrams ?? null,
          grams_per_blister: legacyGramsPerBlister,
          depleted_during_bag: true,
          workflow_bag_id: workflowBagId,
          confidence: legacyGramsPerBlister != null ? "HIGH" : "MEDIUM",
          segment_group_id: segmentGroupId,
          source_action: "live_ops_phase2_pvc_change",
          backfill_source: "live_ops.bag45_phase2",
          audit_reason: auditReason,
        },
        LIVE_OPS_ACCOUNTABILITY,
      ),
    });

    await tx.insert(materialInventoryEvents).values({
      eventType: "ROLL_MOUNTED",
      packagingMaterialId: pvc1MaterialId,
      packagingLotId: PHASE2_IDS.pvc1,
      workflowBagId,
      machineId: PHASE2_IDS.blisterMachineId,
      stationId: PHASE2_IDS.blisterStationId,
      occurredAt: pvcChangeAt,
      unitOfMeasure: "g",
      source: "live_ops.bag45_phase2_backfill",
      payload: withAccountabilityPayload(
        {
          roll_role: "PVC",
          starting_weight_grams: pvc1Lot?.netWeightGrams ?? null,
          previous_status: pvc1Lot?.status ?? "AVAILABLE",
          mounted_via: "ROLL_CHANGE",
          segment_group_id: segmentGroupId,
          source_action: "live_ops_phase2_pvc_change",
          backfill_source: "live_ops.bag45_phase2",
          audit_reason: auditReason,
        },
        LIVE_OPS_ACCOUNTABILITY,
      ),
    });

    await applyBag24Corrections(tx, proposal, auditReason);

    await replayPackagingLotStatuses(tx, [
      PHASE2_IDS.legacyPvc02,
      PHASE2_IDS.pvc1,
      PHASE2_IDS.pvc2,
      PHASE2_IDS.legacyFoil01,
    ]);

    if (!opts.skipRebuild) {
      await rebuildRollUsage(tx);
      await rebuildMaterialLotState(tx);
    }

    const verifyFailures = await verifyPostApplyTotals(tx, proposal);
    if (verifyFailures.length > 0) {
      throw new Error(`Post-apply verification failed: ${verifyFailures.join("; ")}`);
    }

    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: PHASE2_AUDIT_ACTIONS.bag45,
        targetType: "WorkflowBag",
        targetId: workflowBagId,
        after: {
          pvc_change_count: PHASE2_COUNTS.bag45PvcChange,
          occurred_at: BAG45_PVC_CHANGE_AT_ISO,
          audit_reason: auditReason,
          bag_segment_total_after: proposal.bag45SegmentTotalAfter,
        },
      },
      tx,
    );

    const bag24Before = proposal.bag24Corrections.map((c) => ({
      event_id: c.eventId,
      before: c.beforeSnapshot,
    }));
    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: PHASE2_AUDIT_ACTIONS.bag24,
        targetType: "WorkflowBag",
        targetId: PHASE2_IDS.bag24WorkflowBagId,
        after: {
          segment_group_id: PHASE2_IDS.bag24RollChangeGroupId,
          audit_reason: auditReason,
          corrections: proposal.bag24Corrections.map((c) => ({
            event_id: c.eventId,
            event_type: c.eventType,
            before: c.beforeSnapshot,
            after: c.afterSnapshot,
          })),
          untouched_event_ids: proposal.bag24UntouchedEventIds,
          before_rows: bag24Before,
        },
      },
      tx,
    );
  });

  console.log("\nApply complete.");
  if (opts.skipRebuild) {
    console.log("WARNING: --skip-rebuild was set; run rebuildRollUsage + rebuildMaterialLotState manually.");
  }
  return { applied: true, proposal };
}
