// STATION-MOBILE-UX-1/2 — which optional floor sub-pages and panels belong on a station.
// Validation / supervisor tools only; primary operator flow stays on page.tsx.

import { STATION_AUTO_MATERIAL_KINDS } from "@/lib/production/auto-load-lots";

/** PVC / foil roll mount, weigh, change-roll (blister press only — not sealing). */
export const FLOOR_ROLL_STATION_KINDS = new Set([
  "BLISTER",
  "COMBINED",
]);

export type FloorSupervisorToolId = "rolls";

export type FloorSupervisorToolLink = {
  id: FloorSupervisorToolId;
  href: string;
  label: string;
};

export function floorSupervisorToolsForStation(
  token: string,
  stationKind: string,
): FloorSupervisorToolLink[] {
  if (FLOOR_ROLL_STATION_KINDS.has(stationKind)) {
    return [
      {
        id: "rolls",
        href: `/floor/${token}/rolls`,
        label: "Rolls",
      },
    ];
  }
  return [];
}

/** Loaded-material panel (unit lots) — not roll mount; see auto-load-lots. */
export function stationShowsLoadedMaterialsPanel(stationKind: string): boolean {
  return stationKind in STATION_AUTO_MATERIAL_KINDS;
}

/** Compact subtitle under station name (kind + machine when bound). */
export function formatStationPageSubtitle(
  stationKind: string,
  machineName: string | null | undefined,
): string {
  const kindLabel = stationKind.replace(/_/g, " ").toLowerCase();
  return machineName ? `${kindLabel} · ${machineName}` : kindLabel;
}
