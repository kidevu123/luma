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
 *  as another kind. COMBINED and HANDPACK_BLISTER both perform the
 *  blister operation; see LEGACY_MACHINE_KIND_TO_OPERATION in
 *  lib/production/routes.ts, which makes the same choice. */
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
