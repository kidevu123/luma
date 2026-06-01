/**
 * P0 live-ops — Bag Card 45 Phase 1 backfill (187 shift_end + 18 machine_jam only).
 * Excludes 516 PVC change, PVC-1 mount, Legacy PVC-02 depletion, Bag 24 mutation.
 */

import { eq, inArray, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  materialInventoryEvents,
  packagingLots,
  qrCards,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import type { AccountabilityForEvent } from "@/lib/production/station-operator-session";
import { withAccountabilityPayload } from "@/lib/production/station-operator-session";

export const PHASE1_CONFIRM_STRING = "APPLY_BAG45_PHASE1" as const;

export const BAG45_PHASE1_DEFAULTS = {
  workflowCardToken: "bag-card-45",
  expectedInventoryBagId: "4750f72f-89e7-481a-99ae-4984c36febe6",
  bag24WorkflowBagId: "008870c4-6f43-4862-862f-51f7b7ba6853",
  /** Card 24 CARD_ASSIGNED occurred_at (UTC) — Phase 1 timestamps must be strictly before. */
  bag24CardAssignedAtIso: "2026-06-01T19:13:44.385Z",
  blisterStationId: "12492e4b-dac7-46fb-b860-b7ea483fbd9e",
  blisterMachineId: "c65ea16e-7e15-4749-888b-a7b058cfdf53",
  legacyPvc02LotId: "2869ae2a-3b31-4e00-a684-dcc611c82d09",
  legacyFoil01LotId: "0ecd1290-b54d-438d-961b-e794db03fa67",
  pvc1LotId: "ecacd4a2-cbe5-406b-8b5e-a33b1e2a2f0e",
  pvc2LotId: "d083d7c2-c138-48fa-a356-150ecb594370",
  shiftEndCount: 187,
  machineJamCount: 18,
  forbiddenPvcChangeCount: 516,
} as const;

export type Bag45Phase1CliOptions = {
  workflowCardToken: string;
  shiftEndCount: number;
  machineJamCount: number;
  shiftEndAt: Date | null;
  machineJamAt: Date | null;
  auditReason: string | null;
  apply: boolean;
  confirm: string | null;
};

export type Phase1WorkflowEventSpec = {
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type Phase1MaterialEventSpec = {
  eventType: "ROLL_COUNTER_SEGMENT_RECORDED";
  rollNumber: string;
  lotId: string;
  counterSegmentCount: number;
  segmentReason: "SHIFT_END_SNAPSHOT" | "PAUSE_SNAPSHOT";
  occurredAt: string;
};

export type Phase1Proposal = {
  card: {
    id: string;
    label: string;
    scanToken: string;
    assignedWorkflowBagId: string | null;
  };
  inventoryBagId: string;
  workflowBagAction: "create_new" | "use_existing";
  workflowBagId: string | null;
  workflowEvents: Phase1WorkflowEventSpec[];
  materialEvents: Phase1MaterialEventSpec[];
  auditAction: string;
  bagSegmentTotalAfter: number;
  materialDeltas: {
    legacyPvc02: number;
    legacyFoil01: number;
    pvc1: number;
    pvc2: number;
  };
  nonActions: string[];
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

function readIntFlag(argv: string[], name: string, fallback: number): number {
  const raw = readFlag(argv, name);
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

export function parseBag45Phase1Cli(argv: string[]): Bag45Phase1CliOptions {
  const shiftEndRaw = readFlag(argv, "--shift-end-at");
  const machineJamRaw = readFlag(argv, "--machine-jam-at");
  return {
    workflowCardToken:
      readFlag(argv, "--workflow-card-token") ??
      BAG45_PHASE1_DEFAULTS.workflowCardToken,
    shiftEndCount: readIntFlag(
      argv,
      "--shift-end-count",
      BAG45_PHASE1_DEFAULTS.shiftEndCount,
    ),
    machineJamCount: readIntFlag(
      argv,
      "--machine-jam-count",
      BAG45_PHASE1_DEFAULTS.machineJamCount,
    ),
    shiftEndAt: shiftEndRaw ? parseIsoTimestamp("--shift-end-at", shiftEndRaw) : null,
    machineJamAt: machineJamRaw
      ? parseIsoTimestamp("--machine-jam-at", machineJamRaw)
      : null,
    auditReason: readFlag(argv, "--audit-reason") ?? null,
    apply: argv.includes("--apply"),
    confirm: readFlag(argv, "--confirm") ?? null,
  };
}

export function parseIsoTimestamp(flag: string, raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO timestamp for ${flag}: ${raw}`);
  }
  return d;
}

export function validateApplyGate(
  opts: Bag45Phase1CliOptions,
): { ok: true } | { ok: false; error: string } {
  if (!opts.apply) return { ok: true };
  if (opts.confirm !== PHASE1_CONFIRM_STRING) {
    return {
      ok: false,
      error: `Apply requires --confirm ${PHASE1_CONFIRM_STRING}`,
    };
  }
  if (!opts.auditReason || opts.auditReason.trim() === "") {
    return { ok: false, error: "Apply requires --audit-reason" };
  }
  if (!opts.shiftEndAt || !opts.machineJamAt) {
    return {
      ok: false,
      error: "Apply requires --shift-end-at and --machine-jam-at (ISO timestamps)",
    };
  }
  return { ok: true };
}

export function validatePhase1Timestamps(
  shiftEndAt: Date,
  machineJamAt: Date,
  bag24CutoffIso: string = BAG45_PHASE1_DEFAULTS.bag24CardAssignedAtIso,
): { ok: true } | { ok: false; error: string } {
  const bag24Cutoff = new Date(bag24CutoffIso);
  if (machineJamAt.getTime() <= shiftEndAt.getTime()) {
    return {
      ok: false,
      error: "machine-jam-at must be strictly after shift-end-at",
    };
  }
  if (shiftEndAt.getTime() >= bag24Cutoff.getTime()) {
    return {
      ok: false,
      error: "shift-end-at must be strictly before Bag 24 CARD_ASSIGNED",
    };
  }
  if (machineJamAt.getTime() >= bag24Cutoff.getTime()) {
    return {
      ok: false,
      error: "machine-jam-at must be strictly before Bag 24 CARD_ASSIGNED",
    };
  }
  return { ok: true };
}

export function computePhase1BagSegmentTotal(
  shiftEndCount: number,
  machineJamCount: number,
): number {
  return shiftEndCount + machineJamCount;
}

export function computePhase1MaterialDeltas(
  shiftEndCount: number,
  machineJamCount: number,
): Phase1Proposal["materialDeltas"] {
  const total = computePhase1BagSegmentTotal(shiftEndCount, machineJamCount);
  return {
    legacyPvc02: total,
    legacyFoil01: total,
    pvc1: 0,
    pvc2: 0,
  };
}

export type Phase1ExistingState = {
  workflowBagId: string | null;
  workflowEvents: Array<{
    eventType: string;
    payload: Record<string, unknown>;
  }>;
  materialSegments: Array<{ count: number; lotId: string }>;
};

export function detectExistingPhase1Conflict(
  state: Phase1ExistingState,
  shiftEndCount: number,
  machineJamCount: number,
): string | null {
  const pause187 = state.workflowEvents.some(
    (e) =>
      e.eventType === "BAG_PAUSED" &&
      e.payload.reason === "shift_end" &&
      e.payload.counter_snapshot_count === shiftEndCount,
  );
  const pause18 = state.workflowEvents.some(
    (e) =>
      e.eventType === "BAG_PAUSED" &&
      e.payload.reason === "machine_jam" &&
      e.payload.counter_snapshot_count === machineJamCount,
  );
  if (pause187 || pause18) {
    return "Phase 1 workflow pause events already exist for this bag";
  }

  const seg187 = state.materialSegments.some((s) => s.count === shiftEndCount);
  const seg18 = state.materialSegments.some((s) => s.count === machineJamCount);
  if (seg187 || seg18) {
    return "Phase 1 material segments (187/18) already exist for this bag";
  }

  return null;
}

export function assertPhase1ProposalHasNoForbiddenActions(
  proposal: Pick<
    Phase1Proposal,
    "materialEvents" | "workflowEvents" | "nonActions"
  >,
  forbiddenPvcChangeCount: number = BAG45_PHASE1_DEFAULTS.forbiddenPvcChangeCount,
): void {
  for (const m of proposal.materialEvents) {
    if (m.counterSegmentCount === forbiddenPvcChangeCount) {
      throw new Error(`Forbidden: would insert PVC change segment ${forbiddenPvcChangeCount}`);
    }
    if (m.lotId === BAG45_PHASE1_DEFAULTS.pvc1LotId) {
      throw new Error("Forbidden: would insert material event on PVC-1 lot");
    }
    if (m.lotId === BAG45_PHASE1_DEFAULTS.pvc2LotId) {
      throw new Error("Forbidden: would insert material event on PVC-2 lot");
    }
  }
  const eventJson = JSON.stringify(proposal.workflowEvents);
  if (eventJson.includes(String(forbiddenPvcChangeCount))) {
    throw new Error(`Forbidden: proposal references count ${forbiddenPvcChangeCount}`);
  }
  if (
    proposal.materialEvents.some(
      (e) => e.eventType !== "ROLL_COUNTER_SEGMENT_RECORDED",
    )
  ) {
    throw new Error("Forbidden: only ROLL_COUNTER_SEGMENT_RECORDED allowed in Phase 1");
  }
}

export function buildPhase1Proposal(args: {
  card: Phase1Proposal["card"];
  inventoryBagId: string;
  tabletTypeId: string | null;
  shiftEndAt: Date;
  machineJamAt: Date;
  shiftEndCount: number;
  machineJamCount: number;
  existingWorkflowBagId: string | null;
  rollNumbers: { legacyPvc02: string; legacyFoil01: string };
}): Phase1Proposal {
  const cardAssignedAt = new Date(args.shiftEndAt.getTime() - 60_000);
  const shiftResumeAt = new Date(args.shiftEndAt.getTime() + 1_000);
  const jamResumeAt = new Date(args.machineJamAt.getTime() + 1_000);

  const workflowEvents: Phase1WorkflowEventSpec[] = [
    {
      eventType: "CARD_ASSIGNED",
      occurredAt: cardAssignedAt.toISOString(),
      payload: {
        qr_card_id: args.card.id,
        station_kind: "BLISTER",
        inventory_bag_id: args.inventoryBagId,
        ...(args.tabletTypeId ? { tablet_type_id: args.tabletTypeId } : {}),
        backfill_source: "live_ops.bag45_phase1",
      },
    },
    {
      eventType: "BAG_PAUSED",
      occurredAt: args.shiftEndAt.toISOString(),
      payload: {
        reason: "shift_end",
        counter_snapshot_count: args.shiftEndCount,
        counter_snapshot_reason: "SHIFT_END_SNAPSHOT",
        counter_snapshot_unit: "good_blisters_since_last_reset",
        counter_snapshot_source: "live_ops_backfill",
        backfill_source: "live_ops.bag45_phase1",
      },
    },
    {
      eventType: "BAG_RESUMED",
      occurredAt: shiftResumeAt.toISOString(),
      payload: { backfill_source: "live_ops.bag45_phase1" },
    },
    {
      eventType: "BAG_PAUSED",
      occurredAt: args.machineJamAt.toISOString(),
      payload: {
        reason: "machine_jam",
        counter_snapshot_count: args.machineJamCount,
        counter_snapshot_reason: "PAUSE_SNAPSHOT",
        counter_snapshot_unit: "good_blisters_since_last_reset",
        counter_snapshot_source: "live_ops_backfill",
        backfill_source: "live_ops.bag45_phase1",
      },
    },
    {
      eventType: "BAG_RESUMED",
      occurredAt: jamResumeAt.toISOString(),
      payload: { backfill_source: "live_ops.bag45_phase1" },
    },
  ];

  const materialEvents: Phase1MaterialEventSpec[] = [
    {
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      rollNumber: args.rollNumbers.legacyPvc02,
      lotId: BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
      counterSegmentCount: args.shiftEndCount,
      segmentReason: "SHIFT_END_SNAPSHOT",
      occurredAt: args.shiftEndAt.toISOString(),
    },
    {
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      rollNumber: args.rollNumbers.legacyFoil01,
      lotId: BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
      counterSegmentCount: args.shiftEndCount,
      segmentReason: "SHIFT_END_SNAPSHOT",
      occurredAt: args.shiftEndAt.toISOString(),
    },
    {
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      rollNumber: args.rollNumbers.legacyPvc02,
      lotId: BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
      counterSegmentCount: args.machineJamCount,
      segmentReason: "PAUSE_SNAPSHOT",
      occurredAt: args.machineJamAt.toISOString(),
    },
    {
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      rollNumber: args.rollNumbers.legacyFoil01,
      lotId: BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
      counterSegmentCount: args.machineJamCount,
      segmentReason: "PAUSE_SNAPSHOT",
      occurredAt: args.machineJamAt.toISOString(),
    },
  ];

  const proposal: Phase1Proposal = {
    card: args.card,
    inventoryBagId: args.inventoryBagId,
    workflowBagAction: args.existingWorkflowBagId ? "use_existing" : "create_new",
    workflowBagId: args.existingWorkflowBagId,
    workflowEvents,
    materialEvents,
    auditAction: "live_ops_backfill.bag45_phase1_apply",
    bagSegmentTotalAfter: computePhase1BagSegmentTotal(
      args.shiftEndCount,
      args.machineJamCount,
    ),
    materialDeltas: computePhase1MaterialDeltas(
      args.shiftEndCount,
      args.machineJamCount,
    ),
    nonActions: [
      "No 516 PVC change segment",
      "No PVC-1 ROLL_MOUNTED",
      "No Legacy PVC-02 ROLL_DEPLETED",
      "No Bag 24 workflow or material mutation",
      "No rebuildRollUsage / rebuildMaterialLotState (global roll state)",
    ],
    warnings: [
      "Material segment payloads use current roll lifetime sums at apply time; global rebuild deferred to Phase 2.",
    ],
  };

  assertPhase1ProposalHasNoForbiddenActions(proposal);
  return proposal;
}

async function loadRollNumbers(): Promise<{
  legacyPvc02: string;
  legacyFoil01: string;
}> {
  const rows = await db
    .select({ id: packagingLots.id, rollNumber: packagingLots.rollNumber })
    .from(packagingLots)
    .where(
      inArray(packagingLots.id, [
        BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
        BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
      ]),
    );
  const byId = new Map(rows.map((r) => [r.id, r.rollNumber]));
  const legacyPvc02 = byId.get(BAG45_PHASE1_DEFAULTS.legacyPvc02LotId);
  const legacyFoil01 = byId.get(BAG45_PHASE1_DEFAULTS.legacyFoil01LotId);
  if (!legacyPvc02 || !legacyFoil01) {
    throw new Error("Legacy PVC-02 or Legacy FOIL-01 lot not found");
  }
  return { legacyPvc02, legacyFoil01 };
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

async function loadExistingState(
  workflowBagId: string | null,
): Promise<Phase1ExistingState> {
  if (!workflowBagId) {
    return { workflowBagId: null, workflowEvents: [], materialSegments: [] };
  }
  const events = await db
    .select({
      eventType: workflowEvents.eventType,
      payload: workflowEvents.payload,
    })
    .from(workflowEvents)
    .where(eq(workflowEvents.workflowBagId, workflowBagId));

  type SegRow = { count: number; lotId: string };
  const segs = (await db.execute<SegRow>(sql`
    SELECT (payload->>'counter_segment_count')::int AS count,
           packaging_lot_id::text AS "lotId"
    FROM material_inventory_events
    WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND workflow_bag_id = ${workflowBagId}::uuid
  `)) as unknown as SegRow[];

  return {
    workflowBagId,
    workflowEvents: events.map((e) => ({
      eventType: e.eventType,
      payload: (e.payload ?? {}) as Record<string, unknown>,
    })),
    materialSegments: segs,
  };
}

async function insertExplicitRollSegment(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    machineId: string;
    lotId: string;
    packagingMaterialId: string;
    role: "PVC" | "FOIL";
    counterSegmentCount: number;
    segmentReason: "SHIFT_END_SNAPSHOT" | "PAUSE_SNAPSHOT";
    occurredAt: Date;
    sourceAction: string;
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
  `)) as unknown as CountRow[];
  const rollSegmentSequence = (rollPriorRows[0]?.n ?? 0) + 1;
  const rollTotalAfterSegment =
    (rollPriorRows[0]?.total ?? 0) + args.counterSegmentCount;

  await tx.insert(materialInventoryEvents).values({
    eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
    packagingMaterialId: args.packagingMaterialId,
    packagingLotId: args.lotId,
    workflowBagId: args.workflowBagId,
    machineId: args.machineId,
    stationId: args.stationId,
    quantityUnits: args.counterSegmentCount,
    unitOfMeasure: "blisters",
    occurredAt: args.occurredAt,
    source: "live_ops.bag45_phase1_backfill",
    payload: withAccountabilityPayload(
      {
        roll_role: args.role,
        material_lot_id: args.lotId,
        counter_segment_count: args.counterSegmentCount,
        segment_reason: args.segmentReason,
        bag_segment_sequence: bagSegmentSequence,
        roll_segment_sequence: rollSegmentSequence,
        active_bag_total_after_segment: activeBagTotalAfterSegment,
        roll_total_after_segment: rollTotalAfterSegment,
        workflow_bag_id: args.workflowBagId,
        machine_id: args.machineId,
        confidence: "HIGH",
        source_action: args.sourceAction,
        backfill_source: "live_ops.bag45_phase1",
        audit_reason: args.auditReason,
      },
      LIVE_OPS_ACCOUNTABILITY,
    ),
  });
}

function printProposal(proposal: Phase1Proposal, mode: "DRY-RUN" | "APPLY"): void {
  console.log(`=== Bag 45 Phase 1 backfill — ${mode} ===\n`);
  console.log("Card:", proposal.card);
  console.log("Inventory bag:", proposal.inventoryBagId);
  console.log("Workflow bag action:", proposal.workflowBagAction);
  console.log("\n--- Proposed workflow_events ---");
  for (const e of proposal.workflowEvents) {
    console.log(`  ${e.occurredAt}  ${e.eventType}`, e.payload);
  }
  console.log("\n--- Proposed material_inventory_events ---");
  for (const m of proposal.materialEvents) {
    console.log(
      `  ${m.occurredAt}  ${m.rollNumber}  seg=${m.counterSegmentCount}  ${m.segmentReason}`,
    );
  }
  console.log("\n--- Totals ---");
  console.log("  Bag 45 segment sum after:", proposal.bagSegmentTotalAfter);
  console.log("  Material deltas:", proposal.materialDeltas);
  console.log("\n--- Explicit non-actions ---");
  for (const line of proposal.nonActions) console.log("  -", line);
  console.log("\n--- Warnings ---");
  for (const w of proposal.warnings) console.log("  !", w);
}

export async function runBag45Phase1Backfill(
  opts: Bag45Phase1CliOptions,
): Promise<{ applied: boolean; proposal: Phase1Proposal | null; error?: string }> {
  const gate = validateApplyGate(opts);
  if (!gate.ok) {
    return { applied: false, proposal: null, error: gate.error };
  }

  const [card] = await db
    .select({
      id: qrCards.id,
      label: qrCards.label,
      scanToken: qrCards.scanToken,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      status: qrCards.status,
    })
    .from(qrCards)
    .where(eq(qrCards.scanToken, opts.workflowCardToken));
  if (!card) {
    return { applied: false, proposal: null, error: `QR card not found: ${opts.workflowCardToken}` };
  }

  const [inv] = await db
    .select({
      id: inventoryBags.id,
      tabletTypeId: inventoryBags.tabletTypeId,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.bagQrCode, opts.workflowCardToken));
  if (!inv || inv.id !== BAG45_PHASE1_DEFAULTS.expectedInventoryBagId) {
    return {
      applied: false,
      proposal: null,
      error: `inventory_bag_id mismatch: expected ${BAG45_PHASE1_DEFAULTS.expectedInventoryBagId}`,
    };
  }

  const existingState = await loadExistingState(card.assignedWorkflowBagId);
  const conflict = detectExistingPhase1Conflict(
    existingState,
    opts.shiftEndCount,
    opts.machineJamCount,
  );
  if (conflict) {
    return { applied: false, proposal: null, error: conflict };
  }

  if (opts.apply) {
    const ts = validatePhase1Timestamps(opts.shiftEndAt!, opts.machineJamAt!);
    if (!ts.ok) {
      return { applied: false, proposal: null, error: ts.error };
    }
  }

  const rollNumbers = await loadRollNumbers();
  const bag24Cutoff = new Date(BAG45_PHASE1_DEFAULTS.bag24CardAssignedAtIso);
  const previewShiftEnd =
    opts.shiftEndAt ?? new Date(bag24Cutoff.getTime() - 2 * 3_600_000);
  const previewJam =
    opts.machineJamAt ?? new Date(bag24Cutoff.getTime() - 3_600_000);

  const proposal = buildPhase1Proposal({
    card: {
      id: card.id,
      label: card.label,
      scanToken: card.scanToken,
      assignedWorkflowBagId: card.assignedWorkflowBagId,
    },
    inventoryBagId: inv.id,
    tabletTypeId: inv.tabletTypeId ?? null,
    shiftEndAt: opts.shiftEndAt ?? previewShiftEnd,
    machineJamAt: opts.machineJamAt ?? previewJam,
    shiftEndCount: opts.shiftEndCount,
    machineJamCount: opts.machineJamCount,
    existingWorkflowBagId: card.assignedWorkflowBagId,
    rollNumbers,
  });

  if (opts.shiftEndCount === BAG45_PHASE1_DEFAULTS.forbiddenPvcChangeCount) {
    return {
      applied: false,
      proposal: null,
      error: "Refusing: shift-end-count cannot be 516 in Phase 1",
    };
  }
  if (opts.machineJamCount === BAG45_PHASE1_DEFAULTS.forbiddenPvcChangeCount) {
    return {
      applied: false,
      proposal: null,
      error: "Refusing: machine-jam-count cannot be 516 in Phase 1",
    };
  }

  printProposal(proposal, opts.apply ? "APPLY" : "DRY-RUN");

  if (!opts.apply) {
    if (!opts.shiftEndAt || !opts.machineJamAt) {
      console.log(
        "\nNote: --shift-end-at / --machine-jam-at not supplied; showing placeholder times only.",
      );
    }
    console.log("\nNo writes performed (dry-run default).");
    return { applied: false, proposal };
  }

  const legacyPvcMaterialId = await loadLotMaterialId(
    BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
  );
  const legacyFoilMaterialId = await loadLotMaterialId(
    BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
  );

  let workflowBagId = card.assignedWorkflowBagId;

  await db.transaction(async (tx) => {
    if (!workflowBagId) {
      const [bag] = await tx
        .insert(workflowBags)
        .values({
          inventoryBagId: inv.id,
          startedAt: new Date(proposal.workflowEvents[0]!.occurredAt),
        })
        .returning({ id: workflowBags.id });
      if (!bag) throw new Error("Failed to create workflow_bag");
      workflowBagId = bag.id;
      await tx
        .update(qrCards)
        .set({ assignedWorkflowBagId: bag.id, status: "ASSIGNED" })
        .where(eq(qrCards.id, card.id));
    }

    if (workflowBagId === BAG45_PHASE1_DEFAULTS.bag24WorkflowBagId) {
      throw new Error("Refusing: would mutate Bag 24 workflow bag");
    }

    const stationId = BAG45_PHASE1_DEFAULTS.blisterStationId;
    const machineId = BAG45_PHASE1_DEFAULTS.blisterMachineId;
    const auditReason = opts.auditReason!;

    for (const spec of proposal.workflowEvents) {
      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType: spec.eventType as Parameters<typeof projectEvent>[1]["eventType"],
        payload: {
          ...spec.payload,
          audit_reason: auditReason,
        },
        occurredAt: new Date(spec.occurredAt),
        accountabilitySource: LIVE_OPS_ACCOUNTABILITY.accountabilitySource,
        accountableEmployeeNameSnapshot:
          LIVE_OPS_ACCOUNTABILITY.accountableEmployeeNameSnapshot,
      });
    }

    await insertExplicitRollSegment(tx, {
      workflowBagId,
      stationId,
      machineId,
      lotId: BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
      packagingMaterialId: legacyPvcMaterialId,
      role: "PVC",
      counterSegmentCount: opts.shiftEndCount,
      segmentReason: "SHIFT_END_SNAPSHOT",
      occurredAt: opts.shiftEndAt!,
      sourceAction: "shift_end_pause_snapshot",
      auditReason,
    });
    await insertExplicitRollSegment(tx, {
      workflowBagId,
      stationId,
      machineId,
      lotId: BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
      packagingMaterialId: legacyFoilMaterialId,
      role: "FOIL",
      counterSegmentCount: opts.shiftEndCount,
      segmentReason: "SHIFT_END_SNAPSHOT",
      occurredAt: opts.shiftEndAt!,
      sourceAction: "shift_end_pause_snapshot",
      auditReason,
    });
    await insertExplicitRollSegment(tx, {
      workflowBagId,
      stationId,
      machineId,
      lotId: BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
      packagingMaterialId: legacyPvcMaterialId,
      role: "PVC",
      counterSegmentCount: opts.machineJamCount,
      segmentReason: "PAUSE_SNAPSHOT",
      occurredAt: opts.machineJamAt!,
      sourceAction: "machine_jam_pause_snapshot",
      auditReason,
    });
    await insertExplicitRollSegment(tx, {
      workflowBagId,
      stationId,
      machineId,
      lotId: BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
      packagingMaterialId: legacyFoilMaterialId,
      role: "FOIL",
      counterSegmentCount: opts.machineJamCount,
      segmentReason: "PAUSE_SNAPSHOT",
      occurredAt: opts.machineJamAt!,
      sourceAction: "machine_jam_pause_snapshot",
      auditReason,
    });

    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: proposal.auditAction,
        targetType: "WorkflowBag",
        targetId: workflowBagId,
        after: {
          card_token: opts.workflowCardToken,
          inventory_bag_id: inv.id,
          shift_end_count: opts.shiftEndCount,
          machine_jam_count: opts.machineJamCount,
          shift_end_at: opts.shiftEndAt!.toISOString(),
          machine_jam_at: opts.machineJamAt!.toISOString(),
          audit_reason: auditReason,
          bag_segment_total: proposal.bagSegmentTotalAfter,
          phase: 1,
        },
      },
      tx,
    );
  });

  console.log("\nApply complete. workflow_bag_id:", workflowBagId);
  console.log(
    "Skipped rebuildRollUsage / rebuildMaterialLotState — run manually after Phase 2 if needed.",
  );

  return { applied: true, proposal };
}
