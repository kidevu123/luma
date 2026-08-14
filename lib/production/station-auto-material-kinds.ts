// Which packaging material kinds a station auto-loads. A CONSTANT, split
// out of auto-load-lots.ts (P4b Task 5) so pure consumers do not have to
// drag that module's `db` import with them.
//
// floor-station-mobile-nav.ts reads it, the operator screen reads THAT
// through the engine's client barrel, and a client bundle must not
// contain the Postgres driver. auto-load-lots.ts re-exports it, so every
// existing import path still resolves to this one object.
export const STATION_AUTO_MATERIAL_KINDS: Record<string, string[]> = {
  HANDPACK_BLISTER: ["BLISTER_CARD"],
  BOTTLE_HANDPACK: ["BOTTLE", "CAP"],
  BOTTLE_CAP_SEAL: ["INDUCTION_SEAL"],
};
