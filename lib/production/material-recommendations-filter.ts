// PT-7D — pure filter / counter helpers for shortage recommendations.
//
// Lives outside lib/db/queries so the client bundle of
// _recommendations-panel.tsx never has to drag the postgres client
// into the browser. The server-side loader in
// lib/db/queries/material-recommendations.ts re-uses these helpers.

import type {
  ShortageConfidence,
  ShortageSeverity,
  ShortageSignal,
} from "./packtrack-shortage";

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

export function filterRecommendations(
  rows: RecommendationRow[],
  filters: RecommendationFilters,
): RecommendationRow[] {
  return rows.filter((r) => {
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
        if (r.productId !== null) return false;
      } else {
        if (r.productId !== filters.productId) return false;
      }
    }
    return true;
  });
}

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
