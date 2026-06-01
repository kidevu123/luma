export const BLISTER_COUNTER_SNAPSHOT_STATION_KINDS = new Set([
  "BLISTER",
  "COMBINED",
]);

export const BLISTER_COUNTER_SNAPSHOT_PAUSE_REASONS = new Set([
  "machine_jam",
  "shift_end",
]);

export function isBlisterCounterSnapshotStation(stationKind: string): boolean {
  return BLISTER_COUNTER_SNAPSHOT_STATION_KINDS.has(stationKind);
}

export function stationRequiresBlisterCounterSnapshot(
  stationKind: string,
  reason: string,
): boolean {
  return (
    isBlisterCounterSnapshotStation(stationKind) &&
    BLISTER_COUNTER_SNAPSHOT_PAUSE_REASONS.has(reason)
  );
}

export function parseNonnegativeIntegerInput(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}
