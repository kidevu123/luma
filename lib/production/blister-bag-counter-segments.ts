// PVC counter segments for a workflow bag — one row per machine-counter
// segment (roll change, bag complete, pause snapshot, etc.). FOIL is
// omitted because it mirrors PVC counts and would double the display.

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { materialInventoryEvents, packagingLots } from "@/lib/db/schema";

export type BlisterBagCounterSegment = {
  occurredAt: Date;
  segmentCount: number;
  segmentReason: string;
  segmentLabel: string;
  rollNumber: string | null;
  bagSegmentSequence: number | null;
};

const SEGMENT_REASON_LABELS: Record<string, string> = {
  ROLL_CHANGE: "Roll change",
  BAG_COMPLETE: "Bag complete",
  PAUSE_SNAPSHOT: "Pause snapshot",
  SHIFT_END_SNAPSHOT: "Shift end snapshot",
  RECOVERY_ROLL_CHANGE: "Recovery roll change",
};

export function labelBlisterCounterSegmentReason(reason: string): string {
  return SEGMENT_REASON_LABELS[reason] ?? reason.replaceAll("_", " ").toLowerCase();
}

export function sumBlisterBagCounterSegments(
  segments: readonly BlisterBagCounterSegment[],
): number {
  return segments.reduce((sum, s) => sum + s.segmentCount, 0);
}

export async function loadBlisterBagCounterSegments(
  workflowBagId: string,
): Promise<BlisterBagCounterSegment[]> {
  if (!workflowBagId) return [];

  const rows = await db
    .select({
      occurredAt: materialInventoryEvents.occurredAt,
      segmentCount: sql<number>`( ${materialInventoryEvents.payload}->>'counter_segment_count')::int`,
      segmentReason: sql<string | null>`${materialInventoryEvents.payload}->>'segment_reason'`,
      rollNumber: packagingLots.rollNumber,
      bagSegmentSequence: sql<number | null>`( ${materialInventoryEvents.payload}->>'bag_segment_sequence')::int`,
      rollRole: sql<string | null>`${materialInventoryEvents.payload}->>'roll_role'`,
    })
    .from(materialInventoryEvents)
    .leftJoin(
      packagingLots,
      eq(packagingLots.id, materialInventoryEvents.packagingLotId),
    )
    .where(
      sql`${materialInventoryEvents.workflowBagId} = ${workflowBagId}::uuid
          AND ${materialInventoryEvents.eventType} = 'ROLL_COUNTER_SEGMENT_RECORDED'
          AND COALESCE(${materialInventoryEvents.payload}->>'roll_role', 'PVC') = 'PVC'`,
    )
    .orderBy(
      asc(materialInventoryEvents.occurredAt),
      asc(materialInventoryEvents.id),
    );

  const segments: BlisterBagCounterSegment[] = [];
  for (const row of rows) {
    const segmentCount = row.segmentCount;
    const segmentReason = row.segmentReason;
    if (
      segmentCount == null ||
      !Number.isFinite(segmentCount) ||
      segmentCount < 0 ||
      !segmentReason
    ) {
      continue;
    }
    segments.push({
      occurredAt: row.occurredAt,
      segmentCount,
      segmentReason,
      segmentLabel: labelBlisterCounterSegmentReason(segmentReason),
      rollNumber: row.rollNumber,
      bagSegmentSequence: row.bagSegmentSequence,
    });
  }
  return segments;
}
