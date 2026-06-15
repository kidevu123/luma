import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  SWEET_TRIP_BOM_COMPONENTS,
  SWEET_TRIP_BOM_INSPECTION_STATUS,
  SWEET_TRIP_DECLARED_PHYSICAL_QUANTITY,
  SWEET_TRIP_PACKAGING_ITEM_ID,
  SWEET_TRIP_PRODUCT_FAMILY,
  SWEET_TRIP_PRODUCT_ID,
  SWEET_TRIP_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
  SWEET_TRIP_RAW_TABLET_ITEM_ID,
  SWEET_TRIP_SKU,
  SWEET_TRIP_SOURCE_BAG_ID,
  SWEET_TRIP_UNIT_COMPOSITE_ITEM_ID,
  SWEET_TRIP_ZOHO_PO_LINE_ITEM_ID,
  SWEET_TRIP_ZOHO_PURCHASEORDER_ID,
  buildSweetTripComponentBatches,
  deriveSweetTripBomConsumption,
  deriveSweetTripPackagingQuantity,
  deriveSweetTripRawTabletQuantity,
  isSweetTripSku,
  sweetTripRequiresComponentBatches,
  sweetTripSourceAllocationBuildOpts,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";
import {
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  CHOCO_DRIFT_SKU,
  chocoDriftSourceAllocationBuildOpts,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import {
  FIX_RELAX_RAW_TABLET_ITEM_ID,
  FIX_RELAX_SKU,
  fixRelaxSourceAllocationBuildOpts,
  isFixRelaxSku,
} from "@/lib/zoho/v1206-fix-relax-pilot-contract";

const consolidatedSrc = readFileSync(
  join(__dirname, "../db/queries/zoho-production-output-consolidated.ts"),
  "utf8",
);

describe("Sweet Trip confirmed BOM fixture", () => {
  it("marks BOM inspection confirmed with raw tablet qty 4 per unit", () => {
    expect(SWEET_TRIP_BOM_INSPECTION_STATUS).toBe("confirmed");
    expect(SWEET_TRIP_RAW_TABLET_BOM_QUANTITY_PER_UNIT).toBe(4);
    expect(SWEET_TRIP_PRODUCT_FAMILY).toBe("HYROXI_MIT_B");
    expect(SWEET_TRIP_PRODUCT_ID).toBe("510ab906-32b9-4082-b678-5d35ced9c4b8");
    expect(SWEET_TRIP_UNIT_COMPOSITE_ITEM_ID).toBe("5254962000006219038");
  });

  it("models packaging blister and raw tablet BOM components", () => {
    expect(SWEET_TRIP_BOM_COMPONENTS).toHaveLength(2);
    expect(SWEET_TRIP_BOM_COMPONENTS[0]?.item_id).toBe(SWEET_TRIP_PACKAGING_ITEM_ID);
    expect(SWEET_TRIP_BOM_COMPONENTS[0]?.quantity_per_unit).toBe(1);
    expect(SWEET_TRIP_BOM_COMPONENTS[1]?.item_id).toBe(SWEET_TRIP_RAW_TABLET_ITEM_ID);
    expect(SWEET_TRIP_BOM_COMPONENTS[1]?.quantity_per_unit).toBe(4);
  });

  it("derives 10-unit consumption: 10 packaging + 40 raw tablets", () => {
    expect(deriveSweetTripPackagingQuantity(10)).toBe(10);
    expect(deriveSweetTripRawTabletQuantity(10)).toBe(40);
    expect(deriveSweetTripBomConsumption(10)).toEqual([
      {
        item_id: SWEET_TRIP_PACKAGING_ITEM_ID,
        role: "packaging",
        quantity_consumed: 10,
      },
      {
        item_id: SWEET_TRIP_RAW_TABLET_ITEM_ID,
        role: "raw_tablet",
        quantity_consumed: 40,
      },
    ]);
  });
});

describe("Sweet Trip source allocation opts", () => {
  it("resolves normalized BOM quantity for raw tablet (4 per unit)", () => {
    const opts = sweetTripSourceAllocationBuildOpts();
    expect(opts.resolveBatches).toBe(false);
    expect(opts.batchTrackedItemIds.size).toBe(0);
    expect(opts.normalizedBomQuantities[SWEET_TRIP_RAW_TABLET_ITEM_ID]).toBe(4);
    expect(sweetTripRequiresComponentBatches()).toBe(false);
    expect(buildSweetTripComponentBatches()).toEqual([]);
  });

  it("matches pilot #2 source bag and PO linkage constants", () => {
    expect(SWEET_TRIP_SOURCE_BAG_ID).toBe(
      "6ddf2e91-4808-4036-ab1b-3cbdd7fff254",
    );
    expect(SWEET_TRIP_DECLARED_PHYSICAL_QUANTITY).toBe(6692);
    expect(SWEET_TRIP_ZOHO_PURCHASEORDER_ID).toBe("5254962000005946455");
    expect(SWEET_TRIP_ZOHO_PO_LINE_ITEM_ID).toBe("5254962000005946461");
    expect(isSweetTripSku(SWEET_TRIP_SKU)).toBe(true);
  });
});

describe("Sweet Trip consolidated preview wiring", () => {
  it("routes Sweet Trip SKU through sourceAllocationBuildOptsForSku", () => {
    expect(consolidatedSrc).toMatch(/isSweetTripSku/);
    expect(consolidatedSrc).toMatch(/sweetTripSourceAllocationBuildOpts/);
  });
});

describe("Choco and FIX Relax regression", () => {
  it("does not route Choco or FIX Relax through Sweet Trip matcher", () => {
    expect(isSweetTripSku(CHOCO_DRIFT_SKU)).toBe(false);
    expect(isSweetTripSku(FIX_RELAX_SKU)).toBe(false);
    expect(isChocoDriftSku(CHOCO_DRIFT_SKU)).toBe(true);
    expect(isFixRelaxSku(FIX_RELAX_SKU)).toBe(true);

    const sweetOpts = sweetTripSourceAllocationBuildOpts();
    expect(sweetOpts.normalizedBomQuantities[CHOCO_DRIFT_RAW_TABLET_ITEM_ID]).toBeUndefined();
    expect(sweetOpts.normalizedBomQuantities[FIX_RELAX_RAW_TABLET_ITEM_ID]).toBeUndefined();

    expect(chocoDriftSourceAllocationBuildOpts().normalizedBomQuantities[
      CHOCO_DRIFT_RAW_TABLET_ITEM_ID
    ]).toBe(4);
    expect(fixRelaxSourceAllocationBuildOpts().normalizedBomQuantities[
      FIX_RELAX_RAW_TABLET_ITEM_ID
    ]).toBe(1);
  });
});
