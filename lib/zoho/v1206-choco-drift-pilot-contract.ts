// ZOHO-V1206 — Choco Drift first-pilot shared contract (confirmed live Zoho BOM).

import type { ComponentBatchPayloadEntry } from "@/lib/zoho/production-output-source-allocations";
import {
  deriveComponentBatchOutQuantity,
  sourceBagIdFromClosedAllocationSession,
} from "@/lib/zoho/component-batch-quantity";
import type { LumaOperationSnapshot } from "@/lib/zoho/luma-operation-snapshot";

/** Luma internal product UUID — not a Zoho item ID. */
export const CHOCO_DRIFT_PRODUCT_ID = "3e8feb72-09a0-4068-8231-c965715c33a9";

export const CHOCO_DRIFT_SKU = "453535";
export const CHOCO_DRIFT_PRODUCT_NAME = "Hyroxi MIT B - Choco Drift";
export const CHOCO_DRIFT_PRODUCT_FAMILY = "HYROXI_MIT_B";
export const CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID = "5254962000006219015";
export const CHOCO_DRIFT_UNIT_COMPOSITE_NAME =
  "Hyroxi MIT B - Choco Drift - 4ct Card - Single";

export const CHOCO_DRIFT_PACKAGING_ITEM_ID = "5254962000005277428";
export const CHOCO_DRIFT_PACKAGING_ITEM_NAME =
  "Hyroxi MIT-B 4ct - 100mg - Choco Drift - Blister Card";
export const CHOCO_DRIFT_PACKAGING_BOM_QUANTITY_PER_UNIT = 1;

export const CHOCO_DRIFT_RAW_TABLET_ITEM_ID = "5254962000005946408";
export const CHOCO_DRIFT_RAW_TABLET_ITEM_NAME = "Chocolate Brown 100mg B Tablet";
/** Confirmed live Zoho BOM: 4 raw tablets per finished single. */
export const CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT = 4;

/** @deprecated use CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT */
export const CHOCO_DRIFT_BOM_QUANTITY_PER_UNIT = CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT;

/** @deprecated use CHOCO_DRIFT_RAW_TABLET_ITEM_ID */
export const CHOCO_DRIFT_RAW_COMPONENT_ITEM_ID = CHOCO_DRIFT_RAW_TABLET_ITEM_ID;

/** Internal physical traceability only — not sent to Zoho assembly/batch payload. */
export const CHOCO_DRIFT_HUMAN_LOT_NUMBER = "152-000166";

export const CHOCO_DRIFT_BOM_INSPECTION_STATUS = "confirmed" as const;
export const CHOCO_DRIFT_BATCH_TRACKING_REQUIRED = false;

export const CHOCO_DRIFT_PO_NUMBER = "PO-00238";
export const CHOCO_DRIFT_ZOHO_PURCHASEORDER_ID = "5254962000005946455";
export const CHOCO_DRIFT_ZOHO_PO_LINE_ITEM_ID = "5254962000005946458";
export const CHOCO_DRIFT_LUMA_PO_LINE_ID = "6e970633-adfe-41cd-967c-747a4f5e1373";

export type ChocoDriftBomComponent = {
  item_id: string;
  name: string;
  quantity_per_unit: number;
  track_batch_number: boolean;
  role: "packaging" | "raw_tablet";
};

export const CHOCO_DRIFT_BOM_COMPONENTS: readonly ChocoDriftBomComponent[] = [
  {
    item_id: CHOCO_DRIFT_PACKAGING_ITEM_ID,
    name: CHOCO_DRIFT_PACKAGING_ITEM_NAME,
    quantity_per_unit: CHOCO_DRIFT_PACKAGING_BOM_QUANTITY_PER_UNIT,
    track_batch_number: false,
    role: "packaging",
  },
  {
    item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
    name: CHOCO_DRIFT_RAW_TABLET_ITEM_NAME,
    quantity_per_unit: CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    track_batch_number: false,
    role: "raw_tablet",
  },
] as const;

export function isChocoDriftSku(sku: string): boolean {
  return sku === CHOCO_DRIFT_SKU;
}

export function chocoDriftRequiresComponentBatches(): boolean {
  return false;
}

export function skuRequiresComponentBatchesUntilBomConfirmed(sku: string): boolean {
  return false;
}

export function chocoDriftRequiresBatchResolution(): boolean {
  return CHOCO_DRIFT_BATCH_TRACKING_REQUIRED;
}

export function deriveChocoDriftPackagingQuantity(unitAssemblyQuantity: number): number {
  return deriveComponentBatchOutQuantity(
    CHOCO_DRIFT_PACKAGING_BOM_QUANTITY_PER_UNIT,
    unitAssemblyQuantity,
  );
}

export function deriveChocoDriftRawTabletQuantity(unitAssemblyQuantity: number): number {
  return deriveComponentBatchOutQuantity(
    CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    unitAssemblyQuantity,
  );
}

export function deriveChocoDriftBomConsumption(unitAssemblyQuantity: number): Array<{
  item_id: string;
  role: ChocoDriftBomComponent["role"];
  quantity_consumed: number;
}> {
  return CHOCO_DRIFT_BOM_COMPONENTS.map((component) => ({
    item_id: component.item_id,
    role: component.role,
    quantity_consumed: deriveComponentBatchOutQuantity(
      component.quantity_per_unit,
      unitAssemblyQuantity,
    ),
  }));
}

/** Confirmed: no component_batches for Choco Drift (non-batch-tracked BOM). */
export function buildChocoDriftComponentBatches(): ComponentBatchPayloadEntry[] {
  return [];
}

/** @deprecated use buildChocoDriftComponentBatches */
export function buildChocoDriftNonBatchComponentBatches(): ComponentBatchPayloadEntry[] {
  return buildChocoDriftComponentBatches();
}

export function buildChocoDriftOperationSnapshot(input: {
  finishedLotId: string;
  workflowBagId: string;
  finalizedAt?: string;
  closedAllocationSession: { inventoryBagId: string };
  unitAssemblyQuantity: number;
}): LumaOperationSnapshot {
  const sourceBagId = sourceBagIdFromClosedAllocationSession(input.closedAllocationSession);
  const sourceQuantity = deriveChocoDriftRawTabletQuantity(input.unitAssemblyQuantity);
  const finalizedAt = input.finalizedAt ?? "2026-06-10T18:00:00.000Z";

  return {
    luma_operation_id: `luma-production-output:${input.finishedLotId}`,
    status: "finalized",
    finalized_at: finalizedAt,
    product_id: CHOCO_DRIFT_PRODUCT_ID,
    product_family: CHOCO_DRIFT_PRODUCT_FAMILY,
    finished_sku: CHOCO_DRIFT_SKU,
    unit_composite_item_id: CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
    workflow_bag_id: input.workflowBagId,
    finished_lot_id: input.finishedLotId,
    source_allocations: [
      {
        source_bag_id: sourceBagId,
        item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
        human_lot_number: CHOCO_DRIFT_HUMAN_LOT_NUMBER,
        quantity: sourceQuantity,
      },
    ],
  };
}

export function chocoDriftSourceAllocationBuildOpts(): {
  resolveBatches: false;
  batchTrackedItemIds: Set<string>;
  normalizedBomQuantities: Record<string, number>;
} {
  return {
    resolveBatches: false,
    batchTrackedItemIds: new Set<string>(),
    normalizedBomQuantities: {
      [CHOCO_DRIFT_RAW_TABLET_ITEM_ID]: CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    },
  };
}
