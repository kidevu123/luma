// Resolve effective submission payloads after SUBMISSION_CORRECTED chain.
// Latest correction linked to an event wins; originals stay in workflow_events.

import { isVoidErroneousBagFinalizationCorrection } from "@/lib/production/bag-finalization-void";

export type WorkflowEventCorrectionSlice = {
  id?: string;
  eventType: string;
  occurredAt?: Date | string | null;
  payload?: Record<string, unknown> | null;
};

export type LatestSubmissionCorrection = {
  correctedValue: unknown;
  correctionEventId: string;
};

export function mergeCorrectedSubmissionPayload(
  originalPayload: Record<string, unknown>,
  correctedValue: unknown,
): Record<string, unknown> {
  if (
    correctedValue === null ||
    typeof correctedValue !== "object" ||
    Array.isArray(correctedValue)
  ) {
    return { ...originalPayload };
  }
  return { ...originalPayload, ...(correctedValue as Record<string, unknown>) };
}

/** Map corrected_event_id → latest numeric correction (by occurred_at, id). */
export function buildLatestSubmissionCorrectionByTarget(
  events: readonly WorkflowEventCorrectionSlice[],
): Map<string, LatestSubmissionCorrection> {
  const map = new Map<
    string,
    LatestSubmissionCorrection & { sortAt: number; sortId: string }
  >();

  for (const ev of events) {
    if (ev.eventType !== "SUBMISSION_CORRECTED") continue;
    const payload = ev.payload ?? {};
    if (isVoidErroneousBagFinalizationCorrection(payload)) continue;

    const targetId = payload["corrected_event_id"];
    if (typeof targetId !== "string" || targetId.length === 0) continue;

    const occurredAt = ev.occurredAt ? new Date(ev.occurredAt).getTime() : 0;
    const eventId = ev.id ?? "";
    const existing = map.get(targetId);
    if (
      !existing ||
      occurredAt > existing.sortAt ||
      (occurredAt === existing.sortAt && eventId > existing.sortId)
    ) {
      map.set(targetId, {
        correctedValue: payload["corrected_value"],
        correctionEventId: eventId,
        sortAt: occurredAt,
        sortId: eventId,
      });
    }
  }

  const out = new Map<string, LatestSubmissionCorrection>();
  for (const [k, v] of map) {
    out.set(k, {
      correctedValue: v.correctedValue,
      correctionEventId: v.correctionEventId,
    });
  }
  return out;
}

export function resolveEffectiveEventPayload(
  event: WorkflowEventCorrectionSlice,
  corrections: Map<string, LatestSubmissionCorrection>,
): Record<string, unknown> {
  const base = (event.payload ?? {}) as Record<string, unknown>;
  if (!event.id) return base;
  const correction = corrections.get(event.id);
  if (!correction) return base;
  return mergeCorrectedSubmissionPayload(base, correction.correctedValue);
}

/** Event ids that have at least one SUBMISSION_CORRECTED targeting them. */
export function buildCorrectedSubmissionEventIds(
  events: readonly WorkflowEventCorrectionSlice[],
): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev.eventType !== "SUBMISSION_CORRECTED") continue;
    const payload = ev.payload ?? {};
    if (isVoidErroneousBagFinalizationCorrection(payload)) continue;
    const targetId = payload["corrected_event_id"];
    if (typeof targetId === "string" && targetId.length > 0) {
      ids.add(targetId);
    }
  }
  return ids;
}
