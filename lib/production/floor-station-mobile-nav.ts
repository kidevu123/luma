// STATION-MOBILE-UX-1 — which optional floor sub-pages belong on a station.
// Validation / supervisor tools only; primary operator flow stays on page.tsx.

/** PVC / foil roll mount, weigh, change-roll (machine-bound). */
export const FLOOR_ROLL_STATION_KINDS = new Set([
  "BLISTER",
  "COMBINED",
  "SEALING",
]);

/** Partial raw-bag allocation sessions (VALIDATION-2A machine feed). */
export const FLOOR_BAG_ALLOCATION_STATION_KINDS = new Set([
  "BLISTER",
  "COMBINED",
]);

/** Multi-component variety-pack allocation (VALIDATION-2A). */
export const FLOOR_VARIETY_PACK_STATION_KINDS = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "COMBINED",
  "BOTTLE_HANDPACK",
]);

export type FloorSupervisorToolId = "rolls" | "bag-allocation" | "variety-pack";

export type FloorSupervisorToolLink = {
  id: FloorSupervisorToolId;
  href: string;
  label: string;
};

export function floorSupervisorToolsForStation(
  token: string,
  stationKind: string,
): FloorSupervisorToolLink[] {
  const links: FloorSupervisorToolLink[] = [];
  if (FLOOR_ROLL_STATION_KINDS.has(stationKind)) {
    links.push({
      id: "rolls",
      href: `/floor/${token}/rolls`,
      label: "Rolls",
    });
  }
  if (FLOOR_BAG_ALLOCATION_STATION_KINDS.has(stationKind)) {
    links.push({
      id: "bag-allocation",
      href: `/floor/${token}/bag-allocation`,
      label: "Bag allocation",
    });
  }
  if (FLOOR_VARIETY_PACK_STATION_KINDS.has(stationKind)) {
    links.push({
      id: "variety-pack",
      href: `/floor/${token}/variety-pack`,
      label: "Variety pack",
    });
  }
  return links;
}
