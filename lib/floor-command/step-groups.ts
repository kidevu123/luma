// lib/floor-command/step-groups.ts

import type { StationKind, StationWithLive, StepGroup } from "./types";

export const STEP_GROUP_DEFS: { label: string; kinds: StationKind[] }[] = [
  { label: "Filling",   kinds: ["BLISTER", "BOTTLE_HANDPACK"] },
  { label: "Sealing",   kinds: ["SEALING", "BOTTLE_CAP_SEAL"] },
  { label: "Finishing", kinds: ["PACKAGING", "BOTTLE_STICKER", "COMBINED"] },
  { label: "Pack Out",  kinds: ["HANDPACK_BLISTER"] },
];

// Pack-out station kinds render as operator grids, not machine SVGs.
export const PACK_OUT_KINDS: StationKind[] = ["HANDPACK_BLISTER", "COMBINED"];

export function groupStationsByStep(stations: StationWithLive[]): StepGroup[] {
  return STEP_GROUP_DEFS
    .map((def) => ({
      label: def.label,
      kinds: def.kinds,
      stations: stations.filter((s) => def.kinds.includes(s.kind)),
    }))
    .filter((g) => g.stations.length > 0);
}
