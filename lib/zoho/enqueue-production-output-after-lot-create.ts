// Consolidated production-output enqueue after finished lot creation.
// Runs when ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED=true (independent of commit).

import { writeAudit } from "@/lib/db/audit";
import { upsertConsolidatedProductionOutputOpForLot } from "@/lib/db/queries/zoho-production-output-consolidated";
import {
  isProductionOutputPersistEnabled,
  validateProductionOutputServiceConfig,
} from "@/lib/zoho/production-output-config";

export type ProductionOutputEnqueueAfterLotCreateInput = {
  finishedLotId: string;
  actor: {
    id: string | null;
    role: "OWNER" | "ADMIN" | "MANAGER" | "LEAD" | "STAFF" | null;
  };
};

export type ProductionOutputEnqueueAfterLotCreateResult =
  | { ok: true; opId: string; status: string; queued: boolean }
  | { ok: false; reason: string };

export async function runProductionOutputEnqueueAfterLotCreate(
  input: ProductionOutputEnqueueAfterLotCreateInput,
): Promise<ProductionOutputEnqueueAfterLotCreateResult> {
  if (!isProductionOutputPersistEnabled()) {
    return { ok: false, reason: "consolidated production output persistence disabled" };
  }

  const config = validateProductionOutputServiceConfig();
  const autoQueue = config.ok && config.autoQueueEnabled;

  try {
    const result = await upsertConsolidatedProductionOutputOpForLot(
      input.finishedLotId,
      input.actor.id != null ? { id: input.actor.id } : null,
      {
        autoQueue,
        warehouseId: config.ok ? config.defaultWarehouseId : null,
      },
    );

    if (!result.ok) {
      await writeAudit({
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "zoho.production_output.consolidated_skipped",
        targetType: "FinishedLot",
        targetId: input.finishedLotId,
        after: { reason: result.reason },
      });
      return result;
    }

    await writeAudit({
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "zoho.production_output.consolidated_upserted",
      targetType: "FinishedLot",
      targetId: input.finishedLotId,
      after: {
        opId: result.opId,
        status: result.status,
        queued: result.queued,
        autoQueue,
      },
    });

    return {
      ok: true,
      opId: result.opId,
      status: result.status,
      queued: result.queued,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "enqueue failed";
    await writeAudit({
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "zoho.production_output.consolidated_failed",
      targetType: "FinishedLot",
      targetId: input.finishedLotId,
      after: { reason },
    });
    return { ok: false, reason };
  }
}
