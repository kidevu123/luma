// (bag, station) -> the route_operations row that governs this station.
//
// Resolving by station kind rather than by stage is deliberate: the two
// stage vocabularies do not line up (see stage-lexicon.ts), so
// getOperationForStage() in lib/production/routes.ts cannot be called
// with a bag's read_bag_state.stage.

import {
  getRouteForProduct,
  getRouteOperations,
  type RouteOperationView,
} from "@/lib/production/routes";

export type ResolvedOperation = {
  routeCode: string;
  operation: RouteOperationView;
  source: "ROUTE_DATA" | "LEGACY_FALLBACK";
};

/** Station kinds that are not themselves route operations but behave
 *  as another kind. Both perform the blister operation, but only ONE of
 *  them is corroborated elsewhere:
 *
 *    COMBINED -> BLISTER matches LEGACY_MACHINE_KIND_TO_OPERATION in
 *    lib/production/routes.ts:58-69.
 *
 *    HANDPACK_BLISTER -> BLISTER is this module's own choice. That table
 *    has NO HANDPACK_BLISTER key at all, so nothing corroborates it.
 *
 *  The HANDPACK_BLISTER entry is the live cause of blocker 3 in the
 *  Phase 2 preconditions on advanceBag (lib/production/engine/advance.ts):
 *  aliasing to BLISTER yields BLISTER_COMPLETE, which
 *  ALLOWED_EVENTS_BY_KIND.HANDPACK_BLISTER rejects. Do not treat this
 *  alias as settled. */
const STATION_KIND_ALIAS: Readonly<Record<string, string>> = {
  COMBINED: "BLISTER",
  HANDPACK_BLISTER: "BLISTER",
};

/** Pure: choose the operation a station of this kind performs. */
export function pickOperationForStationKind(
  ops: readonly RouteOperationView[],
  stationKind: string,
): RouteOperationView | null {
  const effective = STATION_KIND_ALIAS[stationKind] ?? stationKind;
  const matches = ops
    .filter((o) => o.allowedStationKind === effective)
    .sort((a, b) => a.sequence - b.sequence);
  return matches[0] ?? null;
}

export async function resolveOperation(input: {
  productId: string | null;
  stationKind: string;
}): Promise<ResolvedOperation | null> {
  if (!input.productId) return null;

  const route = await getRouteForProduct(input.productId);
  if (!route || !route.routeId) return null;

  const ops = await getRouteOperations(route.routeId);
  const operation = pickOperationForStationKind(ops, input.stationKind);
  if (!operation) return null;

  return {
    routeCode: route.routeCode,
    operation,
    source: route.source === "ASSIGNMENT" ? "ROUTE_DATA" : "LEGACY_FALLBACK",
  };
}
