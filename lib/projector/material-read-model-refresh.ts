// Refresh material read models after consumption / roll events.

import type { db as Db } from "@/lib/db";
import { rebuildMaterialBurn } from "@/lib/projector/material-burn";
import { rebuildMaterialConsumptionDaily } from "@/lib/projector/material-consumption-daily";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import {
  rebuildMaterialReconciliationV2,
  rebuildMaterialReconciliationV2ForLot,
} from "@/lib/projector/material-reconciliation-v2";
import { rebuildMaterialRecommendations } from "@/lib/projector/packtrack-recommendations";
import { refreshRollDerivedReadModels } from "@/lib/projector/roll-derived-read-models";
import { getActiveRollLotIdsForStation } from "@/lib/production/active-roll-lot-ids";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type MaterialRefreshOptions = {
  /** Rebuild PO reconciliation v2 rows for these lots only. */
  packagingLotIds?: string[];
  /** Rebuild PackTrack shortage recommendations (heavier). */
  refreshRecommendations?: boolean;
};

async function refreshReconciliationV2ForLots(
  tx: Tx,
  lotIds: string[],
): Promise<void> {
  const unique = [...new Set(lotIds.filter(Boolean))];
  for (const id of unique) {
    await rebuildMaterialReconciliationV2ForLot(tx, id);
  }
}

/** Full material refresh after packaging complete, roll change, etc. */
export async function refreshMaterialReadModelsAfterConsumption(
  tx: Tx,
  opts: MaterialRefreshOptions = {},
): Promise<void> {
  await rebuildMaterialLotState(tx);
  await rebuildMaterialConsumptionDaily(tx);
  await rebuildMaterialBurn(tx);
  await refreshRollDerivedReadModels(tx);
  await refreshReconciliationV2ForLots(tx, opts.packagingLotIds ?? []);
  if (opts.refreshRecommendations) {
    await rebuildMaterialRecommendations(tx);
  }
}

/** Lighter refresh after each blister complete (segments + runway + learning). */
export async function refreshMaterialReadModelsAfterBlister(
  tx: Tx,
  stationId: string,
): Promise<void> {
  const lotIds = await getActiveRollLotIdsForStation(stationId);
  await refreshRollDerivedReadModels(tx);
  await rebuildMaterialBurn(tx);
  await refreshReconciliationV2ForLots(tx, lotIds);
}

/** Admin / script: rebuild all material projections. */
export async function rebuildAllMaterialProjections(tx: Tx): Promise<void> {
  await rebuildMaterialLotState(tx);
  await rebuildMaterialConsumptionDaily(tx);
  await rebuildMaterialBurn(tx);
  await refreshRollDerivedReadModels(tx);
  await rebuildMaterialReconciliationV2(tx);
  await rebuildMaterialRecommendations(tx);
}
