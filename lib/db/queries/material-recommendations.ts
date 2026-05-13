// PT-7D — loader for the /material-alerts shortage-recommendation section.
//
// Reads from read_material_recommendations (PT-7C). The pure filter +
// types live in lib/production/material-recommendations-filter.ts so
// the client bundle never has to import the postgres client.

import { and, desc, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { readMaterialRecommendations } from "@/lib/db/schema";
import {
  filterRecommendations,
  type RecommendationFilters,
  type RecommendationRow,
  type RecommendationStatusFilter,
} from "@/lib/production/material-recommendations-filter";
import type {
  ShortageConfidence,
  ShortageSeverity,
  ShortageSignal,
} from "@/lib/production/packtrack-shortage";

// Re-export types as a convenience for any server-side callers that
// only need the types — they can import from one place.
export type {
  RecommendationFilters,
  RecommendationRow,
  RecommendationStatusFilter,
} from "@/lib/production/material-recommendations-filter";

/** SQL pushes only the `status` axis (cheapest, hits the partial-
 *  unique index path). All other filters apply in memory via
 *  filterRecommendations. */
export async function loadMaterialRecommendations(
  filters: RecommendationFilters = {},
): Promise<RecommendationRow[]> {
  const status = filters.status ?? "ACTIVE";

  const statusWhere =
    status === "ACTIVE"
      ? isNull(readMaterialRecommendations.dismissedAt)
      : status === "ACKNOWLEDGED"
        ? isNotNull(readMaterialRecommendations.acknowledgedAt)
        : status === "DISMISSED"
          ? isNotNull(readMaterialRecommendations.dismissedAt)
          : undefined;

  const dbRows = await db
    .select()
    .from(readMaterialRecommendations)
    .where(
      statusWhere
        ? and(statusWhere, isNull(readMaterialRecommendations.supersededBy))
        : isNull(readMaterialRecommendations.supersededBy),
    )
    .orderBy(desc(readMaterialRecommendations.generatedAt));

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
