/**
 * Admin / live-ops — backfill a blister bag that was run on the floor
 * but never recorded (card scan, roll change, blister complete).
 * Dry-run by default. Restores read_station_live after apply so the
 * live floor board is not disturbed.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  materialInventoryEvents,
  packagingLots,
  qrCards,
  readStationLive,
  stations,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";
import { replayPackagingLotStatuses } from "@/lib/ops/bag45-phase2-pvc-timeline-apply";
import type { AccountabilityForEvent } from "@/lib/production/station-operator-session";
import { withAccountabilityPayload } from "@/lib/production/station-operator-session";
import { z } from "zod";

export const MISSED_BLISTER_BAG_CONFIRM_STRING =
  "APPLY_MISSED_BLISTER_BAG_BACKFILL" as const;

export const MISSED_BLISTER_BAG_AUDIT_ACTION =
  "live_ops_backfill.missed_blister_bag" as const;

const COMPANY_TZ = "America/New_York";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

const LIVE_OPS_ACCOUNTABILITY: AccountabilityForEvent = {
  enteredByUserId: null,
  accountableEmployeeId: null,
  accountabilitySource: "LEGACY_TEXT",
  accountableEmployeeNameSnapshot: "missed_bag_backfill",
  isStable: false,
};

export const missedBlisterBagInputSchema = z.object({
  workflowCardToken: z.string().min(1).max(80),
  receiptNumber: z.string().max(40).optional().nullable(),
  blisterStationId: z.string().uuid().optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  oldPvcRollNumber: z.string().min(1).max(80),
  newPvcRollNumber: z.string().min(1).max(80),
  rollChangeCounter: z.coerce.number().int().positive(),
  blisterCompleteCounter: z.coerce.number().int().positive(),
  rollChangeDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  rollChangeTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .nullable(),
  auditReason: z.string().min(10).max(500),
});

export type MissedBlisterBagInput = z.infer<typeof missedBlisterBagInputSchema>;

export type MissedBlisterBagCliOptions = MissedBlisterBagInput & {
  apply: boolean;
  confirm: string | null;
};

export type MissedBlisterBagProposal = {
  card: {
    id: string;
    label: string;
    scanToken: string;
    assignedWorkflowBagId: string | null;
  };
  inventoryBagId: string;
  receiptNumber: string | null;
  blisterStationId: string;
  blisterMachineId: string;
  workflowBagAction: "create_new" | "use_existing";
  workflowBagId: string | null;
  oldPvcLot: { id: string; rollNumber: string };
  newPvcLot: { id: string; rollNumber: string };
  foilLot: { id: string; rollNumber: string };
  timestamps: {
    startedAt: string;
    rollChangeAt: string;
    rollChangeEstimated: boolean;
    completedAt: string;
    releasedAt: string;
  };
  bagSegmentTotal: number;
  workflowEvents: Array<{
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }>;
  materialEvents: Array<{
    eventType: string;
    rollNumber: string;
    lotId: string;
    segmentCount: number | null;
    segmentReason: string | null;
    occurredAt: string;
  }>;
  warnings: string[];
};

function readFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

export function parseMissedBlisterBagCli(argv: string[]): MissedBlisterBagCliOptions {
  const parsed = missedBlisterBagInputSchema.parse({
    workflowCardToken:
      readFlag(argv, "--workflow-card-token") ?? "bag-card-18",
    receiptNumber: readFlag(argv, "--receipt-number") ?? null,
    blisterStationId: readFlag(argv, "--blister-station-id") ?? null,
    startDate: readFlag(argv, "--start-date") ?? "2026-06-10",
    startTime: readFlag(argv, "--start-time") ?? "07:11",
    endDate: readFlag(argv, "--end-date") ?? "2026-06-10",
    endTime: readFlag(argv, "--end-time") ?? "09:12",
    oldPvcRollNumber: readFlag(argv, "--old-pvc-roll") ?? "16",
    newPvcRollNumber: readFlag(argv, "--new-pvc-roll") ?? "17",
    rollChangeCounter: readFlag(argv, "--roll-change-counter") ?? "1630",
    blisterCompleteCounter: readFlag(argv, "--blister-complete-counter") ?? "856",
    rollChangeDate: readFlag(argv, "--roll-change-date") ?? null,
    rollChangeTime: readFlag(argv, "--roll-change-time") ?? null,
    auditReason:
      readFlag(argv, "--audit-reason") ??
      "Operator could not record bag on blister floor PWA",
  });
  return {
    ...parsed,
    apply: argv.includes("--apply"),
    confirm: readFlag(argv, "--confirm") ?? null,
  };
}

export function validateMissedBlisterBagApplyGate(
  opts: Pick<MissedBlisterBagCliOptions, "apply" | "confirm" | "auditReason">,
): { ok: true } | { ok: false; error: string } {
  if (!opts.apply) return { ok: true };
  if (opts.confirm !== MISSED_BLISTER_BAG_CONFIRM_STRING) {
    return {
      ok: false,
      error: `Apply requires confirm phrase ${MISSED_BLISTER_BAG_CONFIRM_STRING}`,
    };
  }
  if (!opts.auditReason?.trim()) {
    return { ok: false, error: "Apply requires audit reason" };
  }
  return { ok: true };
}

/** Wall-clock in an IANA timezone → UTC Date. */
export function wallClockToUtcInTz(
  dateStr: string,
  timeStr: string,
  timeZone = COMPANY_TZ,
): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  if (
    year == null ||
    month == null ||
    day == null ||
    hour == null ||
    minute == null ||
    [year, month, day, hour, minute].some((n) => Number.isNaN(n))
  ) {
    throw new Error(`Invalid date/time: ${dateStr} ${timeStr}`);
  }
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  let guess = desiredUtc;
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === type)?.value);
    const localAsUtc = Date.UTC(
      get("year")!,
      get("month")! - 1,
      get("day")!,
      get("hour")! % 24,
      get("minute")!,
      0,
    );
    guess += desiredUtc - localAsUtc;
  }
  return new Date(guess);
}

export function resolveRollChangeTimestamp(input: {
  startedAt: Date;
  completedAt: Date;
  rollChangeDate?: string | null;
  rollChangeTime?: string | null;
}): { at: Date; estimated: boolean } {
  if (input.rollChangeDate && input.rollChangeTime) {
    return {
      at: wallClockToUtcInTz(input.rollChangeDate, input.rollChangeTime),
      estimated: false,
    };
  }
  const midpoint = new Date(
    (input.startedAt.getTime() + input.completedAt.getTime()) / 2,
  );
  return { at: midpoint, estimated: true };
}

export function rollNumberLookupCandidates(raw: string, role: "PVC" | "FOIL"): string[] {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  const digits = trimmed.replace(/\D/g, "");
  const candidates = new Set<string>();
  candidates.add(trimmed);
  candidates.add(upper);
  if (digits) {
    candidates.add(`${role}-${digits}`);
    candidates.add(`${role}-${digits.padStart(3, "0")}`);
    candidates.add(digits);
    candidates.add(digits.padStart(3, "0"));
  }
  return [...candidates];
}

export function computeBagSegmentTotal(
  rollChangeCounter: number,
  blisterCompleteCounter: number,
): number {
  return rollChangeCounter + blisterCompleteCounter;
}

export function detectExistingMissedBagConflict(events: Array<{
  eventType: string;
}>): string | null {
  if (events.some((e) => e.eventType === "BLISTER_COMPLETE")) {
    return "Bag already has BLISTER_COMPLETE — refusing duplicate backfill";
  }
  if (events.some((e) => e.eventType === "CARD_ASSIGNED")) {
    return "Bag already has CARD_ASSIGNED — use material recovery for partial fixes";
  }
  return null;
}

export function buildMissedBlisterBagProposal(args: {
  card: MissedBlisterBagProposal["card"];
  inventoryBagId: string;
  receiptNumber: string | null;
  tabletTypeId: string | null;
  blisterStationId: string;
  blisterMachineId: string;
  existingWorkflowBagId: string | null;
  oldPvcLot: MissedBlisterBagProposal["oldPvcLot"];
  newPvcLot: MissedBlisterBagProposal["newPvcLot"];
  foilLot: MissedBlisterBagProposal["foilLot"];
  startedAt: Date;
  rollChangeAt: Date;
  rollChangeEstimated: boolean;
  completedAt: Date;
  rollChangeCounter: number;
  blisterCompleteCounter: number;
  auditReason: string;
}): MissedBlisterBagProposal {
  const releasedAt = new Date(args.completedAt.getTime() + 1_000);
  const bagSegmentTotal = computeBagSegmentTotal(
    args.rollChangeCounter,
    args.blisterCompleteCounter,
  );

  const workflowEvents: MissedBlisterBagProposal["workflowEvents"] = [
    {
      eventType: "CARD_ASSIGNED",
      occurredAt: args.startedAt.toISOString(),
      payload: {
        qr_card_id: args.card.id,
        station_kind: "BLISTER",
        inventory_bag_id: args.inventoryBagId,
        ...(args.tabletTypeId ? { tablet_type_id: args.tabletTypeId } : {}),
        backfill_source: "missed_blister_bag_backfill",
        audit_reason: args.auditReason,
      },
    },
    {
      eventType: "BLISTER_COMPLETE",
      occurredAt: args.completedAt.toISOString(),
      payload: {
        count_total: args.blisterCompleteCounter,
        backfill_source: "missed_blister_bag_backfill",
        audit_reason: args.auditReason,
      },
    },
    {
      eventType: "BAG_RELEASED",
      occurredAt: releasedAt.toISOString(),
      payload: {
        station_kind: "BLISTER",
        released_at_stage: "BLISTERED",
        backfill_source: "missed_blister_bag_backfill",
        audit_reason: args.auditReason,
      },
    },
  ];

  const materialEvents: MissedBlisterBagProposal["materialEvents"] = [
    {
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      rollNumber: args.oldPvcLot.rollNumber,
      lotId: args.oldPvcLot.id,
      segmentCount: args.rollChangeCounter,
      segmentReason: "ROLL_CHANGE",
      occurredAt: args.rollChangeAt.toISOString(),
    },
    {
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      rollNumber: args.foilLot.rollNumber,
      lotId: args.foilLot.id,
      segmentCount: args.rollChangeCounter,
      segmentReason: "ROLL_CHANGE",
      occurredAt: args.rollChangeAt.toISOString(),
    },
    {
      eventType: "ROLL_DEPLETED",
      rollNumber: args.oldPvcLot.rollNumber,
      lotId: args.oldPvcLot.id,
      segmentCount: null,
      segmentReason: null,
      occurredAt: args.rollChangeAt.toISOString(),
    },
    {
      eventType: "ROLL_MOUNTED",
      rollNumber: args.newPvcLot.rollNumber,
      lotId: args.newPvcLot.id,
      segmentCount: null,
      segmentReason: null,
      occurredAt: args.rollChangeAt.toISOString(),
    },
  ];

  const warnings: string[] = [
    "read_station_live for the blister station is snapshotted and restored after apply.",
    "Roll change time was estimated at the midpoint between start and end.",
    "BLISTER_COMPLETE count is the post-roll-change segment only (856), not bag total.",
    `Bag total blister segments after backfill: ${bagSegmentTotal} (${args.rollChangeCounter} + ${args.blisterCompleteCounter}).`,
  ].filter((w, i) => i !== 1 || args.rollChangeEstimated);

  return {
    card: args.card,
    inventoryBagId: args.inventoryBagId,
    receiptNumber: args.receiptNumber,
    blisterStationId: args.blisterStationId,
    blisterMachineId: args.blisterMachineId,
    workflowBagAction: args.existingWorkflowBagId ? "use_existing" : "create_new",
    workflowBagId: args.existingWorkflowBagId,
    oldPvcLot: args.oldPvcLot,
    newPvcLot: args.newPvcLot,
    foilLot: args.foilLot,
    timestamps: {
      startedAt: args.startedAt.toISOString(),
      rollChangeAt: args.rollChangeAt.toISOString(),
      rollChangeEstimated: args.rollChangeEstimated,
      completedAt: args.completedAt.toISOString(),
      releasedAt: releasedAt.toISOString(),
    },
    bagSegmentTotal,
    workflowEvents,
    materialEvents,
    warnings,
  };
}

async function resolveBlisterStation(
  blisterStationId: string | null | undefined,
): Promise<{ id: string; machineId: string }> {
  if (blisterStationId) {
    const [row] = await db
      .select({ id: stations.id, machineId: stations.machineId })
      .from(stations)
      .where(eq(stations.id, blisterStationId));
    if (!row?.machineId) {
      throw new Error(`Blister station ${blisterStationId} not found or has no machine`);
    }
    return { id: row.id, machineId: row.machineId };
  }
  const [row] = await db
    .select({ id: stations.id, machineId: stations.machineId })
    .from(stations)
    .where(eq(stations.kind, "BLISTER"));
  if (!row?.machineId) {
    throw new Error("No BLISTER station with a bound machine found");
  }
  return { id: row.id, machineId: row.machineId };
}

async function findRollLotByNumber(
  raw: string,
  role: "PVC" | "FOIL",
): Promise<{ id: string; rollNumber: string; packagingMaterialId: string } | null> {
  const candidates = rollNumberLookupCandidates(raw, role);
  const rows = await db
    .select({
      id: packagingLots.id,
      rollNumber: packagingLots.rollNumber,
      packagingMaterialId: packagingLots.packagingMaterialId,
    })
    .from(packagingLots)
    .where(inArray(packagingLots.rollNumber, candidates));
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const row = rows[0]!;
    return {
      id: row.id,
      rollNumber: row.rollNumber ?? raw,
      packagingMaterialId: row.packagingMaterialId,
    };
  }
  const exact = rows.find((r) => candidates.includes(r.rollNumber ?? ""));
  const row = exact ?? rows[0]!;
  return {
    id: row.id,
    rollNumber: row.rollNumber ?? raw,
    packagingMaterialId: row.packagingMaterialId,
  };
}

async function findFoilAtBoundary(
  machineId: string,
  boundaryAt: Date,
): Promise<{ id: string; rollNumber: string; packagingMaterialId: string } | null> {
  type Row = {
    packaging_lot_id: string;
    roll_number: string;
    packaging_material_id: string;
    role: string;
  };
  const rows = (await db.execute<Row>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id,
        ev.event_type,
        ev.machine_id,
        ev.payload,
        ev.occurred_at
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_DEPLETED')
        AND ev.occurred_at <= ${boundaryAt.toISOString()}::timestamptz
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT
      lot.id::text AS packaging_lot_id,
      lot.roll_number,
      lot.packaging_material_id::text AS packaging_material_id,
      COALESCE(
        (le.payload->>'roll_role'),
        CASE pm.kind::text
          WHEN 'FOIL_ROLL' THEN 'FOIL'
          WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END
      ) AS role
    FROM packaging_lots lot
    JOIN packaging_materials pm ON pm.id = lot.packaging_material_id
    JOIN latest_event le ON le.packaging_lot_id = lot.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND le.machine_id = ${machineId}::uuid
      AND COALESCE(
        (le.payload->>'roll_role'),
        CASE pm.kind::text
          WHEN 'FOIL_ROLL' THEN 'FOIL'
          WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END
      ) = 'FOIL'
    LIMIT 1
  `)) as unknown as Row[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.packaging_lot_id,
    rollNumber: row.roll_number,
    packagingMaterialId: row.packaging_material_id,
  };
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

async function insertRollChangeSegment(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    machineId: string;
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
    machineId: args.machineId,
    stationId: args.stationId,
    quantityUnits: args.counterSegmentCount,
    unitOfMeasure: "blisters",
    occurredAt: args.occurredAt,
    source: "missed_blister_bag_backfill",
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
        machine_id: args.machineId,
        confidence: "HIGH",
        segment_group_id: args.segmentGroupId,
        source_action: "missed_blister_bag_roll_change",
        backfill_source: "missed_blister_bag_backfill",
        audit_reason: args.auditReason,
      },
      LIVE_OPS_ACCOUNTABILITY,
    ),
  });
}

export async function loadMissedBlisterBagProposal(
  input: MissedBlisterBagInput,
): Promise<{ proposal: MissedBlisterBagProposal | null; error?: string }> {
  const startedAt = wallClockToUtcInTz(input.startDate, input.startTime);
  const completedAt = wallClockToUtcInTz(input.endDate, input.endTime);
  if (completedAt.getTime() <= startedAt.getTime()) {
    return { proposal: null, error: "End time must be after start time" };
  }
  const rollChange = resolveRollChangeTimestamp({
    startedAt,
    completedAt,
    ...(input.rollChangeDate != null ? { rollChangeDate: input.rollChangeDate } : {}),
    ...(input.rollChangeTime != null ? { rollChangeTime: input.rollChangeTime } : {}),
  });
  if (
    rollChange.at.getTime() <= startedAt.getTime() ||
    rollChange.at.getTime() >= completedAt.getTime()
  ) {
    return {
      proposal: null,
      error: "Roll change time must fall strictly between start and end",
    };
  }

  const [card] = await db
    .select({
      id: qrCards.id,
      label: qrCards.label,
      scanToken: qrCards.scanToken,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
    })
    .from(qrCards)
    .where(eq(qrCards.scanToken, input.workflowCardToken));
  if (!card) {
    return { proposal: null, error: `QR card not found: ${input.workflowCardToken}` };
  }

  const [inv] = await db
    .select({
      id: inventoryBags.id,
      tabletTypeId: inventoryBags.tabletTypeId,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.bagQrCode, input.workflowCardToken));
  if (!inv) {
    return {
      proposal: null,
      error: `Inventory bag not found for card token ${input.workflowCardToken}`,
    };
  }
  if (
    input.receiptNumber &&
    inv.internalReceiptNumber &&
    inv.internalReceiptNumber !== input.receiptNumber
  ) {
    return {
      proposal: null,
      error: `Receipt mismatch: inventory has ${inv.internalReceiptNumber}, input ${input.receiptNumber}`,
    };
  }

  const blister = await resolveBlisterStation(input.blisterStationId);
  const oldPvc = await findRollLotByNumber(input.oldPvcRollNumber, "PVC");
  const newPvc = await findRollLotByNumber(input.newPvcRollNumber, "PVC");
  if (!oldPvc) {
    return {
      proposal: null,
      error: `Old PVC roll not found for input: ${input.oldPvcRollNumber}`,
    };
  }
  if (!newPvc) {
    return {
      proposal: null,
      error: `New PVC roll not found for input: ${input.newPvcRollNumber}`,
    };
  }
  if (oldPvc.id === newPvc.id) {
    return { proposal: null, error: "Old and new PVC rolls must be different lots" };
  }

  const foil = await findFoilAtBoundary(blister.machineId, rollChange.at);
  if (!foil) {
    return {
      proposal: null,
      error:
        "Could not resolve FOIL roll mounted on the blister machine at roll-change time",
    };
  }

  const workflowBagId = card.assignedWorkflowBagId;
  const existingEvents = workflowBagId
    ? await db
        .select({ eventType: workflowEvents.eventType })
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowBagId, workflowBagId))
    : [];
  const conflict = detectExistingMissedBagConflict(existingEvents);
  if (conflict) {
    return { proposal: null, error: conflict };
  }

  const proposal = buildMissedBlisterBagProposal({
    card: {
      id: card.id,
      label: card.label,
      scanToken: card.scanToken,
      assignedWorkflowBagId: card.assignedWorkflowBagId,
    },
    inventoryBagId: inv.id,
    receiptNumber: inv.internalReceiptNumber ?? input.receiptNumber ?? null,
    tabletTypeId: inv.tabletTypeId ?? null,
    blisterStationId: blister.id,
    blisterMachineId: blister.machineId,
    existingWorkflowBagId: workflowBagId,
    oldPvcLot: { id: oldPvc.id, rollNumber: oldPvc.rollNumber },
    newPvcLot: { id: newPvc.id, rollNumber: newPvc.rollNumber },
    foilLot: { id: foil.id, rollNumber: foil.rollNumber },
    startedAt,
    rollChangeAt: rollChange.at,
    rollChangeEstimated: rollChange.estimated,
    completedAt,
    rollChangeCounter: input.rollChangeCounter,
    blisterCompleteCounter: input.blisterCompleteCounter,
    auditReason: input.auditReason,
  });

  return { proposal };
}

export async function runMissedBlisterBagBackfill(
  opts: MissedBlisterBagCliOptions,
): Promise<{
  applied: boolean;
  proposal: MissedBlisterBagProposal | null;
  error?: string;
}> {
  const gate = validateMissedBlisterBagApplyGate(opts);
  if (!gate.ok) {
    return { applied: false, proposal: null, error: gate.error };
  }

  const loaded = await loadMissedBlisterBagProposal(opts);
  if (!loaded.proposal) {
    return {
      applied: false,
      proposal: null,
      ...(loaded.error ? { error: loaded.error } : {}),
    };
  }
  const proposal = loaded.proposal;

  if (!opts.apply) {
    return { applied: false, proposal };
  }

  const startedAt = new Date(proposal.timestamps.startedAt);
  const rollChangeAt = new Date(proposal.timestamps.rollChangeAt);
  const completedAt = new Date(proposal.timestamps.completedAt);
  const releasedAt = new Date(proposal.timestamps.releasedAt);
  const segmentGroupId = randomUUID();

  const oldPvcMaterialId = await loadLotMaterialId(proposal.oldPvcLot.id);
  const newPvcMaterialId = await loadLotMaterialId(proposal.newPvcLot.id);
  const foilMaterialId = await loadLotMaterialId(proposal.foilLot.id);

  const [oldLot] = await db
    .select({ netWeightGrams: packagingLots.netWeightGrams, status: packagingLots.status })
    .from(packagingLots)
    .where(eq(packagingLots.id, proposal.oldPvcLot.id));
  const [newLot] = await db
    .select({ netWeightGrams: packagingLots.netWeightGrams, status: packagingLots.status })
    .from(packagingLots)
    .where(eq(packagingLots.id, proposal.newPvcLot.id));

  const [stationLiveBefore] = await db
    .select()
    .from(readStationLive)
    .where(eq(readStationLive.stationId, proposal.blisterStationId));

  let workflowBagId = proposal.workflowBagId;

  await db.transaction(async (tx) => {
    if (!workflowBagId) {
      const [bag] = await tx
        .insert(workflowBags)
        .values({
          inventoryBagId: proposal.inventoryBagId,
          receiptNumber: proposal.receiptNumber,
          startedAt,
        })
        .returning({ id: workflowBags.id });
      if (!bag) throw new Error("Failed to create workflow_bag");
      workflowBagId = bag.id;
      await tx
        .update(qrCards)
        .set({ assignedWorkflowBagId: bag.id, status: "ASSIGNED" })
        .where(eq(qrCards.id, proposal.card.id));
    }

    const cardAssigned = proposal.workflowEvents.find(
      (e) => e.eventType === "CARD_ASSIGNED",
    );
    if (!cardAssigned) throw new Error("Proposal missing CARD_ASSIGNED");
    await projectEvent(tx, {
      workflowBagId,
      stationId: proposal.blisterStationId,
      eventType: "CARD_ASSIGNED",
      payload: cardAssigned.payload,
      occurredAt: new Date(cardAssigned.occurredAt),
      accountabilitySource: LIVE_OPS_ACCOUNTABILITY.accountabilitySource,
      accountableEmployeeNameSnapshot:
        LIVE_OPS_ACCOUNTABILITY.accountableEmployeeNameSnapshot,
    });

    await insertRollChangeSegment(tx, {
      workflowBagId,
      stationId: proposal.blisterStationId,
      machineId: proposal.blisterMachineId,
      lotId: proposal.oldPvcLot.id,
      packagingMaterialId: oldPvcMaterialId,
      role: "PVC",
      counterSegmentCount: opts.rollChangeCounter,
      occurredAt: rollChangeAt,
      segmentGroupId,
      auditReason: opts.auditReason,
    });
    await insertRollChangeSegment(tx, {
      workflowBagId,
      stationId: proposal.blisterStationId,
      machineId: proposal.blisterMachineId,
      lotId: proposal.foilLot.id,
      packagingMaterialId: foilMaterialId,
      role: "FOIL",
      counterSegmentCount: opts.rollChangeCounter,
      occurredAt: rollChangeAt,
      segmentGroupId,
      auditReason: opts.auditReason,
    });

    type SumRow = { total: number };
    const [legacyYieldRow] = (await tx.execute<SumRow>(sql`
      SELECT COALESCE(SUM((payload->>'counter_segment_count')::int), 0)::int AS total
      FROM material_inventory_events
      WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
        AND packaging_lot_id = ${proposal.oldPvcLot.id}::uuid
        AND occurred_at <= ${rollChangeAt.toISOString()}::timestamptz
    `)) as unknown as SumRow[];
    const legacyFinalYield =
      (legacyYieldRow?.total ?? 0) + opts.rollChangeCounter;
    const legacyGramsPerBlister =
      oldLot?.netWeightGrams != null && legacyFinalYield > 0
        ? oldLot.netWeightGrams / legacyFinalYield
        : null;

    await tx.insert(materialInventoryEvents).values({
      eventType: "ROLL_DEPLETED",
      packagingMaterialId: oldPvcMaterialId,
      packagingLotId: proposal.oldPvcLot.id,
      workflowBagId,
      machineId: proposal.blisterMachineId,
      stationId: proposal.blisterStationId,
      occurredAt: rollChangeAt,
      unitOfMeasure: "g",
      source: "missed_blister_bag_backfill",
      payload: withAccountabilityPayload(
        {
          roll_role: "PVC",
          material_lot_id: proposal.oldPvcLot.id,
          final_roll_yield_blisters: legacyFinalYield,
          net_weight_grams: oldLot?.netWeightGrams ?? null,
          grams_per_blister: legacyGramsPerBlister,
          depleted_during_bag: true,
          workflow_bag_id: workflowBagId,
          confidence: legacyGramsPerBlister != null ? "HIGH" : "MEDIUM",
          segment_group_id: segmentGroupId,
          source_action: "missed_blister_bag_roll_change",
          backfill_source: "missed_blister_bag_backfill",
          audit_reason: opts.auditReason,
        },
        LIVE_OPS_ACCOUNTABILITY,
      ),
    });

    await tx.insert(materialInventoryEvents).values({
      eventType: "ROLL_MOUNTED",
      packagingMaterialId: newPvcMaterialId,
      packagingLotId: proposal.newPvcLot.id,
      workflowBagId,
      machineId: proposal.blisterMachineId,
      stationId: proposal.blisterStationId,
      occurredAt: rollChangeAt,
      unitOfMeasure: "g",
      source: "missed_blister_bag_backfill",
      payload: withAccountabilityPayload(
        {
          roll_role: "PVC",
          starting_weight_grams: newLot?.netWeightGrams ?? null,
          previous_status: newLot?.status ?? "AVAILABLE",
          mounted_via: "ROLL_CHANGE",
          segment_group_id: segmentGroupId,
          source_action: "missed_blister_bag_roll_change",
          backfill_source: "missed_blister_bag_backfill",
          audit_reason: opts.auditReason,
        },
        LIVE_OPS_ACCOUNTABILITY,
      ),
    });

    for (const spec of proposal.workflowEvents.filter(
      (e) => e.eventType !== "CARD_ASSIGNED",
    )) {
      await projectEvent(tx, {
        workflowBagId,
        stationId: proposal.blisterStationId,
        eventType: spec.eventType as Parameters<typeof projectEvent>[1]["eventType"],
        payload: spec.payload,
        occurredAt: new Date(spec.occurredAt),
        accountabilitySource: LIVE_OPS_ACCOUNTABILITY.accountabilitySource,
        accountableEmployeeNameSnapshot:
          LIVE_OPS_ACCOUNTABILITY.accountableEmployeeNameSnapshot,
      });
    }

    await replayPackagingLotStatuses(tx, [
      proposal.oldPvcLot.id,
      proposal.newPvcLot.id,
      proposal.foilLot.id,
    ]);
    await rebuildRollUsage(tx);
    await rebuildMaterialLotState(tx);

    if (stationLiveBefore) {
      await tx
        .insert(readStationLive)
        .values({
          stationId: stationLiveBefore.stationId,
          currentWorkflowBagId: stationLiveBefore.currentWorkflowBagId,
          lastEventType: stationLiveBefore.lastEventType,
          lastEventAt: stationLiveBefore.lastEventAt,
          updatedAt: stationLiveBefore.updatedAt,
        })
        .onConflictDoUpdate({
          target: readStationLive.stationId,
          set: {
            currentWorkflowBagId: stationLiveBefore.currentWorkflowBagId,
            lastEventType: stationLiveBefore.lastEventType,
            lastEventAt: stationLiveBefore.lastEventAt,
            updatedAt: stationLiveBefore.updatedAt,
          },
        });
    } else {
      await tx
        .update(readStationLive)
        .set({
          currentWorkflowBagId: null,
          lastEventType: "BAG_RELEASED",
          lastEventAt: releasedAt,
          updatedAt: releasedAt,
        })
        .where(
          and(
            eq(readStationLive.stationId, proposal.blisterStationId),
            eq(readStationLive.currentWorkflowBagId, workflowBagId),
          ),
        );
    }

    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: MISSED_BLISTER_BAG_AUDIT_ACTION,
        targetType: "WorkflowBag",
        targetId: workflowBagId,
        after: {
          card_token: opts.workflowCardToken,
          receipt_number: proposal.receiptNumber,
          roll_change_counter: opts.rollChangeCounter,
          blister_complete_counter: opts.blisterCompleteCounter,
          bag_segment_total: proposal.bagSegmentTotal,
          old_pvc_roll: proposal.oldPvcLot.rollNumber,
          new_pvc_roll: proposal.newPvcLot.rollNumber,
          audit_reason: opts.auditReason,
          timestamps: proposal.timestamps,
        },
      },
      tx,
    );
  });

  return { applied: true, proposal };
}

export function formatMissedBlisterBagProposal(
  proposal: MissedBlisterBagProposal,
  mode: "DRY-RUN" | "APPLY",
): string {
  const lines: string[] = [];
  lines.push(`=== Missed blister bag backfill — ${mode} ===`);
  lines.push(`Card: ${proposal.card.scanToken} (${proposal.card.label})`);
  lines.push(`Receipt: ${proposal.receiptNumber ?? "—"}`);
  lines.push(`Workflow bag: ${proposal.workflowBagAction}`);
  lines.push(`Bag segment total: ${proposal.bagSegmentTotal}`);
  lines.push("");
  lines.push("Timestamps (UTC):");
  lines.push(`  start: ${proposal.timestamps.startedAt}`);
  lines.push(
    `  roll change: ${proposal.timestamps.rollChangeAt}${proposal.timestamps.rollChangeEstimated ? " (estimated midpoint)" : ""}`,
  );
  lines.push(`  blister complete: ${proposal.timestamps.completedAt}`);
  lines.push("");
  lines.push("Rolls:");
  lines.push(`  old PVC: ${proposal.oldPvcLot.rollNumber}`);
  lines.push(`  new PVC: ${proposal.newPvcLot.rollNumber}`);
  lines.push(`  foil @ change: ${proposal.foilLot.rollNumber}`);
  lines.push("");
  lines.push("Workflow events:");
  for (const e of proposal.workflowEvents) {
    lines.push(`  ${e.occurredAt} ${e.eventType}`);
  }
  lines.push("");
  lines.push("Material events:");
  for (const m of proposal.materialEvents) {
    lines.push(
      `  ${m.occurredAt} ${m.eventType} ${m.rollNumber} seg=${m.segmentCount ?? "—"}`,
    );
  }
  if (proposal.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of proposal.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}
