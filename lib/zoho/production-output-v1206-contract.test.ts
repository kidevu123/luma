import { describe, expect, it } from "vitest";
import {
  classifyBatchResolveResponse,
  resolveZohoComponentBatch,
} from "@/lib/zoho/component-batch-resolution";
import {
  attachSnapshotToPayload,
  buildLumaOperationSnapshotFromOpRow,
  parsePreviewWritesAllowed,
  verifySnapshotMatchesPersistedOperation,
} from "@/lib/zoho/luma-operation-snapshot";
import { buildLumaProductionOutputStableCommitIdempotencyKey } from "@/lib/zoho/luma-production-output-payload";
import {
  ZOHO_BATCHES_RESOLVE_PATH,
  ZOHO_BATCH_ERROR_BATCH_MATCH_AMBIGUOUS,
  ZOHO_BATCH_ERROR_BATCH_NOT_FOUND,
  buildZohoBatchResolveRequestBody,
} from "@/lib/zoho/zoho-batch-resolve-contract";
import { evaluateV1206ProductionOutputCommitReadiness } from "@/lib/zoho/production-output-v1206-readiness";
import { blockDirectScriptCommitInProduction } from "@/lib/zoho/production-output-script-guard";
import { validateProductFamilyConsistency } from "@/lib/zoho/product-family";
import {
  CHOCO_DRIFT_HUMAN_LOT_NUMBER,
  CHOCO_DRIFT_PRODUCT_FAMILY,
  CHOCO_DRIFT_PRODUCT_ID,
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  CHOCO_DRIFT_SKU,
  CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
  buildChocoDriftComponentBatches,
  buildChocoDriftOperationSnapshot,
  chocoDriftRequiresComponentBatches,
  deriveChocoDriftRawTabletQuantity,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";

const GENERIC_BATCH_ITEM_ID = "5254962000003150096";
const GENERIC_HUMAN_LOT = "CA4PI16";
const GENERIC_BATCH_RESOLVE_SUCCESS = {
  resolved: true,
  resolution: "unique" as const,
  batch_id: "5254962000008888001",
  batch_number: GENERIC_HUMAN_LOT,
  available_balance: 4200,
  item_id: GENERIC_BATCH_ITEM_ID,
  human_lot_number: GENERIC_HUMAN_LOT,
};
/** Synthetic inventory_bags.id for contract tests — not staging/production data. */
const TEST_INVENTORY_BAG_ID = "00000000-0000-4000-8000-000000000099";
/** Staging workflow_bags.id (must never be used as source_bag_id). */
const STAGING_WORKFLOW_BAG_ID = "9a84d52a-0e18-4f91-907d-947a81280ec8";

describe("canonical Zoho batch resolver", () => {
  it("uses POST /zoho/items/batches/resolve", () => {
    expect(ZOHO_BATCHES_RESOLVE_PATH).toBe("/zoho/items/batches/resolve");
  });

  it("sends exact resolve request body", async () => {
    const body = buildZohoBatchResolveRequestBody(GENERIC_BATCH_ITEM_ID, GENERIC_HUMAN_LOT);
    expect(body).toEqual({
      item_id: GENERIC_BATCH_ITEM_ID,
      human_lot_number: GENERIC_HUMAN_LOT,
    });

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/zoho/items/batches/resolve");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return new Response(JSON.stringify(GENERIC_BATCH_RESOLVE_SUCCESS), {
        status: 200,
      });
    };

    const result = await resolveZohoComponentBatch({
      itemId: GENERIC_BATCH_ITEM_ID,
      humanLotNumber: GENERIC_HUMAN_LOT,
      env: {
        ZOHO_INTEGRATION_URL: "http://zoho.test",
        ZOHO_SERVICE_BEARER_SECRET: "secret",
        ZOHO_BRAND: "haute_brands",
      },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("UNIQUE");
      expect(result.result.batchId).toBe("5254962000008888001");
      if (result.result.status === "UNIQUE") {
        expect(result.result.batchNumber).toBe(GENERIC_HUMAN_LOT);
        expect(result.result.availableBalance).toBe(4200);
      }
    }
  });

  it("accepts resolved:true canonical success", () => {
    const result = classifyBatchResolveResponse(
      GENERIC_BATCH_RESOLVE_SUCCESS,
      GENERIC_BATCH_ITEM_ID,
      GENERIC_HUMAN_LOT,
      200,
    );
    expect(result.status).toBe("UNIQUE");
  });

  it("accepts transitional resolution:unique without resolved flag", () => {
    const result = classifyBatchResolveResponse(
      {
        resolution: "unique",
        batch_id: "5254962000008888001",
      },
      GENERIC_BATCH_ITEM_ID,
      GENERIC_HUMAN_LOT,
      200,
    );
    expect(result.status).toBe("UNIQUE");
  });

  it("normalizes HTTP 404 BATCH_NOT_FOUND to MISSING", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          resolved: false,
          resolution: "missing",
          error: { code: ZOHO_BATCH_ERROR_BATCH_NOT_FOUND, message: "No batch" },
        }),
        { status: 404 },
      );

    const result = await resolveZohoComponentBatch({
      itemId: GENERIC_BATCH_ITEM_ID,
      humanLotNumber: GENERIC_HUMAN_LOT,
      env: {
        ZOHO_INTEGRATION_URL: "http://zoho.test",
        ZOHO_SERVICE_BEARER_SECRET: "secret",
        ZOHO_BRAND: "haute_brands",
      },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.status).toBe("MISSING");
  });

  it("normalizes HTTP 422 BATCH_MATCH_AMBIGUOUS without auto-select", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          resolved: false,
          resolution: "ambiguous",
          error: { code: ZOHO_BATCH_ERROR_BATCH_MATCH_AMBIGUOUS },
          candidates: [
            { batch_id: "a", human_lot_number: GENERIC_HUMAN_LOT },
            { batch_id: "b", human_lot_number: GENERIC_HUMAN_LOT },
          ],
        }),
        { status: 422 },
      );

    const result = await resolveZohoComponentBatch({
      itemId: GENERIC_BATCH_ITEM_ID,
      humanLotNumber: GENERIC_HUMAN_LOT,
      env: {
        ZOHO_INTEGRATION_URL: "http://zoho.test",
        ZOHO_SERVICE_BEARER_SECRET: "secret",
        ZOHO_BRAND: "haute_brands",
      },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("AMBIGUOUS");
      if (result.result.status === "AMBIGUOUS") {
        expect(result.result.batchId).toBeNull();
        expect(result.result.candidates).toHaveLength(2);
      }
    }
  });
});

describe("luma_operation_snapshot contract", () => {
  const chocoSnapshot = buildChocoDriftOperationSnapshot({
    finishedLotId: "lot-choco-1",
    workflowBagId: "wfb-choco-1",
    closedAllocationSession: { inventoryBagId: TEST_INVENTORY_BAG_ID },
    unitAssemblyQuantity: 900,
  });

  const allocations = [
    {
      lumaInventoryBagId: TEST_INVENTORY_BAG_ID,
      zohoComponentItemId: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
      humanLotNumber: CHOCO_DRIFT_HUMAN_LOT_NUMBER,
      quantityAllocated: deriveChocoDriftRawTabletQuantity(900),
    },
  ];

  it("builds snapshot with Luma product_id separate from unit_composite_item_id", () => {
    const built = buildLumaOperationSnapshotFromOpRow(
      {
        lumaOperationId: chocoSnapshot.luma_operation_id,
        finalizedAt: new Date(chocoSnapshot.finalized_at),
        productId: CHOCO_DRIFT_PRODUCT_ID,
        productFamily: CHOCO_DRIFT_PRODUCT_FAMILY,
        finishedSku: CHOCO_DRIFT_SKU,
        unitCompositeItemId: CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
        workflowBagId: chocoSnapshot.workflow_bag_id,
        finishedLotId: chocoSnapshot.finished_lot_id,
      },
      allocations,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.snapshot.product_id).toBe(CHOCO_DRIFT_PRODUCT_ID);
    expect(built.snapshot.unit_composite_item_id).toBe(
      CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
    );
    expect(built.snapshot.product_id).not.toBe(built.snapshot.unit_composite_item_id);
    expect(built.snapshot).toEqual(chocoSnapshot);
  });

  it("rejects operation/body snapshot mismatch", () => {
    const tampered = {
      ...chocoSnapshot,
      unit_composite_item_id: "5254962000009999999",
    };
    const verify = verifySnapshotMatchesPersistedOperation(chocoSnapshot, tampered);
    expect(verify.ok).toBe(false);
  });

  it("attaches snapshot to outbound payload", () => {
    const payload = attachSnapshotToPayload({ source: "LUMA" }, chocoSnapshot);
    expect(payload.luma_operation_snapshot.finished_lot_id).toBe("lot-choco-1");
    expect(payload.luma_operation_snapshot.unit_composite_item_id).toBe(
      CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
    );
  });
});

describe("Choco Drift shared contract fixture", () => {
  it("does not require component_batches after confirmed non-batch BOM", () => {
    expect(chocoDriftRequiresComponentBatches()).toBe(false);
    expect(buildChocoDriftComponentBatches()).toEqual([]);
  });
});

describe("preview writes_allowed gate", () => {
  it("requires writes_allowed=true before commit", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: {
        source: "LUMA",
        idempotency_key: buildLumaProductionOutputStableCommitIdempotencyKey("lot-1"),
        output: { units_produced: 1 },
        component_batches: [],
        product: { sku: "tt-product-31" },
      },
      previewHttpStatus: 200,
      previewResponse: { ok: true, writes_allowed: false },
      previewStatus: "ready",
      previewWritesAllowed: false,
      commitIdempotencyKey: buildLumaProductionOutputStableCommitIdempotencyKey("lot-1"),
      finishedLotExists: true,
      workflowBagId: "wfb-1",
      sourceAllocationCount: 1,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: true,
    });
    expect(result.blockers.some((b) => b.code === "PREVIEW_WRITES_NOT_ALLOWED")).toBe(true);
  });

  it("parses writes_allowed from preview response", () => {
    expect(parsePreviewWritesAllowed({ writes_allowed: true })).toBe(true);
    expect(
      parsePreviewWritesAllowed({ verification: { mode: "snapshot", writes_allowed: true } }),
    ).toBe(true);
  });
});

describe("contract gates", () => {
  it("blocks product-family mismatch", () => {
    const result = validateProductFamilyConsistency({
      outputProductFamily: "HYROXI_MIT_A",
      poLineProductFamily: "FX_MIT",
      outputCompositeItemId: CHOCO_DRIFT_UNIT_COMPOSITE_ITEM_ID,
      poLineZohoItemId: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
    });
    expect(result.ok).toBe(false);
  });

  it("blocks script commit in production", () => {
    expect(
      blockDirectScriptCommitInProduction({
        NODE_ENV: "production",
        ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS: "false",
      }).blocked,
    ).toBe(true);
  });

  it("uses stable idempotency key from finishedLotId", () => {
    expect(buildLumaProductionOutputStableCommitIdempotencyKey("abc")).toBe(
      "luma-production-output:abc",
    );
  });
});
