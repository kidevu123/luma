// Rebuild roll yield read models after mount / segment / deplete events.

import type { db as Db } from "@/lib/db";
import { rebuildMaterialUsageLearning } from "@/lib/projector/material-usage-learning";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Keep read_roll_usage and read_material_usage_learning in sync with floor roll actions. */
export async function refreshRollDerivedReadModels(tx: Tx): Promise<void> {
  await rebuildRollUsage(tx);
  await rebuildMaterialUsageLearning(tx);
}
