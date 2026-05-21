// Phase H.x0 — Route / operation compatibility helpers.
//
// This module is the single read-side bridge between today's hardcoded
// CARD/BOTTLE assumptions and the route_operations table that lives in
// data. New code should resolve routes through these helpers; legacy
// code keeps working unchanged because the helpers fall back to the
// legacy enum lexicon when no row is present.
//
// Nothing here writes events or mutates the projector. The intent is:
//   1. give a new feature a clean way to ask "what stage comes next
//      for this product?" without grepping STAGE_FOR_EVENT.
//   2. document the legacy mapping in one place so the remaining
//      hardcoded sites (lib/projector/index.ts, ALLOWED_EVENTS_BY_KIND,
//      etc.) can be migrated incrementally.

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  operationTypes,
  productionRoutes,
  productRouteAssignments,
  routeOperations,
  routeStationPermissions,
} from "@/lib/db/schema";

// ─── Legacy mapping tables (kept here so all the hardcoding lives in
//     one file, ready to delete once the data-driven path is universal).

/** Legacy product.kind → seeded production_routes.code. */
export const LEGACY_PRODUCT_KIND_TO_ROUTE: Readonly<Record<string, string>> = {
  CARD: "CARD_BLISTER",
  BOTTLE: "BOTTLE",
  // VARIETY mixes sources from CARD and BOTTLE products. Variety
  // packs themselves are assembled via the CARD packaging route at
  // case level. Surface that as a sensible default; admins can
  // override per-product.
  VARIETY: "CARD_BLISTER",
};

/** Legacy workflow_event_type → operation_types.code. Mirrors the
 *  STAGE_FOR_EVENT semantics in lib/projector/index.ts but without
 *  the throughput-counter coupling. */
export const LEGACY_EVENT_TYPE_TO_OPERATION: Readonly<Record<string, string>> = {
  CARD_ASSIGNED: "RECEIVING",
  BAG_VERIFIED: "RECEIVING",
  BLISTER_COMPLETE: "BLISTER",
  SEALING_COMPLETE: "HEAT_SEAL",
  PACKAGING_SNAPSHOT: "PACKAGING",
  PACKAGING_COMPLETE: "PACKAGING",
  BOTTLE_HANDPACK_COMPLETE: "BOTTLE_FILL",
  BOTTLE_CAP_SEAL_COMPLETE: "INDUCTION_SEAL",
  BOTTLE_STICKER_COMPLETE: "STICKERING",
  BAG_FINALIZED: "FINISHED_GOODS",
};

/** Legacy machine.kind / station.kind → operation_types.code.
 *  COMBINED is permissive (card flow only today). */
export const LEGACY_MACHINE_KIND_TO_OPERATION: Readonly<Record<string, string>> = {
  BLISTER: "BLISTER",
  SEALING: "HEAT_SEAL",
  PACKAGING: "PACKAGING",
  BOTTLE_HANDPACK: "BOTTLE_FILL",
  BOTTLE_STICKER: "STICKERING",
  BOTTLE_CAP_SEAL: "INDUCTION_SEAL",
  // No 1:1 — COMBINED stations can fire multiple card-flow operations.
  // Helpers that need to disambiguate should use the event_type rather
  // than the station kind.
  COMBINED: "BLISTER",
};

// ─── Pure helpers (no DB access; deterministic) ─────────────────────

export function legacyProductKindToRoute(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return LEGACY_PRODUCT_KIND_TO_ROUTE[kind] ?? null;
}

export function legacyEventTypeToOperation(eventType: string | null | undefined): string | null {
  if (!eventType) return null;
  return LEGACY_EVENT_TYPE_TO_OPERATION[eventType] ?? null;
}

export function legacyMachineKindToOperation(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return LEGACY_MACHINE_KIND_TO_OPERATION[kind] ?? null;
}

// ─── Database-backed helpers ────────────────────────────────────────
//
// All helpers degrade gracefully:
//   • If the route is not configured, return null + log nothing.
//   • Callers must handle null and either fall back to legacy or
//     surface a "Route not configured" missing state in the UI.

export type RouteOperationView = {
  routeCode: string;
  routeName: string;
  sequence: number;
  operationCode: string;
  operationName: string;
  stageKey: string;
  nextStageKey: string | null;
  reworkStageKey: string | null;
  allowedStationKind: string | null;
  allowedMachineKind: string | null;
  requiresScan: boolean;
  requiresCounter: boolean;
  requiresTimer: boolean;
  outputUnit: string | null;
};

/** Get the active route assignment for a product. Falls back to the
 *  legacy product.kind mapping when no explicit assignment exists.
 *  Returns null when neither is resolvable. */
export async function getRouteForProduct(productId: string): Promise<{
  routeId: string;
  routeCode: string;
  source: "ASSIGNMENT" | "LEGACY_KIND" | "MISSING";
} | null> {
  const direct = await db
    .select({
      routeId: productRouteAssignments.routeId,
      routeCode: productionRoutes.code,
    })
    .from(productRouteAssignments)
    .innerJoin(
      productionRoutes,
      eq(productionRoutes.id, productRouteAssignments.routeId),
    )
    .where(
      and(
        eq(productRouteAssignments.productId, productId),
        eq(productRouteAssignments.isActive, true),
        eq(productRouteAssignments.isDefault, true),
      ),
    )
    .limit(1);

  if (direct[0]) {
    return { routeId: direct[0].routeId, routeCode: direct[0].routeCode, source: "ASSIGNMENT" };
  }

  // Fall back to legacy product.kind mapping.
  const productRow = await db.execute<{ kind: string }>(
    sql`SELECT kind::text AS kind FROM products WHERE id = ${productId} LIMIT 1`,
  );
  const kind = (productRow as unknown as { kind: string }[])[0]?.kind;
  const fallbackCode = legacyProductKindToRoute(kind);
  if (!fallbackCode) {
    return { routeId: "", routeCode: "", source: "MISSING" };
  }
  const route = await db
    .select({ id: productionRoutes.id, code: productionRoutes.code })
    .from(productionRoutes)
    .where(eq(productionRoutes.code, fallbackCode))
    .limit(1);
  if (!route[0]) return { routeId: "", routeCode: fallbackCode, source: "MISSING" };
  return { routeId: route[0].id, routeCode: route[0].code, source: "LEGACY_KIND" };
}

/** Ordered operations for a route, joined with operation_types for
 *  human-readable labels. Returns [] when the route has no operations
 *  configured (e.g. CUSTOM placeholder). */
export async function getRouteOperations(routeId: string): Promise<RouteOperationView[]> {
  if (!routeId) return [];
  const rows = await db
    .select({
      routeCode: productionRoutes.code,
      routeName: productionRoutes.name,
      sequence: routeOperations.sequence,
      operationCode: operationTypes.code,
      operationName: operationTypes.name,
      stageKey: routeOperations.stageKey,
      nextStageKey: routeOperations.nextStageKey,
      reworkStageKey: routeOperations.reworkStageKey,
      allowedStationKind: routeOperations.allowedStationKind,
      allowedMachineKind: routeOperations.allowedMachineKind,
      requiresScan: routeOperations.requiresScan,
      requiresCounter: routeOperations.requiresCounter,
      requiresTimer: routeOperations.requiresTimer,
      outputUnit: routeOperations.outputUnit,
    })
    .from(routeOperations)
    .innerJoin(productionRoutes, eq(productionRoutes.id, routeOperations.routeId))
    .innerJoin(operationTypes, eq(operationTypes.id, routeOperations.operationTypeId))
    .where(
      and(
        eq(routeOperations.routeId, routeId),
        eq(routeOperations.isActive, true),
      ),
    )
    .orderBy(asc(routeOperations.sequence));
  return rows;
}

/** Lookup the route_operation row for a given (route, stage). NULL
 *  when no operation handles this stage in this route. */
export async function getOperationForStage(
  routeId: string,
  stageKey: string,
): Promise<RouteOperationView | null> {
  if (!routeId || !stageKey) return null;
  const ops = await getRouteOperations(routeId);
  return ops.find((op) => op.stageKey === stageKey) ?? null;
}

export type AllowedStationView = {
  stationId: string | null;
  machineId: string | null;
  stationKind: string | null;
  machineKind: string | null;
};

/** Permissions for a route_operation. When no rows exist, the helper
 *  falls back to the operation's own allowed_station_kind /
 *  allowed_machine_kind columns so route operations work without
 *  per-station permission rows in v1. */
export async function getAllowedStationsForOperation(
  routeOperationId: string,
): Promise<AllowedStationView[]> {
  if (!routeOperationId) return [];
  const explicit = await db
    .select({
      stationId: routeStationPermissions.stationId,
      machineId: routeStationPermissions.machineId,
      stationKind: routeStationPermissions.stationKind,
      machineKind: routeStationPermissions.machineKind,
    })
    .from(routeStationPermissions)
    .where(
      and(
        eq(routeStationPermissions.routeOperationId, routeOperationId),
        eq(routeStationPermissions.isActive, true),
      ),
    );

  if (explicit.length > 0) return explicit;

  // Fall back to the operation's own allowed_station_kind / machine_kind.
  const op = await db
    .select({
      stationKind: routeOperations.allowedStationKind,
      machineKind: routeOperations.allowedMachineKind,
    })
    .from(routeOperations)
    .where(eq(routeOperations.id, routeOperationId))
    .limit(1);
  if (!op[0]) return [];
  if (op[0].stationKind == null && op[0].machineKind == null) return [];
  return [
    {
      stationId: null,
      machineId: null,
      stationKind: op[0].stationKind,
      machineKind: op[0].machineKind,
    },
  ];
}
