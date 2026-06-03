// Display-only workflow stage labels — honest partial status without
// changing read_bag_state.stage used for floor pickup/resume.

import {
  isVoidErroneousBagFinalizationCorrection,
} from "@/lib/production/bag-finalization-void";
import {
  hasFullSealingLaneClose,
  hasPartialSealingCloseout,
} from "@/lib/production/sealing-partial-closeout";

export type WorkflowEventSlice = {
  id?: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
};

export type WorkflowDisplayStatus = {
  /** Badge key for color lookup (may differ from read_bag_state.stage). */
  badgeKey: string;
  /** Short uppercase label for row badge. */
  badgeLabel: string;
  /** Optional help text for expanded context or title attribute. */
  helpText: string | null;
};

function hasPartialPackagingEvidence(events: readonly WorkflowEventSlice[]): boolean {
  return events.some((ev) => ev.eventType === "PACKAGING_COMPLETE");
}

function hasVoidedErroneousFinalization(events: readonly WorkflowEventSlice[]): boolean {
  return events.some(
    (ev) =>
      ev.eventType === "SUBMISSION_CORRECTED" &&
      isVoidErroneousBagFinalizationCorrection(ev.payload ?? null),
  );
}

/** Derive an honest display badge from read model stage + event history. */
export function deriveWorkflowDisplayStatus(args: {
  readStage: string | null | undefined;
  isFinalized: boolean | null | undefined;
  isPaused: boolean | null | undefined;
  events: readonly WorkflowEventSlice[];
}): WorkflowDisplayStatus {
  if (args.isPaused) {
    return { badgeKey: "PAUSED", badgeLabel: "PAUSED", helpText: null };
  }

  const stage = args.readStage ?? null;

  if (args.isFinalized || stage === "FINALIZED") {
    return { badgeKey: "FINALIZED", badgeLabel: "FINALIZED", helpText: null };
  }

  const partialSealed = hasPartialSealingCloseout(args.events);
  const partialPackaged = hasPartialPackagingEvidence(args.events);
  const legacyVoid = hasVoidedErroneousFinalization(args.events);

  const showPartialBadge =
    partialSealed &&
    partialPackaged &&
    !hasFullSealingLaneClose(args.events) &&
    (stage === "BLISTERED" || stage === "STARTED" || stage === "PACKAGED");

  if (showPartialBadge) {
    const helpText = legacyVoid
      ? "Legacy partial: partially sealed/packaged, finalization voided. Inventory still needs review."
      : "Partial: partially sealed/packaged and resumable. Confirm remaining tablets before restart if inventory is unknown.";
    return { badgeKey: "PARTIAL", badgeLabel: "PARTIAL", helpText };
  }

  if (stage) {
    return { badgeKey: stage, badgeLabel: stage, helpText: null };
  }

  return { badgeKey: "UNKNOWN", badgeLabel: "—", helpText: null };
}

/** True when display would show PARTIAL instead of raw BLISTERED. */
export function isPartialPackagedDisplayStatus(
  events: readonly WorkflowEventSlice[],
  readStage: string | null | undefined,
): boolean {
  return (
    deriveWorkflowDisplayStatus({
      readStage,
      isFinalized: false,
      isPaused: false,
      events,
    }).badgeKey === "PARTIAL"
  );
}
