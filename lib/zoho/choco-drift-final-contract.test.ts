import { describe, expect, it } from "vitest";
import { evaluateChocoDriftPreviewPreflight } from "@/lib/zoho/choco-drift-preview-preflight";
import {
  rejectWorkflowBagAsSourceBagId,
  validateSourceAllocationQuantity,
} from "@/lib/zoho/component-batch-quantity";
import { buildLumaProductionOutputStableCommitIdempotencyKey } from "@/lib/zoho/luma-production-output-payload";
import { evaluateV1206ProductionOutputCommitReadiness } from "@/lib/zoho/production-output-v1206-readiness";
import {
  CHOCO_DRIFT_BOM_COMPONENTS,
  CHOCO_DRIFT_BOM_INSPECTION_STATUS,
  CHOCO_DRIFT_BATCH_TRACKING_REQUIRED,
  CHOCO_DRIFT_HUMAN_LOT_NUMBER,
  CHOCO_DRIFT_PACKAGING_ITEM_ID,
  CHOCO_DRIFT_PRODUCT_ID,
  CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  CHOCO_DRIFT_SKU,
  CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
  CHOCO_DRIFT_ZOHO_PO_LINE_ITEM_ID,
  CHOCO_DRIFT_ZOHO_PURCHASEORDER_ID,
  buildChocoDriftComponentBatches,
  buildChocoDriftOperationSnapshot,
  chocoDriftRequiresBatchResolution,
  chocoDriftRequiresComponentBatches,
  chocoDriftSourceAllocationBuildOpts,
  deriveChocoDriftBomConsumption,
  deriveChocoDriftPackagingQuantity,
  deriveChocoDriftRawTabletQuantity,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";

const TEST_INVENTORY_BAG_ID = "00000000-0000-4000-8000-000000000099";
const STAGING_WORKFLOW_BAG_ID = "9a84d52a-0e18-4f91-907d-947a81280ec8";

function chocoReadyPayload(input: {
  unitAssemblyQuantity: number;
  sourceQuantity: number;
  sourceBagId?: string;
  componentBatches?: unknown[];
}) {
  const lotId = "lot-choco-final";
  const snapshot = buildChocoDriftOperationSnapshot({
    finishedLotId: lotId,
    workflowBagId: "wfb-choco-final",
    closedAllocationSession: {
      inventoryBagId: input.sourceBagId ?? TEST_INVENTORY_BAG_ID,
    },
    unitAssemblyQuantity: input.unitAssemblyQuantity,
  });
  if (input.sourceQuantity !== deriveChocoDriftRawTabletQuantity(input.unitAssemblyQuantity)) {
    snapshot.source_allocations[0]!.quantity = input.sourceQuantity;
  }
  return {
    source: "LUMA" as const,
    idempotency_key: buildLumaProductionOutputStableCommitIdempotencyKey(lotId),
    output: { units_produced: input.unitAssemblyQuantity },
    component_batches: input.componentBatches ?? [],
    luma_operation_snapshot: snapshot,
    product: {
      sku: CHOCO_DRIFT_SKU,
      luma_product_id: CHOCO_DRIFT_PRODUCT_ID,
      unit_composite_item_id: CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
    },
  };
}

describe("confirmed Choco Drift BOM fixture", () => {
  it("marks BOM inspection confirmed with raw tablet qty 4 per unit", () => {
    expect(CHOCO_DRIFT_BOM_INSPECTION_STATUS).toBe("confirmed");
    expect(CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT).toBe(4);
    expect(CHOCO_DRIFT_BATCH_TRACKING_REQUIRED).toBe(false);
  });

  it("models both packaging and raw tablet BOM components", () => {
    expect(CHOCO_DRIFT_BOM_COMPONENTS).toHaveLength(2);
    expect(CHOCO_DRIFT_BOM_COMPONENTS[0]?.item_id).toBe(CHOCO_DRIFT_PACKAGING_ITEM_ID);
    expect(CHOCO_DRIFT_BOM_COMPONENTS[0]?.quantity_per_unit).toBe(1);
    expect(CHOCO_DRIFT_BOM_COMPONENTS[1]?.item_id).toBe(CHOCO_DRIFT_RAW_TABLET_ITEM_ID);
    expect(CHOCO_DRIFT_BOM_COMPONENTS[1]?.quantity_per_unit).toBe(4);
  });

  it("derives 1-unit consumption: 1 blister + 4 tablets", () => {
    expect(deriveChocoDriftPackagingQuantity(1)).toBe(1);
    expect(deriveChocoDriftRawTabletQuantity(1)).toBe(4);
    expect(deriveChocoDriftBomConsumption(1)).toEqual([
      { item_id: CHOCO_DRIFT_PACKAGING_ITEM_ID, role: "packaging", quantity_consumed: 1 },
      { item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID, role: "raw_tablet", quantity_consumed: 4 },
    ]);
  });

  it("derives 900-unit consumption: 900 blister + 3600 tablets", () => {
    expect(deriveChocoDriftPackagingQuantity(900)).toBe(900);
    expect(deriveChocoDriftRawTabletQuantity(900)).toBe(3600);
  });
});

describe("Choco Drift batch behavior", () => {
  it("does not require component_batches", () => {
    expect(chocoDriftRequiresComponentBatches()).toBe(false);
    expect(buildChocoDriftComponentBatches()).toEqual([]);
  });

  it("does not require batch resolution", () => {
    expect(chocoDriftRequiresBatchResolution()).toBe(false);
    const opts = chocoDriftSourceAllocationBuildOpts();
    expect(opts.resolveBatches).toBe(false);
    expect(opts.batchTrackedItemIds.size).toBe(0);
  });

  it("source allocation opts skip batch resolution for Choco Drift", () => {
    const opts = chocoDriftSourceAllocationBuildOpts();
    expect(opts.resolveBatches).toBe(false);
    expect(opts.batchTrackedItemIds.has(CHOCO_DRIFT_RAW_TABLET_ITEM_ID)).toBe(false);
    expect(opts.normalizedBomQuantities[CHOCO_DRIFT_RAW_TABLET_ITEM_ID]).toBe(4);
  });
});

describe("Choco Drift source bag semantics", () => {
  it("uses inventory_bag id from closed allocation session", () => {
    const snapshot = buildChocoDriftOperationSnapshot({
      finishedLotId: "lot-1",
      workflowBagId: STAGING_WORKFLOW_BAG_ID,
      closedAllocationSession: { inventoryBagId: TEST_INVENTORY_BAG_ID },
      unitAssemblyQuantity: 1,
    });
    expect(snapshot.source_allocations[0]?.source_bag_id).toBe(TEST_INVENTORY_BAG_ID);
    expect(snapshot.source_allocations[0]?.source_bag_id).not.toBe(STAGING_WORKFLOW_BAG_ID);
  });

  it("retains human lot internally without Zoho batch representation", () => {
    const snapshot = buildChocoDriftOperationSnapshot({
      finishedLotId: "lot-1",
      workflowBagId: "wfb-1",
      closedAllocationSession: { inventoryBagId: TEST_INVENTORY_BAG_ID },
      unitAssemblyQuantity: 1,
    });
    expect(snapshot.source_allocations[0]?.human_lot_number).toBe(CHOCO_DRIFT_HUMAN_LOT_NUMBER);
    expect(buildChocoDriftComponentBatches()).toEqual([]);
  });

  it("rejects workflow bag UUID as source_bag_id", () => {
    const check = rejectWorkflowBagAsSourceBagId(
      STAGING_WORKFLOW_BAG_ID,
      STAGING_WORKFLOW_BAG_ID,
    );
    expect(check.ok).toBe(false);
  });
});

describe("Choco Drift commit readiness", () => {
  it("allows ready path with empty component_batches and matching allocation qty", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: chocoReadyPayload({ unitAssemblyQuantity: 900, sourceQuantity: 3600 }),
      previewHttpStatus: 200,
      previewResponse: {
        ok: true,
        writes_allowed: true,
        preflight: {
          components: [
            {
              item_id: CHOCO_DRIFT_PACKAGING_ITEM_ID,
              required: 900,
              available: 1000,
              sufficient: true,
            },
            {
              item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
              required: 3600,
              available: 5000,
              sufficient: true,
            },
          ],
        },
      },
      previewStatus: "ready",
      previewWritesAllowed: true,
      commitIdempotencyKey: buildLumaProductionOutputStableCommitIdempotencyKey("lot-choco-final"),
      finishedLotExists: true,
      workflowBagId: "wfb-choco-final",
      sourceAllocationCount: 1,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: true,
    });
    expect(result.eligible).toBe(true);
  });

  it("blocks raw source allocation quantity mismatch", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: chocoReadyPayload({ unitAssemblyQuantity: 900, sourceQuantity: 900 }),
      previewHttpStatus: 200,
      previewResponse: { ok: true, writes_allowed: true },
      previewStatus: "ready",
      previewWritesAllowed: true,
      commitIdempotencyKey: buildLumaProductionOutputStableCommitIdempotencyKey("lot-choco-final"),
      finishedLotExists: true,
      workflowBagId: "wfb-choco-final",
      sourceAllocationCount: 1,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: true,
    });
    expect(result.blockers.some((b) => b.code === "BOM_QUANTITY_MISMATCH")).toBe(true);
  });

  it("blocks unexpected component_batches", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: chocoReadyPayload({
        unitAssemblyQuantity: 1,
        sourceQuantity: 4,
        componentBatches: [
          {
            item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
            source_bag_id: TEST_INVENTORY_BAG_ID,
            human_lot_number: CHOCO_DRIFT_HUMAN_LOT_NUMBER,
            batches: [{ batch_id: "x", out_quantity: 4 }],
          },
        ],
      }),
      previewHttpStatus: 200,
      previewResponse: { ok: true, writes_allowed: true },
      previewStatus: "ready",
      previewWritesAllowed: true,
      commitIdempotencyKey: buildLumaProductionOutputStableCommitIdempotencyKey("lot-choco-final"),
      finishedLotExists: true,
      workflowBagId: "wfb-choco-final",
      sourceAllocationCount: 1,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: true,
    });
    expect(result.blockers.some((b) => b.code === "UNEXPECTED_COMPONENT_BATCHES")).toBe(true);
  });

  it("requires preview writes_allowed=true", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: chocoReadyPayload({ unitAssemblyQuantity: 1, sourceQuantity: 4 }),
      previewHttpStatus: 200,
      previewResponse: { ok: true, writes_allowed: false },
      previewStatus: "ready",
      previewWritesAllowed: false,
      commitIdempotencyKey: buildLumaProductionOutputStableCommitIdempotencyKey("lot-choco-final"),
      finishedLotExists: true,
      workflowBagId: "wfb-choco-final",
      sourceAllocationCount: 1,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: true,
    });
    expect(result.blockers.some((b) => b.code === "PREVIEW_WRITES_NOT_ALLOWED")).toBe(true);
  });
});

describe("Choco Drift preview preflight stock", () => {
  it("blocks packaging stock insufficiency", () => {
    const result = evaluateChocoDriftPreviewPreflight({
      sku: CHOCO_DRIFT_SKU,
      unitAssemblyQuantity: 900,
      previewHttpStatus: 200,
      previewResponse: {
        writes_allowed: false,
        preflight: {
          components: [
            {
              item_id: CHOCO_DRIFT_PACKAGING_ITEM_ID,
              required: 900,
              available: 10,
              sufficient: false,
            },
            {
              item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
              required: 3600,
              available: 5000,
              sufficient: true,
            },
          ],
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => b.code === "PACKAGING_STOCK_INSUFFICIENT")).toBe(true);
    expect(result.blockers.some((b) => b.code === "RECEIVE_BLOCKED_BY_PREFLIGHT")).toBe(true);
  });

  it("blocks raw tablet stock insufficiency", () => {
    const result = evaluateChocoDriftPreviewPreflight({
      sku: CHOCO_DRIFT_SKU,
      unitAssemblyQuantity: 1,
      previewHttpStatus: 200,
      previewResponse: {
        preflight: {
          components: [
            {
              item_id: CHOCO_DRIFT_PACKAGING_ITEM_ID,
              required: 1,
              available: 100,
              sufficient: true,
            },
            {
              item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
              required: 4,
              available: 1,
              sufficient: false,
            },
          ],
        },
      },
    });
    expect(result.blockers.some((b) => b.code === "RAW_TABLET_STOCK_INSUFFICIENT")).toBe(true);
  });
});

describe("PO mapping constants", () => {
  it("exposes exact Zoho purchaseorder and line item ids", () => {
    expect(CHOCO_DRIFT_ZOHO_PURCHASEORDER_ID).toBe("5254962000005946455");
    expect(CHOCO_DRIFT_ZOHO_PO_LINE_ITEM_ID).toBe("5254962000005946458");
    expect(isChocoDriftSku(CHOCO_DRIFT_SKU)).toBe(true);
  });
});

describe("source allocation quantity helper", () => {
  it("validates 4 tablets per finished unit", () => {
    expect(
      validateSourceAllocationQuantity({
        allocatedQuantity: 4,
        bomQuantityPerUnit: 4,
        unitAssemblyQuantity: 1,
      }).ok,
    ).toBe(true);
    expect(
      validateSourceAllocationQuantity({
        allocatedQuantity: 3600,
        bomQuantityPerUnit: 4,
        unitAssemblyQuantity: 900,
      }).ok,
    ).toBe(true);
  });
});
