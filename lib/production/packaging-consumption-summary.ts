// PACKAGING-PENDING-CONSUMPTION-HONESTY-1 — payload summary for PACKAGING_COMPLETE.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import type { PackagingConsumptionResult } from "@/lib/projector/packaging-consumption-hook";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export function buildPackagingConsumptionPayloadSummary(
  result: PackagingConsumptionResult,
): Record<string, unknown> {
  return {
    packaging_consumption_bom_status: result.bomStatus,
    packaging_consumption_summary: {
      total_units: result.totalUnits,
      total_displays: result.totalDisplays,
      total_cases: result.totalCases,
      materials: result.materials.map((m) => ({
        packaging_material_id: m.packagingMaterialId,
        material_name: m.materialName,
        material_kind: m.materialKind,
        per_scope: m.perScope,
        qty_consumed: m.qtyConsumed,
        qty_actual: m.qtyActual ?? null,
        qty_estimated: m.qtyEstimated ?? null,
        status: m.status,
        lot_id: m.lotId,
      })),
    },
  };
}

/** Merge consumption summary onto the latest PACKAGING_COMPLETE row. */
export async function patchPackagingCompleteConsumptionSummary(
  tx: Tx,
  args: {
    workflowBagId: string;
    summary: Record<string, unknown>;
    clientEventId?: string | null;
  },
): Promise<void> {
  const summaryJson = JSON.stringify(args.summary);
  if (args.clientEventId) {
    await tx.execute(sql`
      UPDATE workflow_events
      SET payload = payload || ${summaryJson}::jsonb
      WHERE workflow_bag_id = ${args.workflowBagId}::uuid
        AND event_type = 'PACKAGING_COMPLETE'
        AND client_event_id = ${args.clientEventId}::uuid
    `);
    return;
  }
  await tx.execute(sql`
    UPDATE workflow_events
    SET payload = payload || ${summaryJson}::jsonb
    WHERE id = (
      SELECT id FROM workflow_events
      WHERE workflow_bag_id = ${args.workflowBagId}::uuid
        AND event_type = 'PACKAGING_COMPLETE'
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    )
  `);
}
