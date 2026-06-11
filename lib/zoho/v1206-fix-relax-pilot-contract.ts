// ZOHO-V1206 — FIX Relax 1ct pilot BOM (confirmed via composite inspect on CT 9503).

import type { ComponentBatchPayloadEntry } from "@/lib/zoho/production-output-source-allocations";
import { deriveComponentBatchOutQuantity } from "@/lib/zoho/component-batch-quantity";

export const FIX_RELAX_PRODUCT_ID = "95c61efe-a36a-44df-8fee-8e66d659ed80";
export const FIX_RELAX_SKU = "tt-product-19";
export const FIX_RELAX_PRODUCT_NAME = "FIX Relax 1ct";
export const FIX_RELAX_PRODUCT_FAMILY = "FIX_RELAX";
export const FIX_RELAX_UNIT_COMPOSITE_ITEM_ID = "5254962000001258190";
export const FIX_RELAX_UNIT_COMPOSITE_NAME = "FIX Relax (Red) 1ct - Single";

export const FIX_RELAX_RAW_TABLET_ITEM_ID = "5254962000001258058";
export const FIX_RELAX_RAW_TABLET_ITEM_NAME = "FIX Tablets Relax (Red) 50mg";
/** Confirmed live Zoho BOM: 1 raw tablet per finished single. */
export const FIX_RELAX_RAW_TABLET_BOM_QUANTITY_PER_UNIT = 1;

export const FIX_RELAX_PACKAGING_ITEM_ID = "5254962000000679541";
export const FIX_RELAX_PACKAGING_ITEM_NAME =
  "FIX Relax (Red) 1ct - Mylar Bag [Packaging]";
export const FIX_RELAX_PACKAGING_BOM_QUANTITY_PER_UNIT = 1;

/** Pilot bag receive committed 2026-06-11 — receipt proof for assembly-only preview. */
export const FIX_RELAX_SOURCE_BAG_ID = "e7fac20d-6514-4d6f-b8a1-bc4d120c5c3c";
export const FIX_RELAX_FINISHED_LOT_ID = "61c0ad45-dd1a-4764-b560-57291cf35022";
export const FIX_RELAX_OPERATION_ID = "f0256ebc-5f3c-4d54-aff8-3e76228a3847";
export const FIX_RELAX_ZOHO_PURCHASE_RECEIVE_ID = "5254962000006735004";
export const FIX_RELAX_ZOHO_RECEIVE_NUMBER = "PR-00569";
export const FIX_RELAX_RECEIVED_QUANTITY = 500;
export const FIX_RELAX_HUMAN_LOT_NUMBER = "146-26-1980";

export const FIX_RELAX_BOM_INSPECTION_STATUS = "confirmed" as const;
export const FIX_RELAX_BATCH_TRACKING_REQUIRED = false;

export type FixRelaxBomComponent = {
  item_id: string;
  name: string;
  quantity_per_unit: number;
  track_batch_number: boolean;
  role: "packaging" | "raw_tablet";
};

export const FIX_RELAX_BOM_COMPONENTS: readonly FixRelaxBomComponent[] = [
  {
    item_id: FIX_RELAX_RAW_TABLET_ITEM_ID,
    name: FIX_RELAX_RAW_TABLET_ITEM_NAME,
    quantity_per_unit: FIX_RELAX_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    track_batch_number: false,
    role: "raw_tablet",
  },
  {
    item_id: FIX_RELAX_PACKAGING_ITEM_ID,
    name: FIX_RELAX_PACKAGING_ITEM_NAME,
    quantity_per_unit: FIX_RELAX_PACKAGING_BOM_QUANTITY_PER_UNIT,
    track_batch_number: false,
    role: "packaging",
  },
] as const;

export function isFixRelaxSku(sku: string): boolean {
  return sku === FIX_RELAX_SKU;
}

export function fixRelaxRequiresComponentBatches(): boolean {
  return false;
}

export function fixRelaxRequiresBatchResolution(): boolean {
  return FIX_RELAX_BATCH_TRACKING_REQUIRED;
}

export function deriveFixRelaxPackagingQuantity(unitAssemblyQuantity: number): number {
  return deriveComponentBatchOutQuantity(
    FIX_RELAX_PACKAGING_BOM_QUANTITY_PER_UNIT,
    unitAssemblyQuantity,
  );
}

export function deriveFixRelaxRawTabletQuantity(unitAssemblyQuantity: number): number {
  return deriveComponentBatchOutQuantity(
    FIX_RELAX_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    unitAssemblyQuantity,
  );
}

export function deriveFixRelaxBomConsumption(unitAssemblyQuantity: number): Array<{
  item_id: string;
  role: FixRelaxBomComponent["role"];
  quantity_consumed: number;
}> {
  return FIX_RELAX_BOM_COMPONENTS.map((component) => ({
    item_id: component.item_id,
    role: component.role,
    quantity_consumed: deriveComponentBatchOutQuantity(
      component.quantity_per_unit,
      unitAssemblyQuantity,
    ),
  }));
}

/** Confirmed: no component_batches for FIX Relax (non-batch-tracked BOM). */
export function buildFixRelaxComponentBatches(): ComponentBatchPayloadEntry[] {
  return [];
}

export function fixRelaxSourceAllocationBuildOpts(): {
  resolveBatches: false;
  batchTrackedItemIds: Set<string>;
  normalizedBomQuantities: Record<string, number>;
} {
  return {
    resolveBatches: false,
    batchTrackedItemIds: new Set<string>(),
    normalizedBomQuantities: {
      [FIX_RELAX_RAW_TABLET_ITEM_ID]: FIX_RELAX_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    },
  };
}
