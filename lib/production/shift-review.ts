/** SHIFT-REVIEW-1 — read-only post-shift blister counter segment review. */

import { sortedRollSet } from "@/lib/production/counter-snapshot-guard";

export const SHIFT_REVIEW_READ_ONLY_BANNER =
  "Read-only review — this page does not repair data. Use the recovery dry-run harness for investigation. Do not edit the database manually.";

export const RECOVERY_DRY_RUN_HINT =
  "npx tsx scripts/material-change-recovery-dry-run.ts --help";

export type ShiftReviewFlagCode =
  | "MISSING_SHIFT_END_SNAPSHOT"
  | "DUPLICATE_LOOKING_SEGMENT"
  | "CLOSEOUT_MATCHES_PRIOR_PAUSE"
  | "COUNT_WITHOUT_ACTIVE_ROLL"
  | "MISSING_LINEAGE"
  | "MISSING_PAIRED_SEGMENT"
  | "FINALIZED_SUSPICIOUS"
  | "NOT_APPLICABLE_HANDPACK"
  | "MISSING_BLISTER_SEGMENTS";

export type ShiftReviewNextAction =
  | "ok"
  | "supervisor_review"
  | "run_recovery_dry_run"
  | "stop_floor_call_sahil"
  | "no_action_needed";

export type ShiftReviewFlag = {
  code: ShiftReviewFlagCode;
  message: string;
  nextAction: ShiftReviewNextAction;
  severity: "info" | "warn" | "danger";
};

export type ShiftReviewSegmentInput = {
  segmentReason: string;
  counterSegmentCount: number;
  packagingLotId: string;
  rollRole: "PVC" | "FOIL" | null;
  segmentGroupId: string | null;
  oldLotId?: string | null;
  newLotId?: string | null;
  changedRole?: string | null;
  occurredAt: string | Date;
};

export type ShiftReviewPauseInput = {
  reason: string;
  counterSnapshotCount: number | null;
  counterSnapshotReason: string | null;
  occurredAt: string | Date;
};

export type ShiftReviewBagInput = {
  workflowBagId: string;
  receiptNumber: string | null;
  bagNumber: string | number | null;
  productName: string | null;
  tabletTypeName: string | null;
  productKind: string | null;
  stage: string | null;
  isFinalized: boolean;
  isPaused: boolean;
  hasFinishedLot: boolean;
  inventoryBagId: string | null;
  stationIds: string[];
  stationNames: string[];
  stationKinds: string[];
  segments: ShiftReviewSegmentInput[];
  pauseEvents: ShiftReviewPauseInput[];
  blisterCloseOutCounts: number[];
  activeRollLotIds: string[];
  hasBlisterWorkflowActivity: boolean;
};

export type ShiftReviewBagRow = {
  workflowBagId: string;
  displayLabel: string;
  productLabel: string | null;
  stage: string | null;
  stationLabel: string;
  pauseSnapshotCount: number;
  shiftEndSnapshotCount: number;
  rollChangeCount: number;
  closeOutCount: number;
  activeRollLots: string[];
  flags: ShiftReviewFlag[];
  hasFlags: boolean;
  sortRank: number;
};

export type ShiftReviewSummary = {
  reviewWindowLabel: string;
  bagsTouched: number;
  stationsTouched: number;
  totalCounterSegments: number;
  totalPauseSnapshots: number;
  totalRollChangeSnapshots: number;
  totalShiftEndSnapshots: number;
  totalCloseOutSegments: number;
  totalFlaggedIssues: number;
};

export type ShiftReviewResult = {
  window: { from: Date; to: Date; label: string };
  summary: ShiftReviewSummary;
  bags: ShiftReviewBagRow[];
};

function buildBagDisplayLabel(bag: ShiftReviewBagInput): string {
  const parts = [
    bag.receiptNumber,
    bag.bagNumber ? `Bag ${bag.bagNumber}` : null,
    bag.tabletTypeName ?? bag.productName,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return `Workflow ${bag.workflowBagId.slice(0, 8)}`;
}

function buildProductLabel(bag: ShiftReviewBagInput): string | null {
  return bag.productName ?? bag.tabletTypeName ?? null;
}

function isHandpackOnlyBag(bag: ShiftReviewBagInput): boolean {
  if (bag.stationKinds.length > 0 && bag.stationKinds.every((kind) => kind === "HANDPACK_BLISTER")) {
    return true;
  }
  return false;
}

function countSegmentsByReason(
  segments: ShiftReviewSegmentInput[],
  reason: string,
): number {
  const groups = new Set<string>();
  for (const segment of segments) {
    if (segment.segmentReason !== reason) continue;
    groups.add(
      segment.segmentGroupId ??
        `${reason}:${segment.counterSegmentCount}:${segment.occurredAt}`,
    );
  }
  return groups.size;
}

function detectMissingPairedSegments(segments: ShiftReviewSegmentInput[]): boolean {
  const byGroup = new Map<string, ShiftReviewSegmentInput[]>();
  for (const segment of segments) {
    if (
      segment.segmentReason !== "PAUSE_SNAPSHOT" &&
      segment.segmentReason !== "SHIFT_END_SNAPSHOT" &&
      segment.segmentReason !== "ROLL_CHANGE" &&
      segment.segmentReason !== "BAG_COMPLETE"
    ) {
      continue;
    }
    const key =
      segment.segmentGroupId ??
      `${segment.segmentReason}:${segment.counterSegmentCount}:${String(segment.occurredAt)}`;
    const bucket = byGroup.get(key) ?? [];
    bucket.push(segment);
    byGroup.set(key, bucket);
  }
  for (const group of byGroup.values()) {
    if (group.length !== 1) continue;
    const head = group[0];
    if (head && head.counterSegmentCount > 0) return true;
  }
  return false;
}

function groupSegmentsByInputGroup(
  segments: ShiftReviewSegmentInput[],
): Map<string, ShiftReviewSegmentInput[]> {
  const groups = new Map<string, ShiftReviewSegmentInput[]>();
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

function detectDuplicateLookingSegments(
  segments: ShiftReviewSegmentInput[],
  _activeRollLotIds: string[],
): boolean {
  const signatureCounts = new Map<string, number>();
  for (const group of groupSegmentsByInputGroup(segments).values()) {
    const head = group[0];
    if (!head) continue;
    const signature = `${head.segmentReason}:${head.counterSegmentCount}:${sortedRollSet(group.map((row) => row.packagingLotId))}`;
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  for (const count of signatureCounts.values()) {
    if (count > 1) return true;
  }
  return false;
}

function detectCloseoutMatchesPriorPause(segments: ShiftReviewSegmentInput[]): boolean {
  const closeOutCounts = segments
    .filter((segment) => segment.segmentReason === "BAG_COMPLETE")
    .map((segment) => segment.counterSegmentCount);
  if (closeOutCounts.length === 0) return false;
  for (const count of closeOutCounts) {
    const pauseLike = segments.some(
      (segment) =>
        (segment.segmentReason === "PAUSE_SNAPSHOT" ||
          segment.segmentReason === "SHIFT_END_SNAPSHOT") &&
        segment.counterSegmentCount === count,
    );
    if (pauseLike) return true;
  }
  return false;
}

function detectMissingShiftEndSnapshot(bag: ShiftReviewBagInput): boolean {
  const shiftEndPauses = bag.pauseEvents.filter((pause) => pause.reason === "shift_end");
  if (shiftEndPauses.length === 0) return false;
  const shiftEndSegments = countSegmentsByReason(bag.segments, "SHIFT_END_SNAPSHOT");
  for (const pause of shiftEndPauses) {
    const count = pause.counterSnapshotCount;
    if (count != null && count > 0 && shiftEndSegments === 0) {
      return true;
    }
  }
  if (bag.isPaused && shiftEndPauses.length > 0 && shiftEndSegments === 0) {
    return true;
  }
  return false;
}

export function flagShiftReviewBag(bag: ShiftReviewBagInput): ShiftReviewFlag[] {
  const flags: ShiftReviewFlag[] = [];

  if (isHandpackOnlyBag(bag)) {
    flags.push({
      code: "NOT_APPLICABLE_HANDPACK",
      message:
        "Hand-pack or non-blister-counter path — blister segment review may not apply.",
      nextAction: "no_action_needed",
      severity: "info",
    });
    return flags;
  }

  if (
    bag.hasBlisterWorkflowActivity &&
    bag.segments.length === 0 &&
    !isHandpackOnlyBag(bag)
  ) {
    flags.push({
      code: "MISSING_BLISTER_SEGMENTS",
      message:
        "Blister activity detected in the review window but no counter segments were recorded — review recommended.",
      nextAction: "supervisor_review",
      severity: "warn",
    });
  }

  if (!bag.inventoryBagId && bag.segments.length > 0) {
    flags.push({
      code: "MISSING_LINEAGE",
      message:
        "Counter segments exist but received-bag lineage is missing — review recommended before trusting genealogy.",
      nextAction: "supervisor_review",
      severity: "warn",
    });
  }

  if (bag.segments.length > 0 && bag.activeRollLotIds.length === 0) {
    flags.push({
      code: "COUNT_WITHOUT_ACTIVE_ROLL",
      message:
        "Segments were recorded but no active PVC/foil rolls are known for this bag — review recommended.",
      nextAction: "supervisor_review",
      severity: "warn",
    });
  }

  if (detectMissingPairedSegments(bag.segments)) {
    flags.push({
      code: "MISSING_PAIRED_SEGMENT",
      message:
        "A segment group appears to include only one roll role — paired PVC/foil segments may be missing.",
      nextAction: "supervisor_review",
      severity: "warn",
    });
  }

  if (detectDuplicateLookingSegments(bag.segments, bag.activeRollLotIds)) {
    flags.push({
      code: "DUPLICATE_LOOKING_SEGMENT",
      message:
        "Duplicate-looking counter segment pattern detected — review recommended before continuing production.",
      nextAction: "run_recovery_dry_run",
      severity: "warn",
    });
  }

  if (detectCloseoutMatchesPriorPause(bag.segments)) {
    flags.push({
      code: "CLOSEOUT_MATCHES_PRIOR_PAUSE",
      message:
        "Blister close-out count matches a prior pause or end-shift snapshot in the same cycle — review recommended.",
      nextAction: "run_recovery_dry_run",
      severity: "warn",
    });
  }

  if (detectMissingShiftEndSnapshot(bag)) {
    flags.push({
      code: "MISSING_SHIFT_END_SNAPSHOT",
      message:
        "Shift-end pause recorded but no matching end-shift counter snapshot segment — review recommended.",
      nextAction: "supervisor_review",
      severity: "warn",
    });
  }

  const suspicious =
    flags.some((flag) => flag.code !== "NOT_APPLICABLE_HANDPACK") &&
    flags.length > 0;

  if ((bag.isFinalized || bag.hasFinishedLot) && suspicious) {
    flags.push({
      code: "FINALIZED_SUSPICIOUS",
      message:
        "Bag is finalized or contributes to a finished lot while suspicious segment flags remain — Sahil review required.",
      nextAction: "stop_floor_call_sahil",
      severity: "danger",
    });
  }

  return flags;
}

export function nextActionLabel(action: ShiftReviewNextAction): string {
  switch (action) {
    case "ok":
      return "OK";
    case "supervisor_review":
      return "Supervisor review";
    case "run_recovery_dry_run":
      return "Run recovery dry-run harness";
    case "stop_floor_call_sahil":
      return "Stop floor / call Sahil";
    case "no_action_needed":
      return "No action needed";
  }
}

function flagSortRank(flags: ShiftReviewFlag[]): number {
  if (flags.some((flag) => flag.severity === "danger")) return 0;
  if (flags.some((flag) => flag.severity === "warn")) return 1;
  if (flags.some((flag) => flag.code === "NOT_APPLICABLE_HANDPACK")) return 3;
  return 2;
}

export function buildShiftReviewBagRow(bag: ShiftReviewBagInput): ShiftReviewBagRow {
  const flags = flagShiftReviewBag(bag);
  const meaningfulFlags = flags.filter(
    (flag) => flag.code !== "NOT_APPLICABLE_HANDPACK" || flags.length === 1,
  );
  return {
    workflowBagId: bag.workflowBagId,
    displayLabel: buildBagDisplayLabel(bag),
    productLabel: buildProductLabel(bag),
    stage: bag.stage,
    stationLabel: bag.stationNames.length > 0 ? bag.stationNames.join(", ") : "—",
    pauseSnapshotCount: countSegmentsByReason(bag.segments, "PAUSE_SNAPSHOT"),
    shiftEndSnapshotCount: countSegmentsByReason(bag.segments, "SHIFT_END_SNAPSHOT"),
    rollChangeCount: countSegmentsByReason(bag.segments, "ROLL_CHANGE"),
    closeOutCount: countSegmentsByReason(bag.segments, "BAG_COMPLETE"),
    activeRollLots: bag.activeRollLotIds,
    flags: meaningfulFlags,
    hasFlags: meaningfulFlags.some(
      (flag) =>
        flag.code !== "NOT_APPLICABLE_HANDPACK" && flag.nextAction !== "no_action_needed",
    ),
    sortRank: flagSortRank(meaningfulFlags),
  };
}

export function buildShiftReview(args: {
  window: { from: Date; to: Date; label?: string };
  bags: ShiftReviewBagInput[];
  stationCount: number;
}): ShiftReviewResult {
  const bagRows = args.bags.map(buildShiftReviewBagRow);
  bagRows.sort((a, b) => {
    if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
    return a.displayLabel.localeCompare(b.displayLabel);
  });

  const allSegments = args.bags.flatMap((bag) => bag.segments);
  const totalFlaggedIssues = bagRows.reduce(
    (sum, row) =>
      sum +
      row.flags.filter(
        (flag) =>
          flag.code !== "NOT_APPLICABLE_HANDPACK" && flag.nextAction !== "no_action_needed",
      ).length,
    0,
  );

  const label =
    args.window.label ??
    `${args.window.from.toISOString()} → ${args.window.to.toISOString()}`;

  return {
    window: { from: args.window.from, to: args.window.to, label },
    summary: {
      reviewWindowLabel: label,
      bagsTouched: bagRows.length,
      stationsTouched: args.stationCount,
      totalCounterSegments: allSegments.length,
      totalPauseSnapshots: countSegmentsByReason(allSegments, "PAUSE_SNAPSHOT"),
      totalRollChangeSnapshots: countSegmentsByReason(allSegments, "ROLL_CHANGE"),
      totalShiftEndSnapshots: countSegmentsByReason(allSegments, "SHIFT_END_SNAPSHOT"),
      totalCloseOutSegments: countSegmentsByReason(allSegments, "BAG_COMPLETE"),
      totalFlaggedIssues,
    },
    bags: bagRows,
  };
}

export function parseShiftReviewWindow(searchParams: {
  from?: string;
  to?: string;
}): { from: Date; to: Date; label: string } {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const from =
    searchParams.from && searchParams.from.trim() !== ""
      ? new Date(searchParams.from)
      : defaultFrom;
  const to =
    searchParams.to && searchParams.to.trim() !== ""
      ? new Date(`${searchParams.to}T23:59:59`)
      : now;
  const fromLabel = from.toISOString().slice(0, 16);
  const toLabel = to.toISOString().slice(0, 16);
  return {
    from,
    to,
    label: `${fromLabel} → ${toLabel} (UTC)`,
  };
}

export function defaultShiftReviewFromTo(): { from: string; to: string } {
  const window = parseShiftReviewWindow({});
  return {
    from: window.from.toISOString().slice(0, 10),
    to: window.to.toISOString().slice(0, 10),
  };
}
