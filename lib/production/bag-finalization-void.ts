// One-off repair support — void an erroneous BAG_FINALIZED after legacy
// partial packaging. Append-only; never deletes workflow_events.

export const CORRECTION_KIND_VOID_ERRONEOUS_BAG_FINALIZATION =
  "VOID_ERRONEOUS_BAG_FINALIZATION" as const;

export type WorkflowEventSlice = {
  id?: string;
  eventType: string;
  occurredAt?: Date | string | null;
  payload?: Record<string, unknown> | null;
};

export function isVoidErroneousBagFinalizationCorrection(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  return payload?.correction_kind === CORRECTION_KIND_VOID_ERRONEOUS_BAG_FINALIZATION;
}

/** Event ids voided by SUBMISSION_CORRECTED repair rows. */
export function findVoidedWorkflowEventIds(
  events: readonly WorkflowEventSlice[],
): Set<string> {
  const voided = new Set<string>();
  for (const ev of events) {
    if (ev.eventType !== "SUBMISSION_CORRECTED") continue;
    if (!isVoidErroneousBagFinalizationCorrection(ev.payload ?? null)) continue;
    const correctedId = ev.payload?.corrected_event_id;
    if (typeof correctedId === "string" && correctedId.length > 0) {
      voided.add(correctedId);
    }
  }
  return voided;
}

export function isBagFinalizedEventVoided(
  bagFinalizedEventId: string,
  events: readonly WorkflowEventSlice[],
): boolean {
  return findVoidedWorkflowEventIds(events).has(bagFinalizedEventId);
}

export type RebuildSafetyAssessment = {
  survivesReadModelRebuild: boolean;
  requiresVoidCorrectionEvent: boolean;
  requiresSynthesizerVoidSupport: boolean;
  summary: string;
};

/** Whether a read_bag_state-only patch would survive synthesizeReadModelsFromEvents. */
export function assessRebuildSafety(args: {
  events: readonly WorkflowEventSlice[];
  bagFinalizedEventId: string | null;
  hasVoidCorrection: boolean;
  synthesizerSupportsVoid: boolean;
}): RebuildSafetyAssessment {
  const hasBagFinalized =
    args.bagFinalizedEventId != null &&
    args.events.some(
      (e) =>
        e.eventType === "BAG_FINALIZED" && e.id === args.bagFinalizedEventId,
    );

  if (!hasBagFinalized) {
    return {
      survivesReadModelRebuild: true,
      requiresVoidCorrectionEvent: false,
      requiresSynthesizerVoidSupport: false,
      summary: "No BAG_FINALIZED event — read-model rebuild is not a concern.",
    };
  }

  if (!args.hasVoidCorrection) {
    return {
      survivesReadModelRebuild: false,
      requiresVoidCorrectionEvent: true,
      requiresSynthesizerVoidSupport: true,
      summary:
        "read_bag_state-only repair would be undone: synthesizeReadModelsFromEvents treats the latest BAG_FINALIZED as FINALIZED and workflow_bags.finalized_at as terminal.",
    };
  }

  if (!args.synthesizerSupportsVoid) {
    return {
      survivesReadModelRebuild: false,
      requiresVoidCorrectionEvent: true,
      requiresSynthesizerVoidSupport: true,
      summary:
        "Void correction event exists or is planned, but read-model synthesizer does not yet ignore voided BAG_FINALIZED rows.",
    };
  }

  return {
    survivesReadModelRebuild: true,
    requiresVoidCorrectionEvent: true,
    requiresSynthesizerVoidSupport: true,
    summary:
      "Repair survives rebuild when void correction is appended and synthesizer ignores voided BAG_FINALIZED.",
  };
}

/** True when synthesizer SQL includes void-aware finalization handling. */
export function synthesizerSupportsVoidedBagFinalization(source: string): boolean {
  return (
    source.includes("VOID_ERRONEOUS_BAG_FINALIZATION") &&
    source.includes("voided_bag_finalized")
  );
}
