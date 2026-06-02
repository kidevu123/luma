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

/** Floor copy — segment counts, not lifetime machine totals. */
export const BLISTER_COUNTER_SEGMENT_SINCE_RESET =
  "good blisters/cards since the last physical machine counter reset";

export function pauseCounterSnapshotFieldLabel(reason: string): string {
  if (reason === "shift_end") return "Counter snapshot at shift end";
  if (reason === "machine_jam") return "Counter snapshot at machine jam";
  return "Counter snapshot at pause";
}

export function pauseCounterSnapshotHelperText(reason: string): string {
  const base = `Enter ${BLISTER_COUNTER_SEGMENT_SINCE_RESET}. Save this count before resetting the physical machine counter.`;
  if (reason === "shift_end") {
    return `${base} After saving, reset the physical counter per floor procedure. If you already reset the counter, stop and call a supervisor — do not guess.`;
  }
  if (reason === "machine_jam") {
    return `${base} After saving, reset the physical counter if required before clearing the jam and resuming. If you already reset the counter, stop and call a supervisor.`;
  }
  return base;
}

export function pauseCounterSnapshotMissingError(reason: string): string {
  if (reason === "shift_end") {
    return "Enter the end-shift counter snapshot before confirming pause.";
  }
  if (reason === "machine_jam") {
    return "Enter the machine-jam counter snapshot before confirming pause.";
  }
  return "Enter the required counter snapshot before confirming pause.";
}

export function shiftEndCounterSnapshotMissingError(): string {
  return "Enter the end-shift counter snapshot before ending shift.";
}

export function shiftEndCounterSnapshotHelperText(): string {
  return `${pauseCounterSnapshotHelperText("shift_end")} End shift after the snapshot is saved.`;
}

export function rollChangeCounterHelperText(role: "PVC" | "FOIL"): string {
  const label = role === "PVC" ? "PVC" : "foil";
  return `Enter ${BLISTER_COUNTER_SEGMENT_SINCE_RESET} on the ${label} roll being removed. This count applies to both active rolls (PVC + foil) and the current bag. The replacement roll starts after you save. Reset the physical machine counter only after this snapshot is saved. If you already reset the counter, stop and call a supervisor.`;
}

export function blisterCloseOutCounterHelperText(): string {
  return `Enter ${BLISTER_COUNTER_SEGMENT_SINCE_RESET} for this bag's final segment. Save before resetting the physical machine counter. Counts already captured during pause or roll change are separate segments — do not re-enter them here unless that production is still on the machine counter. If you already reset the counter, stop and call a supervisor.`;
}
