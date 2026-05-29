// PACKAGING-PENDING-CONSUMPTION-HONESTY-1 — refresh material read models after consumption.

import type { db as Db } from "@/lib/db";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import { rebuildMaterialConsumptionDaily } from "@/lib/projector/material-consumption-daily";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Rebuild lot state + daily consumption rollups after inventory events land. */
export async function refreshMaterialReadModelsAfterConsumption(
  tx: Tx,
): Promise<void> {
  await rebuildMaterialLotState(tx);
  await rebuildMaterialConsumptionDaily(tx);
}
