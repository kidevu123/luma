import { describe, expect, it } from "vitest";
import { classifyBatchLookupResponse } from "@/lib/zoho/component-batch-resolution";
import {
  buildLumaProductionOutputPayloadFromContext,
  type LumaProductionOutputPayload,
} from "@/lib/zoho/luma-production-output-payload";
import {
  deriveProductFamilyFromName,
  validateProductFamilyConsistency,
} from "@/lib/zoho/product-family";
import {
  blockDirectScriptCommitInProduction,
} from "@/lib/zoho/production-output-script-guard";
import {
  deriveUiOperationStatus,
  evaluateV1206ProductionOutputCommitReadiness,
} from "@/lib/zoho/production-output-v1206-readiness";

const basePayloadInput = {
  finishedLotId: "lot-1",
  workflowBagId: "wfb-1",
  finishedLotNumber: "FL-001",
  traceCode: "TR-001",
  producedOn: "2026-06-10",
  packedAt: null,
  unitsProduced: 900,
  displaysProduced: 0,
  casesProduced: 0,
  product: {
    id: "prod-1",
    sku: "tt-product-31",
    name: "Hyroxi MIT A - Pineapple Express",
    zohoItemIdUnit: "5254962000003150096",
    zohoItemIdDisplay: null,
    zohoItemIdCase: null,
  },
  metrics: { damagedPackaging: 0, rippedCards: 0, looseCards: 0 },
  ledgerRows: [
    {
      inventoryBagId: "bag-1",
      internalReceiptNumber: "6337-26",
      consumedQty: 900,
      tabletTypeId: "tt-1",
      tabletName: "Hyroxi Mit A - Pineapple",
      tabletZohoItemId: "5254962000003150096",
      lumaPoId: "po-1",
      lumaPoLineId: "line-1",
      zohoPoId: "5254962000005963030",
      zohoLineItemId: "5254962000005963033",
    },
  ],
  componentBatches: [
    {
      item_id: "5254962000003150096",
      source_bag_id: "bag-1",
      human_lot_number: "CA4PI16",
      batches: [{ batch_id: "zoho-batch-1", out_quantity: 900 }],
    },
  ],
  requireComponentBatches: false,
  warehouseId: "wh-1",
};

describe("product family validation", () => {
  it("blocks FX MIT PO with Hyroxi output", () => {
    expect(deriveProductFamilyFromName("FX MIT - Pink Lemonade")).toBe("FX_MIT");
    expect(deriveProductFamilyFromName("Hyroxi MIT A - Variety Pack")).toBe(
      "HYROXI_MIT_A",
    );
    const result = validateProductFamilyConsistency({
      outputProductFamily: "HYROXI_MIT_A",
      poLineProductFamily: "FX_MIT",
      outputCompositeItemId: "5254962000003506003",
      poLineZohoItemId: "5254962000004758364",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PO_OUTPUT_FAMILY_MISMATCH");
    }
  });
});

describe("component_batches payload", () => {
  it("includes component_batches in built payload", () => {
    const built = buildLumaProductionOutputPayloadFromContext(basePayloadInput);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.component_batches).toHaveLength(1);
    expect(built.payload.component_batches[0]?.human_lot_number).toBe("CA4PI16");
  });

  it("requires component_batches for variety products when flagged", () => {
    const built = buildLumaProductionOutputPayloadFromContext({
      ...basePayloadInput,
      product: {
        ...basePayloadInput.product,
        sku: "tt-product-36",
        name: "Hyroxi MIT A - Variety Pack",
      },
      requireComponentBatches: true,
      componentBatches: [],
    });
    expect(built.ok).toBe(false);
  });
});

describe("batch resolution", () => {
  it("classifies unique batch lookup", () => {
    const result = classifyBatchLookupResponse({
      resolved: true,
      resolution: "unique",
      batch_id: "5254962000009999001",
      batch_number: "CA4PI16",
      available_balance: 100,
    });
    expect(result.status).toBe("UNIQUE");
    if (result.status === "UNIQUE") {
      expect(result.batchId).toBe("5254962000009999001");
      expect(result.batchNumber).toBe("CA4PI16");
    }
  });

  it("classifies ambiguous batch lookup", () => {
    const result = classifyBatchLookupResponse({
      resolution: "ambiguous",
      candidates: [
        { batch_id: "a", human_lot_number: "CA4PI16", item_id: "1" },
        { batch_id: "b", human_lot_number: "CA4PI16", item_id: "1" },
      ],
    });
    expect(result.status).toBe("AMBIGUOUS");
  });
});

describe("v1.20.6 commit readiness", () => {
  const readyPayload: LumaProductionOutputPayload = {
    source: "LUMA",
    luma_finished_lot_id: "lot-1",
    luma_workflow_bag_id: "wfb-1",
    finished_lot_number: "FL-001",
    trace_code: "TR-001",
    product: {
      luma_product_id: "prod-1",
      sku: "tt-product-31",
      name: "Hyroxi MIT A - Pineapple Express",
      unit_composite_item_id: "5254962000003150096",
      display_composite_item_id: null,
      case_composite_item_id: null,
    },
    source_receipts: [],
    component_batches: [],
    output: {
      units_produced: 1,
      displays_produced: 0,
      cases_produced: 0,
      damaged_packaging: 0,
      ripped_cards: 0,
      loose_cards: 0,
    },
    production_dates: {
      produced_on: "2026-06-10",
      packed_at: null,
      receive_date: "2026-06-10",
    },
    idempotency_key: "luma-production-output:lot-1",
  };

  const readyReadinessBase = {
    opExists: true,
    status: "QUEUED" as const,
    voidedAt: null,
    payloadKind: "consolidated",
    requestPayload: readyPayload,
    previewHttpStatus: 200,
    previewResponse: { ok: true, writes_allowed: true },
    previewStatus: "ready",
    previewWritesAllowed: true,
    commitIdempotencyKey: readyPayload.idempotency_key,
    finishedLotExists: true,
    workflowBagId: "wfb-1",
    sourceAllocationCount: 1,
    unresolvedBatchCount: 0,
    ambiguousBatchCount: 0,
    humanReviewRequired: false,
    partialFailure: false,
    productionOutputEnabled: true,
  };

  it("blocks commit without persisted op", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      ...readyReadinessBase,
      opExists: false,
      sourceAllocationCount: 0,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === "OP_NOT_PERSISTED")).toBe(true);
  });

  it("blocks commit without source allocations", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      ...readyReadinessBase,
      sourceAllocationCount: 0,
    });
    expect(result.blockers.some((b) => b.code === "MISSING_SOURCE_ALLOCATIONS")).toBe(
      true,
    );
  });

  it("blocks commit without successful preview", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      ...readyReadinessBase,
      previewHttpStatus: 422,
      previewResponse: { ok: false },
      previewStatus: "preview_failed",
      previewWritesAllowed: false,
    });
    expect(result.blockers.some((b) => b.code === "PREVIEW_NOT_SUCCESSFUL")).toBe(true);
  });

  it("blocks partial failure retry", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      ...readyReadinessBase,
      status: "FAILED",
      humanReviewRequired: true,
      partialFailure: true,
    });
    expect(result.blockers.some((b) => b.code === "PARTIAL_FAILURE")).toBe(true);
    expect(result.blockers.some((b) => b.code === "HUMAN_REVIEW_REQUIRED")).toBe(true);
  });

  it("allows ready single-SKU op when gates pass", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness(readyReadinessBase);
    expect(result.eligible).toBe(true);
  });
});

describe("script bypass guard", () => {
  it("blocks direct script commit in production", () => {
    const result = blockDirectScriptCommitInProduction({
      NODE_ENV: "production",
      ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS: undefined,
    });
    expect(result.blocked).toBe(true);
  });

  it("blocks script commit without persisted operation flag", () => {
    const result = evaluateV1206ProductionOutputCommitReadiness({
      opExists: false,
      status: null,
      voidedAt: null,
      payloadKind: null,
      requestPayload: null,
      previewHttpStatus: null,
      previewResponse: null,
      previewStatus: null,
      commitIdempotencyKey: null,
      finishedLotExists: false,
      workflowBagId: null,
      sourceAllocationCount: 0,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: true,
      scriptBypassAttempt: true,
      previewWritesAllowed: false,
    });
    expect(result.blockers.some((b) => b.code === "SCRIPT_BYPASS_BLOCKED")).toBe(true);
  });
});

describe("UI operation status", () => {
  it("maps partial failure to human-review-only state", () => {
    expect(
      deriveUiOperationStatus({
        status: "FAILED",
        previewStatus: "ready",
        humanReviewRequired: true,
        partialFailure: true,
        voidedAt: null,
      }),
    ).toBe("partial failure");
  });
});

describe("simple product candidate readiness shape", () => {
  it("single-SKU payload can reach ready when ledger + preview present", () => {
    const built = buildLumaProductionOutputPayloadFromContext(basePayloadInput);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const readiness = evaluateV1206ProductionOutputCommitReadiness({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: built.payload,
      previewHttpStatus: 200,
      previewResponse: { ok: true },
      previewStatus: "ready",
      commitIdempotencyKey: built.payload.idempotency_key,
      finishedLotExists: true,
      workflowBagId: "wfb-1",
      sourceAllocationCount: 1,
      unresolvedBatchCount: 0,
      ambiguousBatchCount: 0,
      humanReviewRequired: false,
      partialFailure: false,
      productionOutputEnabled: false,
      previewWritesAllowed: true,
    });
    expect(readiness.blockers.some((b) => b.code === "PRODUCTION_OUTPUT_DISABLED")).toBe(
      true,
    );
    expect(readiness.blockers.some((b) => b.code === "MISSING_COMPONENT_BATCHES")).toBe(
      false,
    );
  });
});
