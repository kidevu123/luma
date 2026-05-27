export type PauseReasonValue =
  | "pvc_swap"
  | "shift_end"
  | "machine_jam"
  | "qa_check"
  | "other";

export type PauseReason = {
  value: PauseReasonValue;
  label: string;
};

// PVC/foil machine-bound stations: roll swaps and machine jams are real events.
const MACHINE_REASONS: PauseReason[] = [
  { value: "pvc_swap", label: "PVC roll swap" },
  { value: "shift_end", label: "Shift ending" },
  { value: "machine_jam", label: "Machine jam" },
  { value: "qa_check", label: "QA check" },
  { value: "other", label: "Other" },
];

// Hand-work stations: no roll materials, no machine. Time/QA/shift reasons only.
const HAND_REASONS: PauseReason[] = [
  { value: "shift_end", label: "Shift ending" },
  { value: "qa_check", label: "QA check" },
  { value: "other", label: "Other" },
];

const BY_STATION: Partial<Record<string, PauseReason[]>> = {
  BLISTER: MACHINE_REASONS,
  SEALING: MACHINE_REASONS,
  COMBINED: MACHINE_REASONS,
};

/** Pause reason options for a given station kind.
 *  Machine stations (BLISTER, SEALING, COMBINED) include PVC roll swap and
 *  Machine jam. All other stations get hand-work reasons only. */
export function getPauseReasonsForStation(stationKind: string): PauseReason[] {
  return BY_STATION[stationKind] ?? HAND_REASONS;
}
