/** COUNTER-SNAPSHOT-GUARD-1 — pure validation for blister counter segments. */

export const COUNTER_SNAPSHOT_DUPLICATE_ERROR =
  "This counter snapshot looks like it was already recorded. Do not submit again. Call Sahil or a supervisor if the machine counter was reset or the count is wrong.";

export const COUNTER_SNAPSHOT_INVALID_COUNT_ERROR =
  "Counter count must be a whole number greater than or equal to 0.";

export const COUNTER_SNAPSHOT_MISSING_ROLLS_ERROR =
  "Luma could not confirm the active PVC/foil rolls for this counter snapshot. Stop and call Sahil or a supervisor.";

export const COUNTER_SNAPSHOT_CLOSEOUT_DOUBLE_COUNT_ERROR =
  "This blister close-out count matches a count already recorded during pause or end-shift. Enter the count since the last physical counter reset, or call a supervisor if the counter was reset early.";

export type CounterSnapshotContext =
  | "pause_machine_jam"
  | "pause_shift_end"
  | "roll_change"
  | "blister_close_out";

export type RecentSegmentRow = {
  segmentReason: string;
  counterSegmentCount: number;
  packagingLotId: string;
  segmentGroupId: string | null;
  oldLotId: string | null;
  newLotId: string | null;
  changedRole: string | null;
};

export type ValidateBlisterCounterSnapshotInput = {
  context: CounterSnapshotContext;
  submittedCount: number | null | undefined;
  allowZero: boolean;
  requirePositive: boolean;
  activeRollLotIds: string[];
  recentSegments: RecentSegmentRow[];
  rollChange?: {
    changedRole: "PVC" | "FOIL";
    oldLotId: string;
    newLotId: string;
  };
};

export function segmentReasonForContext(context: CounterSnapshotContext): string {
  switch (context) {
    case "pause_machine_jam":
      return "PAUSE_SNAPSHOT";
    case "pause_shift_end":
      return "SHIFT_END_SNAPSHOT";
    case "roll_change":
      return "ROLL_CHANGE";
    case "blister_close_out":
      return "BAG_COMPLETE";
  }
}

export function sortedRollSet(lotIds: readonly string[]): string {
  return [...lotIds].sort().join("|");
}

function groupSegmentsByGroupId(
  segments: RecentSegmentRow[],
): Map<string, RecentSegmentRow[]> {
  const groups = new Map<string, RecentSegmentRow[]>();
  for (const segment of segments) {
    const key =
      segment.segmentGroupId ??
      `${segment.segmentReason}:${segment.counterSegmentCount}:${segment.packagingLotId}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(segment);
    groups.set(key, bucket);
  }
  return groups;
}

function hasDuplicateSegmentGroup(
  segments: RecentSegmentRow[],
  segmentReason: string,
  count: number,
  activeRollSet: string,
): boolean {
  for (const group of groupSegmentsByGroupId(segments).values()) {
    const head = group[0];
    if (!head) continue;
    if (head.segmentReason !== segmentReason) continue;
    if (head.counterSegmentCount !== count) continue;
    if (sortedRollSet(group.map((row) => row.packagingLotId)) === activeRollSet) {
      return true;
    }
  }
  return false;
}

export function validateBlisterCounterSnapshot(
  input: ValidateBlisterCounterSnapshotInput,
): { ok: boolean; blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const raw = input.submittedCount;

  if (raw == null) {
    if (input.requirePositive) {
      blockers.push(COUNTER_SNAPSHOT_INVALID_COUNT_ERROR);
    }
    return { ok: blockers.length === 0, blockers, warnings };
  }

  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    blockers.push(COUNTER_SNAPSHOT_INVALID_COUNT_ERROR);
    return { ok: false, blockers, warnings };
  }

  if (raw === 0) {
    if (input.allowZero) {
      return { ok: true, blockers, warnings };
    }
    blockers.push(COUNTER_SNAPSHOT_INVALID_COUNT_ERROR);
    return { ok: false, blockers, warnings };
  }

  if (input.activeRollLotIds.length === 0) {
    blockers.push(COUNTER_SNAPSHOT_MISSING_ROLLS_ERROR);
    return { ok: false, blockers, warnings };
  }

  const activeRollSet = sortedRollSet(input.activeRollLotIds);
  const segments = input.recentSegments;

  if (input.context === "roll_change" && input.rollChange) {
    const duplicate = segments.some(
      (segment) =>
        segment.segmentReason === "ROLL_CHANGE" &&
        segment.counterSegmentCount === raw &&
        segment.oldLotId === input.rollChange!.oldLotId &&
        segment.newLotId === input.rollChange!.newLotId &&
        segment.changedRole === input.rollChange!.changedRole,
    );
    if (duplicate) {
      blockers.push(COUNTER_SNAPSHOT_DUPLICATE_ERROR);
    }
    return { ok: blockers.length === 0, blockers, warnings };
  }

  if (
    input.context === "pause_machine_jam" ||
    input.context === "pause_shift_end"
  ) {
    const segmentReason = segmentReasonForContext(input.context);
    if (
      hasDuplicateSegmentGroup(segments, segmentReason, raw, activeRollSet)
    ) {
      blockers.push(COUNTER_SNAPSHOT_DUPLICATE_ERROR);
    }
    return { ok: blockers.length === 0, blockers, warnings };
  }

  if (input.context === "blister_close_out") {
    const pauseLikeDuplicate = segments.some(
      (segment) =>
        (segment.segmentReason === "PAUSE_SNAPSHOT" ||
          segment.segmentReason === "SHIFT_END_SNAPSHOT") &&
        segment.counterSegmentCount === raw,
    );
    if (pauseLikeDuplicate) {
      blockers.push(COUNTER_SNAPSHOT_CLOSEOUT_DOUBLE_COUNT_ERROR);
    }
    if (
      hasDuplicateSegmentGroup(segments, "BAG_COMPLETE", raw, activeRollSet)
    ) {
      blockers.push(COUNTER_SNAPSHOT_DUPLICATE_ERROR);
    }
    return { ok: blockers.length === 0, blockers, warnings };
  }

  return { ok: true, blockers, warnings };
}

export function firstCounterSnapshotBlocker(
  result: ReturnType<typeof validateBlisterCounterSnapshot>,
): string | null {
  return result.blockers[0] ?? null;
}
