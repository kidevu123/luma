/** Client-safe types and helpers for blister bag PVC counter segments. */

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
