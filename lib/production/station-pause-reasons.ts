import type { StationKind } from "@/lib/floor-command/types";

export type PauseReasonValue =
  | "pvc_swap"
  | "foil_swap"
  | "shift_end"
  | "shift_break"
  | "machine_jam"
  | "qa_check"
  | "other";

export type PauseReason = {
  value: PauseReasonValue;
  label: string;
};

const PVC_SWAP: PauseReason = { value: "pvc_swap", label: "PVC roll swap" };
const FOIL_SWAP: PauseReason = { value: "foil_swap", label: "Foil roll swap" };
const SHIFT_END: PauseReason = { value: "shift_end", label: "Shift ending" };
const SHIFT_BREAK: PauseReason = { value: "shift_break", label: "Shift break" };
const MACHINE_JAM: PauseReason = {
  value: "machine_jam",
  label: "Machine jam",
};
const QA_CHECK: PauseReason = { value: "qa_check", label: "QA check" };
const OTHER: PauseReason = { value: "other", label: "Other" };

/** Blister press stations — roll swap pauses surface a roll-change card. */
const BLISTER_MACHINE_REASONS: readonly PauseReason[] = [
  SHIFT_END,
  SHIFT_BREAK,
  PVC_SWAP,
  FOIL_SWAP,
  MACHINE_JAM,
  QA_CHECK,
  OTHER,
];

/** Sealing machines: jams yes, PVC roll swap no. */
const SEALING_MACHINE_REASONS: readonly PauseReason[] = [
  SHIFT_END,
  SHIFT_BREAK,
  MACHINE_JAM,
  QA_CHECK,
  OTHER,
];

/** Hand-work stations: no roll materials, no machine in the station model. */
const HAND_WORK_REASONS: readonly PauseReason[] = [
  SHIFT_END,
  SHIFT_BREAK,
  QA_CHECK,
  OTHER,
];

/**
 * Station → pause options (UI filter only; server still accepts full enum).
 * STATION-PAUSE-2 matrix — conservative: no PVC/machine on hand-work kinds.
 * STATION-SEALING-TOOLS-1 — SEALING excludes PVC roll swap (no foil/PVC rolls).
 */
export const STATION_PAUSE_REASON_MATRIX: Record<StationKind, PauseReason[]> = {
  BLISTER: [...BLISTER_MACHINE_REASONS],
  SEALING: [...SEALING_MACHINE_REASONS],
  COMBINED: [...BLISTER_MACHINE_REASONS],
  HANDPACK_BLISTER: [...HAND_WORK_REASONS],
  BOTTLE_HANDPACK: [...HAND_WORK_REASONS],
  PACKAGING: [...HAND_WORK_REASONS],
  BOTTLE_CAP_SEAL: [...HAND_WORK_REASONS],
  BOTTLE_STICKER: [...HAND_WORK_REASONS],
};

function isStationKind(kind: string): kind is StationKind {
  return kind in STATION_PAUSE_REASON_MATRIX;
}

/** Pause reason options for a station kind (floor dropdown). */
export function getPauseReasonsForStation(stationKind: string): PauseReason[] {
  if (isStationKind(stationKind)) {
    return STATION_PAUSE_REASON_MATRIX[stationKind];
  }
  return [...HAND_WORK_REASONS];
}

/** First option in the station list — used as the default selection. */
export function getDefaultPauseReasonForStation(
  stationKind: string,
): PauseReasonValue {
  return getPauseReasonsForStation(stationKind)[0]?.value ?? "other";
}
