// PT-7D — loader for the /material-alerts shortage-recommendation section.
//
// Reads from read_material_recommendations (PT-7C). Does NOT recalculate
// shortage math — that's PT-7B / PT-7C territory. The UI only renders
// what's already persisted.
//
// Filters:
//   - status:           "ACTIVE" (default — excludes dismissed) | "ACKNOWLEDGED" | "DISMISSED" | "ALL"
//   - severity:         subset of CRITICAL / HIGH / MEDIUM / WATCH
//   - confidence:       subset of HIGH / MEDIUM / LOW / MISSING
//   - sendableOnly:     when true, only rows with sendable_to_packtrack = true
//   - missingConfigOnly:when true, only rows whose missing_inputs[] is non-empty
//   - productId:        scope to one product (or `null` literal for material-wide rows)
//   - materialId:       scope to one material
//
// SQL pushes the status filter (it shapes the partial-unique index path
// and is the cheapest way to exclude dismissed by default). Everything
// else filters in-memory after the fetch — recommendation rows are
// small in number and the in-memory filter is the same one the tests
// exercise.

import { and, desc, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { readMaterialRecommendations } from "@/lib/db/schema";
import type {
  ShortageConfidence,
  ShortageSeverity,
  ShortageSignal,
} from "@/lib/production/packtrack-shortage";

export type RecommendationStatusFilter =
  | "ACTIVE"
  | "ACKNOWLEDGED"
  | "DISMISSED"
  | "ALL";

export type RecommendationFilters = {
  status?: RecommendationStatusFilter;
  severity?: ShortageSeverity[];
  confidence?: ShortageConfidence[];
  sendableOnly?: boolean;
  missingConfigOnly?: boolean;
  productId?: string | "MATERIAL_WIDE" | null;
  materialId?: string | null;
};

export type RecommendationRow = {
  id: string;
  recommendationId: string;
  materialId: string;
  materialCode: string;
  materialName: string;
  productId: string | null;
  productName: string | null;
  productSku: string | null;
  compatibilityRole: string | null;
  currentOnHand: number | null;
  acceptedInventory: number | null;
  projectedDemand: number | null;
  projectedShortageQuantity: number | null;
  recommendedOrderQuantity: number | null;
  neededByDate: string | null;
  confidence: ShortageConfidence;
  severity: ShortageSeverity;
  reason: string;
  sourceSignals: ShortageSignal[];
  missingInputs: string[];
  warnings: string[];
  sendableToPackTrack: boolean;
  generatedAt: Date;
  expiresAt: Date | null;
  acknowledgedAt: Date | null;
  dismissedAt: Date | null;
  recommendedSupplierHint: string | null;
};

/** Pure in-memory filter — exported so tests can exercise filter
 *  logic without a DB, and the loader can call it after a coarse fetch. */
export function filterRecommendations(
  rows: RecommendationRow[],
  filters: RecommendationFilters,
): RecommendationRow[] {
  return rows.filter((r) => {
    // Status — when ACTIVE (default), dismissed rows are hidden and
    // acknowledged rows are included (operators still want to see
    // what they've already taken action on).
    const status = filters.status ?? "ACTIVE";
    if (status === "ACTIVE") {
      if (r.dismissedAt != null) return false;
    } else if (status === "ACKNOWLEDGED") {
      if (r.acknowledgedAt == null) return false;
    } else if (status === "DISMISSED") {
      if (r.dismissedAt == null) return false;
    }

    if (filters.severity && filters.severity.length > 0) {
      if (!filters.severity.includes(r.severity)) return false;
    }
    if (filters.confidence && filters.confidence.length > 0) {
      if (!filters.confidence.includes(r.confidence)) return false;
    }
    if (filters.sendableOnly && !r.sendableToPackTrack) return false;
    if (filters.missingConfigOnly && r.missingInputs.length === 0) {
      return false;
    }
    if (filters.materialId && r.materialId !== filters.materialId) {
      return false;
    }
    if (filters.productId !== undefined) {
      if (filters.productId === "MATERIAL_WIDE") {
        if (r.productId !== null) return false;
      } else if (filters.productId === null) {
        // explicit null (kept for symmetry with MATERIAL_WIDE) — same meaning
        if (r.productId !== null) return false;
      } else {
        if (r.productId !== filters.productId) return false;
      }
    }
    return true;
  });
}

/** Loader. Fetches the working window from the DB (the status filter
 *  is pushed to SQL), then applies the remaining filters in memory and
 *  returns typed rows. */
export async function loadMaterialRecommendations(
  filters: RecommendationFilters = {},
): Promise<RecommendationRow[]> {
  const status = filters.status ?? "ACTIVE";

  const where =
    status === "ACTIVE"
      ? isNull(readMaterialRecommendations.dismissedAt)
      : status === "ACKNOWLEDGED"
        ? isNotNull(readMaterialRecommendations.acknowledgedAt)
        : status === "DISMISSED"
          ? isNotNull(readMaterialRecommendations.dismissedAt)
          : undefined;

  const baseQuery = db
    .select()
    .from(readMaterialRecommendations);
  const dbRows = await (where
    ? baseQuery
        .where(and(where, isNull(readMaterialRecommendations.supersededBy)))
        .orderBy(desc(readMaterialRecommendations.generatedAt))
    : baseQuery
        .where(isNull(readMaterialRecommendations.supersededBy))
        .orderBy(desc(readMaterialRecommendations.generatedAt)));

  const mapped: RecommendationRow[] = dbRows.map((d) => ({
    id: d.id,
    recommendationId: d.recommendationId,
    materialId: d.materialId,
    materialCode: d.materialCode,
    materialName: d.materialName,
    productId: d.productId,
    productName: d.productName,
    productSku: d.productSku,
    compatibilityRole: d.compatibilityRole,
    currentOnHand: d.currentOnHand != null ? Number(d.currentOnHand) : null,
    acceptedInventory:
      d.acceptedInventory != null ? Number(d.acceptedInventory) : null,
    projectedDemand:
      d.projectedDemand != null ? Number(d.projectedDemand) : null,
    projectedShortageQuantity:
      d.projectedShortageQuantity != null
        ? Number(d.projectedShortageQuantity)
        : null,
    recommendedOrderQuantity:
      d.recommendedOrderQuantity != null
        ? Number(d.recommendedOrderQuantity)
        : null,
    neededByDate: d.neededByDate,
    confidence: d.confidence as ShortageConfidence,
    severity: d.severity as ShortageSeverity,
    reason: d.reason,
    sourceSignals: (d.sourceSignals as unknown as ShortageSignal[]) ?? [],
    missingInputs: (d.missingInputs as unknown as string[]) ?? [],
    warnings: (d.warnings as unknown as string[]) ?? [],
    sendableToPackTrack: d.sendableToPackTrack,
    generatedAt: d.generatedAt,
    expiresAt: d.expiresAt,
    acknowledgedAt: d.acknowledgedAt,
    dismissedAt: d.dismissedAt,
    recommendedSupplierHint: d.recommendedSupplierHint,
  }));

  return filterRecommendations(mapped, filters);
}

/** Convenience counters used by the page header / badge group.
 *  Computed off a single fetch so the page doesn't round-trip twice. */
export type RecommendationCounters = {
  active: number;
  acknowledged: number;
  dismissed: number;
  sendable: number;
  missingConfig: number;
  bySeverity: Record<ShortageSeverity, number>;
};

export function countRecommendations(
  rows: RecommendationRow[],
): RecommendationCounters {
  const bySeverity: Record<ShortageSeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    WATCH: 0,
  };
  let active = 0;
  let acknowledged = 0;
  let dismissed = 0;
  let sendable = 0;
  let missingConfig = 0;
  for (const r of rows) {
    if (r.dismissedAt != null) dismissed += 1;
    else active += 1;
    if (r.acknowledgedAt != null) acknowledged += 1;
    if (r.sendableToPackTrack && r.dismissedAt == null) sendable += 1;
    if (r.missingInputs.length > 0 && r.dismissedAt == null) {
      missingConfig += 1;
    }
    if (r.dismissedAt == null) {
      bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    }
  }
  return { active, acknowledged, dismissed, sendable, missingConfig, bySeverity };
}

