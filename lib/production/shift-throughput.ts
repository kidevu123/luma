// Shift-scoped throughput — counts since 6am local from workflow_events
// (source of truth) with read_daily_throughput / read_bag_metrics as
// cross-checks. Fixes floor board showing 0 while stations are running.

import { eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  readBagMetrics,
  readDailyThroughput,
  readBagState,
  readStationLive,
  workflowEvents,
} from "@/lib/db/schema";
import { computeShiftProgress } from "@/lib/production/floor-command";
import { floorThroughputDayKey } from "@/lib/projector/index";
import { ymdInTz } from "@/lib/production/time";

export type ShiftActivityMetrics = {
  /** Local calendar day used for read_daily_throughput lookups. */
  throughputDayKey: string;
  shiftStartUtc: string;
  bagsInFlow: number;
  atStation: number;
  /** Stage completions since shift start (workflow_events). */
  blisteredShift: number;
  sealedShift: number;
  packagedShift: number;
  /** Bags finalized since shift start. */
  finalizedShift: number;
  unitsFinalizedShift: number;
  displaysShift: number;
  casesShift: number;
  /** Active bags scanned at a station right now. */
  activeOnFloor: number;
};

const BLISTER_EVENTS = sql`ARRAY[
  'BLISTER_COMPLETE',
  'HANDPACK_BLISTER_COMPLETE',
  'BOTTLE_HANDPACK_COMPLETE'
]::text[]`;

const SEAL_EVENTS = sql`ARRAY[
  'SEALING_COMPLETE',
  'BOTTLE_CAP_SEAL_COMPLETE'
]::text[]`;

const PACK_EVENTS = sql`ARRAY[
  'PACKAGING_SNAPSHOT',
  'PACKAGING_COMPLETE',
  'BOTTLE_STICKER_COMPLETE'
]::text[]`;

export async function loadShiftActivityMetrics(
  tz: string,
): Promise<ShiftActivityMetrics> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);
  const shiftStartIso = shiftStartUtc.toISOString();
  const throughputDayKey = floorThroughputDayKey(now);

  const [stageRow, finalizedRow, throughputRow, wipRow, activeRow] =
    await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE we.event_type::text = ANY(${BLISTER_EVENTS})
          )::int AS blistered,
          COUNT(*) FILTER (
            WHERE we.event_type::text = ANY(${SEAL_EVENTS})
              AND NOT (
                we.event_type::text = 'SEALING_COMPLETE'
                AND COALESCE(we.payload->>'partial_close', 'false') = 'true'
              )
          )::int AS sealed,
          COUNT(*) FILTER (
            WHERE we.event_type::text = ANY(${PACK_EVENTS})
              AND NOT (
                we.event_type::text = 'PACKAGING_COMPLETE'
                AND COALESCE(we.payload->>'partial_packaging', 'false') = 'true'
              )
          )::int AS packaged
        FROM workflow_events we
        WHERE we.occurred_at >= ${shiftStartIso}::timestamptz
      `),
      db
        .select({
          bags: sql<number>`COUNT(*)::int`,
          units: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
          displays: sql<number>`COALESCE(SUM(${readBagMetrics.displaysMade}), 0)::int`,
          cases: sql<number>`COALESCE(SUM(${readBagMetrics.masterCases}), 0)::int`,
        })
        .from(readBagMetrics)
        .where(gte(readBagMetrics.finalizedAt, shiftStartUtc)),
      db
        .select({
          blistered: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsBlistered}), 0)::int`,
          sealed: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsSealed}), 0)::int`,
          packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}), 0)::int`,
          finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}), 0)::int`,
          units: sql<number>`COALESCE(SUM(${readDailyThroughput.unitsProduced}), 0)::int`,
          displays: sql<number>`COALESCE(SUM(${readDailyThroughput.displaysProduced}), 0)::int`,
          cases: sql<number>`COALESCE(SUM(${readDailyThroughput.casesProduced}), 0)::int`,
        })
        .from(readDailyThroughput)
        .where(eq(readDailyThroughput.day, sql`${throughputDayKey}::date`)),
      db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(readBagState)
        .where(eq(readBagState.isFinalized, false)),
      db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(readStationLive)
        .where(sql`${readStationLive.currentWorkflowBagId} IS NOT NULL`),
    ]);

  const stage = (stageRow as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};
  const fin = finalizedRow[0];
  const tp = throughputRow[0];

  const blisteredShift = Math.max(
    Number(stage.blistered) || 0,
    Number(tp?.blistered) || 0,
  );
  const sealedShift = Math.max(
    Number(stage.sealed) || 0,
    Number(tp?.sealed) || 0,
  );
  const packagedShift = Math.max(
    Number(stage.packaged) || 0,
    Number(tp?.packaged) || 0,
  );
  const finalizedShift = Math.max(
    Number(fin?.bags) || 0,
    Number(tp?.finalized) || 0,
  );
  const unitsFinalizedShift = Math.max(
    Number(fin?.units) || 0,
    Number(tp?.units) || 0,
  );
  const displaysShift = Math.max(
    Number(fin?.displays) || 0,
    Number(tp?.displays) || 0,
  );
  const casesShift = Math.max(
    Number(fin?.cases) || 0,
    Number(tp?.cases) || 0,
  );

  return {
    throughputDayKey,
    shiftStartUtc: shiftStartIso,
    bagsInFlow: wipRow[0]?.n ?? 0,
    atStation: activeRow[0]?.n ?? 0,
    blisteredShift,
    sealedShift,
    packagedShift,
    finalizedShift,
    unitsFinalizedShift,
    displaysShift,
    casesShift,
    activeOnFloor: activeRow[0]?.n ?? 0,
  };
}

/** Local throughput day key aligned with projector (America/New_York). */
export function throughputDayKeyForNow(_tz: string, now = new Date()): string {
  return ymdInTz(now, _tz);
}
