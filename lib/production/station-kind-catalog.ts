// STATION-KIND-FIX-1 — canonical production station kinds by label.
//
// Floor stations are created via Admin → /machines (or legacy manual DB
// inserts). They are NOT seeded by scripts/seed.ts. This catalog is the
// repo source of truth for one-time corrections when a label/kind pair
// drifts (see scripts/fix-station-handpack-kind.ts).

import type { StationKind } from "@/lib/floor-command/types";

/** Label → expected kind for known production floor stations. */
export const STATION_KIND_BY_LABEL: Readonly<Record<string, StationKind>> = {
  "Blister Hand Pack Station": "HANDPACK_BLISTER",
  "Blister Room": "BLISTER",
};

/**
 * Smoke / duplicate stations to deactivate after the real station is
 * corrected — avoids two hand-pack URLs on the floor.
 */
export const STATION_LABELS_TO_DEACTIVATE: readonly string[] = [
  "Hand Pack Blister Smoke",
];

export type StationKindCorrection = {
  label: string;
  expectedKind: StationKind;
  clearMachineId: boolean;
};

export type StationDeactivation = {
  label: string;
};

/** Corrections derived from STATION_KIND_BY_LABEL for the repair script. */
export function plannedKindCorrections(): StationKindCorrection[] {
  return Object.entries(STATION_KIND_BY_LABEL).map(([label, expectedKind]) => ({
    label,
    expectedKind,
    // Hand-pack stations must not be machine-bound; BLISTER room keeps its machine.
    clearMachineId: expectedKind === "HANDPACK_BLISTER",
  }));
}

export function plannedDeactivations(): StationDeactivation[] {
  return STATION_LABELS_TO_DEACTIVATE.map((label) => ({ label }));
}
