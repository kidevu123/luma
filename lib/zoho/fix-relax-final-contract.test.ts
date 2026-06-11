import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { mapProductionOutputPreviewQuantities } from "@/lib/zoho/production-output-preview-quantities";
import {
  isProductionOutputCommitEnabled,
  isProductionOutputPreviewEnabled,
} from "@/lib/zoho/production-output-config";
import {
  FIX_RELAX_BOM_COMPONENTS,
  FIX_RELAX_BOM_INSPECTION_STATUS,
  FIX_RELAX_BATCH_TRACKING_REQUIRED,
  FIX_RELAX_FINISHED_LOT_ID,
  FIX_RELAX_OPERATION_ID,
  FIX_RELAX_PACKAGING_ITEM_ID,
  FIX_RELAX_PRODUCT_FAMILY,
  FIX_RELAX_PRODUCT_ID,
  FIX_RELAX_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
  FIX_RELAX_RAW_TABLET_ITEM_ID,
  FIX_RELAX_RECEIVED_QUANTITY,
  FIX_RELAX_SKU,
  FIX_RELAX_SOURCE_BAG_ID,
  FIX_RELAX_UNIT_COMPOSITE_ITEM_ID,
  FIX_RELAX_ZOHO_PURCHASE_RECEIVE_ID,
  FIX_RELAX_ZOHO_RECEIVE_NUMBER,
  buildFixRelaxComponentBatches,
  deriveFixRelaxBomConsumption,
  deriveFixRelaxPackagingQuantity,
  deriveFixRelaxRawTabletQuantity,
  fixRelaxRequiresComponentBatches,
  fixRelaxSourceAllocationBuildOpts,
  isFixRelaxSku,
} from "@/lib/zoho/v1206-fix-relax-pilot-contract";
import {
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  chocoDriftSourceAllocationBuildOpts,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";

const consolidatedSrc = readFileSync(
  join(__dirname, "../db/queries/zoho-production-output-consolidated.ts"),
  "utf8",
);

describe("FIX Relax confirmed BOM fixture", () => {
  it("marks BOM inspection confirmed with raw tablet qty 1 per unit", () => {
    expect(FIX_RELAX_BOM_INSPECTION_STATUS).toBe("confirmed");
    expect(FIX_RELAX_RAW_TABLET_BOM_QUANTITY_PER_UNIT).toBe(1);
    expect(FIX_RELAX_BATCH_TRACKING_REQUIRED).toBe(false);
    expect(FIX_RELAX_PRODUCT_FAMILY).toBe("FIX_RELAX");
    expect(FIX_RELAX_PRODUCT_ID).toBe("95c61efe-a36a-44df-8fee-8e66d659ed80");
    expect(FIX_RELAX_UNIT_COMPOSITE_ITEM_ID).toBe("5254962000001258190");
  });

  it("models both packaging and raw tablet BOM components", () => {
    expect(FIX_RELAX_BOM_COMPONENTS).toHaveLength(2);
    expect(FIX_RELAX_BOM_COMPONENTS[0]?.item_id).toBe(FIX_RELAX_RAW_TABLET_ITEM_ID);
    expect(FIX_RELAX_BOM_COMPONENTS[0]?.quantity_per_unit).toBe(1);
    expect(FIX_RELAX_BOM_COMPONENTS[1]?.item_id).toBe(FIX_RELAX_PACKAGING_ITEM_ID);
    expect(FIX_RELAX_BOM_COMPONENTS[1]?.quantity_per_unit).toBe(1);
  });

  it("derives 10-unit consumption: 10 packaging + 10 raw tablets", () => {
    expect(deriveFixRelaxPackagingQuantity(10)).toBe(10);
    expect(deriveFixRelaxRawTabletQuantity(10)).toBe(10);
    expect(deriveFixRelaxBomConsumption(10)).toEqual([
      {
        item_id: FIX_RELAX_RAW_TABLET_ITEM_ID,
        role: "raw_tablet",
        quantity_consumed: 10,
      },
      {
        item_id: FIX_RELAX_PACKAGING_ITEM_ID,
        role: "packaging",
        quantity_consumed: 10,
      },
    ]);
  });
});

describe("FIX Relax source allocation opts", () => {
  it("resolves normalized BOM quantity for raw tablet only (ledger path)", () => {
    const opts = fixRelaxSourceAllocationBuildOpts();
    expect(opts.resolveBatches).toBe(false);
    expect(opts.batchTrackedItemIds.size).toBe(0);
    expect(opts.normalizedBomQuantities[FIX_RELAX_RAW_TABLET_ITEM_ID]).toBe(1);
    expect(fixRelaxRequiresComponentBatches()).toBe(false);
    expect(buildFixRelaxComponentBatches()).toEqual([]);
  });

  it("maps quantity_good=10 to unit_assembly_quantity=10 with zero loose", () => {
    const mapped = mapProductionOutputPreviewQuantities({
      unitsProduced: 10,
      displaysProduced: 0,
      casesProduced: 0,
      looseCards: 10,
    });
    expect(mapped.quantity_good).toBe(10);
    expect(mapped.quantity_loose).toBe(0);
    expect(mapped.unit_assembly_quantity).toBe(10);
  });
});

describe("FIX Relax pilot receipt proof constants", () => {
  it("pins PR-00569 receive proof for assembly-only preview", () => {
    expect(FIX_RELAX_ZOHO_RECEIVE_NUMBER).toBe("PR-00569");
    expect(FIX_RELAX_ZOHO_PURCHASE_RECEIVE_ID).toBe("5254962000006735004");
    expect(FIX_RELAX_RECEIVED_QUANTITY).toBe(500);
    expect(FIX_RELAX_SOURCE_BAG_ID).toBe(
      "e7fac20d-6514-4d6f-b8a1-bc4d120c5c3c",
    );
    expect(FIX_RELAX_FINISHED_LOT_ID).toBe(
      "61c0ad45-dd1a-4764-b560-57291cf35022",
    );
    expect(FIX_RELAX_OPERATION_ID).toBe(
      "f0256ebc-5f3c-4d54-aff8-3e76228a3847",
    );
  });
});

describe("FIX Relax consolidated preview wiring", () => {
  it("routes FIX Relax SKU through sourceAllocationBuildOptsForSku", () => {
    expect(consolidatedSrc).toMatch(/sourceAllocationBuildOptsForSku/);
    expect(consolidatedSrc).toMatch(/isFixRelaxSku/);
    expect(consolidatedSrc).toMatch(/fixRelaxSourceAllocationBuildOpts/);
    expect(consolidatedSrc).toMatch(/isChocoDriftSku/);
  });

  it("preview and commit share buildProductionOutputServicePayloadFromLuma", () => {
    expect(consolidatedSrc).toMatch(/buildProductionOutputServicePayloadFromLuma/);
    expect(consolidatedSrc).toMatch(/PRODUCTION_OUTPUT_SERVICE_PREVIEW_NOTES/);
    expect(consolidatedSrc).toMatch(/callProductionOutputPreview/);
    expect(consolidatedSrc).toMatch(/callProductionOutputCommit/);
  });
});

describe("production-output preview-only gates", () => {
  it("keeps commit disabled when env gate is false", () => {
    expect(
      isProductionOutputCommitEnabled({
        ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      isProductionOutputPreviewEnabled({
        ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
        ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
        ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
      }),
    ).toBe(true);
  });
});

describe("Choco Drift regression", () => {
  it("does not route Choco through FIX Relax SKU matcher", () => {
    expect(isFixRelaxSku("453535")).toBe(false);
    expect(isChocoDriftSku("453535")).toBe(true);
    const chocoOpts = chocoDriftSourceAllocationBuildOpts();
    expect(chocoOpts.normalizedBomQuantities[CHOCO_DRIFT_RAW_TABLET_ITEM_ID]).toBe(
      4,
    );
    const fixOpts = fixRelaxSourceAllocationBuildOpts();
    expect(fixOpts.normalizedBomQuantities[CHOCO_DRIFT_RAW_TABLET_ITEM_ID]).toBeUndefined();
    expect(fixOpts.normalizedBomQuantities[FIX_RELAX_RAW_TABLET_ITEM_ID]).toBe(1);
  });
});
