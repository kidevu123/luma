// ZOHO-V1206 — Sweet Trip pilot BOM (confirmed via Zoho items/search on CT 9503).

import type { ComponentBatchPayloadEntry } from "@/lib/zoho/production-output-source-allocations";
import { deriveComponentBatchOutQuantity } from "@/lib/zoho/component-batch-quantity";

export const SWEET_TRIP_PRODUCT_ID = "510ab906-32b9-4082-b678-5d35ced9c4b8";
export const SWEET_TRIP_SKU = "LUMA-hyroxi-mit-b-sweet-t-XQ30Q";
export const SWEET_TRIP_PRODUCT_NAME = "Hyroxi MIT B - Sweet Trip";
export const SWEET_TRIP_PRODUCT_FAMILY = "HYROXI_MIT_B";
export const SWEET_TRIP_UNIT_COMPOSITE_ITEM_ID = "5254962000006219038";
export const SWEET_TRIP_UNIT_COMPOSITE_NAME =
  "Hyroxi MIT B - Sweet Trip - 4ct Cards - Single";

export const SWEET_TRIP_RAW_TABLET_ITEM_ID = "5254962000005946414";
export const SWEET_TRIP_RAW_TABLET_ITEM_NAME = "MIT B Strawberry Pink";
/** Confirmed: same 4ct MIT B structure as Choco Drift — 4 raw tablets per finished single. */
export const SWEET_TRIP_RAW_TABLET_BOM_QUANTITY_PER_UNIT = 4;

export const SWEET_TRIP_PACKAGING_ITEM_ID = "5254962000005277395";
export const SWEET_TRIP_PACKAGING_ITEM_NAME =
  "Hyroxi MIT-B 4ct - 100mg - Sweet Trip - Blister Card [Packaging]";
export const SWEET_TRIP_PACKAGING_BOM_QUANTITY_PER_UNIT = 1;

/** Pilot #2 source bag — receipt 352178, lot 152-000160. */
export const SWEET_TRIP_SOURCE_BAG_ID = "6ddf2e91-4808-4036-ab1b-3cbdd7fff254";
export const SWEET_TRIP_INTERNAL_RECEIPT_NUMBER = "352178";
export const SWEET_TRIP_HUMAN_LOT_NUMBER = "152-000160";
export const SWEET_TRIP_DECLARED_PHYSICAL_QUANTITY = 6692;
export const SWEET_TRIP_ZOHO_PURCHASEORDER_ID = "5254962000005946455";
export const SWEET_TRIP_ZOHO_PO_LINE_ITEM_ID = "5254962000005946461";

export const SWEET_TRIP_BOM_INSPECTION_STATUS = "confirmed" as const;
export const SWEET_TRIP_BATCH_TRACKING_REQUIRED = false;

export type SweetTripBomComponent = {
  item_id: string;
  name: string;
  quantity_per_unit: number;
  track_batch_number: boolean;
  role: "packaging" | "raw_tablet";
};

export const SWEET_TRIP_BOM_COMPONENTS: readonly SweetTripBomComponent[] = [
  {
    item_id: SWEET_TRIP_PACKAGING_ITEM_ID,
    name: SWEET_TRIP_PACKAGING_ITEM_NAME,
    quantity_per_unit: SWEET_TRIP_PACKAGING_BOM_QUANTITY_PER_UNIT,
    track_batch_number: false,
    role: "packaging",
  },
  {
    item_id: SWEET_TRIP_RAW_TABLET_ITEM_ID,
    name: SWEET_TRIP_RAW_TABLET_ITEM_NAME,
    quantity_per_unit: SWEET_TRIP_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    track_batch_number: false,
    role: "raw_tablet",
  },
] as const;

export function isSweetTripSku(sku: string): boolean {
  return sku === SWEET_TRIP_SKU;
}

export function sweetTripRequiresComponentBatches(): boolean {
  return false;
}

export function sweetTripRequiresBatchResolution(): boolean {
  return SWEET_TRIP_BATCH_TRACKING_REQUIRED;
}

export function deriveSweetTripPackagingQuantity(unitAssemblyQuantity: number): number {
  return deriveComponentBatchOutQuantity(
    SWEET_TRIP_PACKAGING_BOM_QUANTITY_PER_UNIT,
    unitAssemblyQuantity,
  );
}

export function deriveSweetTripRawTabletQuantity(unitAssemblyQuantity: number): number {
  return deriveComponentBatchOutQuantity(
    SWEET_TRIP_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    unitAssemblyQuantity,
  );
}

export function deriveSweetTripBomConsumption(unitAssemblyQuantity: number): Array<{
  item_id: string;
  role: SweetTripBomComponent["role"];
  quantity_consumed: number;
}> {
  return SWEET_TRIP_BOM_COMPONENTS.map((component) => ({
    item_id: component.item_id,
    role: component.role,
    quantity_consumed: deriveComponentBatchOutQuantity(
      component.quantity_per_unit,
      unitAssemblyQuantity,
    ),
  }));
}

export function buildSweetTripComponentBatches(): ComponentBatchPayloadEntry[] {
  return [];
}

export function sweetTripSourceAllocationBuildOpts(): {
  resolveBatches: false;
  batchTrackedItemIds: Set<string>;
  normalizedBomQuantities: Record<string, number>;
} {
  return {
    resolveBatches: false,
    batchTrackedItemIds: new Set<string>(),
    normalizedBomQuantities: {
      [SWEET_TRIP_RAW_TABLET_ITEM_ID]: SWEET_TRIP_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
    },
  };
}
