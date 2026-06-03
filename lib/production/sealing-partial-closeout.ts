// SEALING-PARTIAL-CLOSEOUT-1 — partial sealing lane close (pure helpers).

import {
  deriveSealingSegmentProgress,
  SEALING_SEGMENT_EVENT,
} from "@/lib/production/sealing-segments";

export const SEALING_PARTIAL_CLOSE_REASONS = [
  "END_OF_SHIFT",
  "HANDOFF",
  "TIME_LIMIT",
  "MATERIAL_ISSUE",
  "SUPERVISOR_DIRECTED",
  "OTHER",
] as const;

export type SealingPartialCloseReason =
  (typeof SEALING_PARTIAL_CLOSE_REASONS)[number];

export const SEALING_PARTIAL_CLOSE_REASON_LABELS: Record<
  SealingPartialCloseReason,
  string
> = {
  END_OF_SHIFT: "End of shift",
  HANDOFF: "Machine/operator handoff",
  TIME_LIMIT: "Not enough time to finish",
  MATERIAL_ISSUE: "Material issue",
  SUPERVISOR_DIRECTED: "Supervisor-directed partial",
  OTHER: "Other",
};

export type WorkflowEventSlice = {
  eventType: string;
  payload?: Record<string, unknown> | null;
};

export function isPartialSealingClosePayload(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return false;
  return payload.partial_close === true;
}

/** True when this bag already has a durable partial sealing close-out. */
export function hasPartialSealingCloseout(
  events: readonly WorkflowEventSlice[],
): boolean {
  return events.some(
    (ev) =>
      ev.eventType === "SEALING_COMPLETE" &&
      isPartialSealingClosePayload(ev.payload ?? null),
  );
}

/** True when whole-bag sealing lane close has fired (not partial close-out). */
export function hasFullSealingLaneClose(
  events: readonly WorkflowEventSlice[],
): boolean {
  return events.some(
    (ev) =>
      ev.eventType === "SEALING_COMPLETE" &&
      !isPartialSealingClosePayload(ev.payload ?? null),
  );
}

export function isPartialPackagingPayload(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return false;
  return payload.partial_packaging === true;
}

/** True when packaging complete recorded a partial-sealed quantity only. */
export function hasPartialPackagingComplete(
  events: readonly WorkflowEventSlice[],
): boolean {
  return events.some(
    (ev) =>
      ev.eventType === "PACKAGING_COMPLETE" &&
      isPartialPackagingPayload(ev.payload ?? null),
  );
}

/** Packaging after partial sealing close-out (no whole lane close yet). */
export function shouldEmitPartialPackagingComplete(
  events: readonly WorkflowEventSlice[],
): boolean {
  return hasPartialSealingCloseout(events) && !hasFullSealingLaneClose(events);
}

export function buildPartialPackagingCompletePayload(args: {
  masterCases: number;
  displaysMade: number;
  looseCards: number;
  damagedPackaging: number;
  rippedCards: number;
  sealedPartialCount: number;
  operatorCode?: string | null;
}): Record<string, unknown> {
  const packagedPartialCount =
    args.masterCases + args.displaysMade + args.looseCards;
  const payload: Record<string, unknown> = {
    partial_packaging: true,
    packaged_partial_count: packagedPartialCount,
    sealed_partial_count_at_pack: args.sealedPartialCount,
    master_cases: args.masterCases,
    displays_made: args.displaysMade,
    loose_cards: args.looseCards,
    damaged_packaging: args.damagedPackaging,
    ripped_cards: args.rippedCards,
  };
  if (args.operatorCode) payload.operator_code = args.operatorCode;
  return payload;
}

/** Sealing may reopen after partial packaging — not after whole-bag terminal path. */
export function isWorkflowBagResumableAtSealingAfterPartialPackaging(
  events: readonly WorkflowEventSlice[],
  args: {
    stage: string | null | undefined;
    isFinalized: boolean;
  },
): boolean {
  if (args.isFinalized) return false;
  if (!hasPartialSealingCloseout(events)) return false;
  if (hasFullSealingLaneClose(events)) return false;
  const stage = args.stage ?? null;
  if (stage === "BLISTERED" || stage === "STARTED") return true;
  if (stage === "PACKAGED") {
    return (
      hasPartialPackagingComplete(events) ||
      (hasPartialSealingCloseout(events) && !hasFullSealingLaneClose(events))
    );
  }
  return false;
}

/** Latest sealed_partial_count from the most recent partial close event. */
export function readLatestPartialSealedCount(
  events: readonly WorkflowEventSlice[],
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (
      ev.eventType === "SEALING_COMPLETE" &&
      isPartialSealingClosePayload(ev.payload ?? null)
    ) {
      const raw = ev.payload?.sealed_partial_count;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.max(0, Math.floor(raw));
      }
    }
  }
  return deriveSealedPartialCountFromSegments(events);
}

/** Sealed card count for partial close — sum of segment payloads only. */
export function deriveSealedPartialCountFromSegments(
  events: readonly WorkflowEventSlice[],
): number {
  return deriveSealingSegmentProgress(events).cardsTotal;
}

export type ValidatePartialCloseInput = {
  events: readonly WorkflowEventSlice[];
  reason: string | null | undefined;
  reasonNote: string | null | undefined;
};

export type ValidatePartialCloseResult =
  | { ok: true; sealedPartialCount: number; reason: SealingPartialCloseReason }
  | { ok: false; error: string };

export function validateSealingPartialCloseInput(
  input: ValidatePartialCloseInput,
): ValidatePartialCloseResult {
  if (hasPartialSealingCloseout(input.events)) {
    return {
      ok: false,
      error:
        "This bag already has a partial sealing close-out. Send it to packaging or start a new run.",
    };
  }
  const progress = deriveSealingSegmentProgress(input.events);
  if (progress.segmentCount < 1 || progress.cardsTotal < 1) {
    return {
      ok: false,
      error:
        "Record at least one sealing segment before submitting a partial bag.",
    };
  }
  const reason = input.reason?.trim() ?? "";
  if (
    !SEALING_PARTIAL_CLOSE_REASONS.includes(reason as SealingPartialCloseReason)
  ) {
    return { ok: false, error: "Select a partial close-out reason." };
  }
  const typedReason = reason as SealingPartialCloseReason;
  if (typedReason === "OTHER") {
    const note = input.reasonNote?.trim() ?? "";
    if (note.length < 3) {
      return {
        ok: false,
        error: "Add a short note when the reason is Other (at least 3 characters).",
      };
    }
  }
  return { ok: true, sealedPartialCount: progress.cardsTotal, reason: typedReason };
}

export function buildPartialSealingClosePayload(args: {
  sealedPartialCount: number;
  reason: SealingPartialCloseReason;
  reasonNote?: string | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    partial_close: true,
    lane_close: false,
    sealed_partial_count: args.sealedPartialCount,
    partial_close_reason: args.reason,
    partial_close_reason_label:
      SEALING_PARTIAL_CLOSE_REASON_LABELS[args.reason],
  };
  if (args.reason === "OTHER" && args.reasonNote?.trim()) {
    payload.partial_close_reason_note = args.reasonNote.trim();
  }
  return payload;
}

/** Packaging may complete at BLISTERED after partial sealing close-out. */
export function allowsPackagingCompleteAtBlistered(
  events: readonly WorkflowEventSlice[],
): boolean {
  return hasPartialSealingCloseout(events);
}

export { SEALING_SEGMENT_EVENT };
