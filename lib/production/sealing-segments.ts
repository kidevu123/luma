// MULTI-SEALING-SAME-BAG-1 — sealing segment helpers (pure + query).

export const SEALING_SEGMENT_EVENT = "SEALING_SEGMENT_COMPLETE" as const;

export type SealingSegmentProgress = {
  segmentCount: number;
  stationCount: number;
  cardsTotal: number;
};

export function readSealingSegmentCount(
  payload: Record<string, unknown> | null | undefined,
): number {
  if (!payload) return 0;
  const raw = payload.count_total ?? payload.countTotal;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

/** Fold segment events into progress totals (bag-level, all stations). */
export function deriveSealingSegmentProgress(
  events: ReadonlyArray<{
    eventType: string;
    stationId?: string | null;
    payload?: Record<string, unknown> | null;
  }>,
): SealingSegmentProgress {
  const stations = new Set<string>();
  let segmentCount = 0;
  let cardsTotal = 0;

  for (const ev of events) {
    if (ev.eventType !== SEALING_SEGMENT_EVENT) continue;
    segmentCount += 1;
    if (ev.stationId) stations.add(ev.stationId);
    cardsTotal += readSealingSegmentCount(ev.payload ?? null);
  }

  return {
    segmentCount,
    stationCount: stations.size,
    cardsTotal,
  };
}
