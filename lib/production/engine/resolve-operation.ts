// (bag, station) -> the route_operations row that governs this station.
//
// Resolving by station kind rather than by stage is deliberate: the two
// stage vocabularies do not line up (see stage-lexicon.ts), so
// getOperationForStage() in lib/production/routes.ts cannot be called
// with a bag's read_bag_state.stage.
//
// This module resolves by station kind, which is order-agnostic, so it
// needs no changes for P2-BOTTLE-FLEX-1. Any caller that DOES need to
// reason about ordering (e.g. "must X happen before Y") must consult
// RouteOperationView.orderIndependentGroup rather than comparing
// `sequence` directly: operations sharing a non-null group (see
// migration 0071) are order-independent among themselves despite having
// distinct sequence numbers.

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
 *  The HANDPACK_BLISTER entry used to be the live cause of blocker 3 in
 *  the Phase 1 preconditions on advanceBag: aliasing to BLISTER yields
 *  BLISTER_COMPLETE, which ALLOWED_EVENTS_BY_KIND.HANDPACK_BLISTER
 *  rejects. Task 7 works around it downstream —
 *  intentToEventType(intent, operationCode, stationKind) overrides the
 *  event for HANDPACK_BLISTER stations. The alias itself is still
 *  uncorroborated; the real fix is a HANDPACK_BLISTER route operation.
 *  Do not treat this alias as settled. */
const STATION_KIND_ALIAS: Readonly<Record<string, string>> = {
  COMBINED: "BLISTER",
  HANDPACK_BLISTER: "BLISTER",
};

/** Pure: choose the operation a station of this kind performs.
 *
 *  COMBINED-AT-PACKAGING-1 — a COMBINED station fires multiple card-flow
 *  operations: LEGACY_MACHINE_KIND_TO_OPERATION in routes.ts:65-68 and
 *  ALLOWED_EVENTS_BY_KIND.COMBINED in record-stage-event.ts (:97-103)
 *  both list BLISTER_COMPLETE alongside the sealing and packaging event
 *  types. STATION_KIND_ALIAS above only ever aliases COMBINED onto
 *  BLISTER, though, so without a preference every COMBINED gesture
 *  resolves to blister — including a genuinely packaging-shaped one.
 *
 *  opts.preferOperation lets a caller (advanceBag) name the operation
 *  the gesture actually looks like. It is honored ONLY when
 *  `stationKind === "COMBINED"` — deliberately the raw station kind, not
 *  `effective`. HANDPACK_BLISTER also aliases onto BLISTER but is not
 *  COMBINED and must never be handed an operation outside its own
 *  allowedStationKind; gating on the raw kind keeps a plain (non-
 *  COMBINED) station from ever crossing into a foreign op, preference or
 *  not — the preference only WIDENS COMBINED's existing permissiveness,
 *  it never bypasses another kind's guard. If the route has no operation
 *  with that code, the preference is silently dropped and COMBINED falls
 *  back to its ordinary blister match. */
export function pickOperationForStationKind(
  ops: readonly RouteOperationView[],
  stationKind: string,
  opts?: { preferOperation?: string },
): RouteOperationView | null {
  if (opts?.preferOperation && stationKind === "COMBINED") {
    const preferred = ops.find((o) => o.operationCode === opts.preferOperation);
    if (preferred) return preferred;
  }

  const effective = STATION_KIND_ALIAS[stationKind] ?? stationKind;
  const matches = ops
    .filter((o) => o.allowedStationKind === effective)
    .sort((a, b) => a.sequence - b.sequence);
  return matches[0] ?? null;
}

export async function resolveOperation(input: {
  productId: string | null;
  stationKind: string;
  preferOperation?: string;
}): Promise<ResolvedOperation | null> {
  if (!input.productId) return null;

  const route = await getRouteForProduct(input.productId);
  if (!route || !route.routeId) return null;

  const ops = await getRouteOperations(route.routeId);
  const operation = pickOperationForStationKind(
    ops,
    input.stationKind,
    input.preferOperation !== undefined
      ? { preferOperation: input.preferOperation }
      : undefined,
  );
  if (!operation) return null;

  return {
    routeCode: route.routeCode,
    operation,
    source: route.source === "ASSIGNMENT" ? "ROUTE_DATA" : "LEGACY_FALLBACK",
  };
}
