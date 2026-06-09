import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_OUTPUT_PREVIEW_PATH,
  buildProductionOutputPreviewHeaders,
  buildProductionOutputPreviewIdempotencyKey,
  buildProductionOutputPreviewPayload,
  buildProductionOutputPreviewRequestHash,
  callProductionOutputPreview,
  classifyProductionOutputGenealogyState,
  classifyProductionOutputMetricsState,
  validateProductionOutputPreviewConfig,
  type ProductionOutputPreviewBuildInput,
} from "./production-output-preview";

const BASE_INPUT: ProductionOutputPreviewBuildInput = {
  finishedLotId: "11111111-1111-4111-8111-111111111111",
  workflowBagId: "22222222-2222-4222-8222-222222222222",
  producedOn: "2026-05-28",
  unitsProduced: 100,
  displaysProduced: 5,
  casesProduced: 1,
  product: {
    zohoItemIdUnit: "unit-composite-1",
    zohoItemIdDisplay: "display-composite-1",
    zohoItemIdCase: "case-composite-1",
  },
  metrics: {
    damagedPackaging: 2,
    rippedCards: 3,
    looseCards: 4,
  },
  mapping: {
    purchaseorderId: "po-1",
    purchaseorderLineItemId: "line-1",
    warehouseId: "warehouse-1",
    notes: "Preview check",
  },
};

const VALID_ENV = {
  ZOHO_SERVICE_BASE_URL: "http://192.168.1.205:8000",
  ZOHO_SERVICE_BEARER_SECRET: "secret-prefix-rest",
  ZOHO_BRAND: "haute_brands",
  ZOHO_WAREHOUSE_ID: "warehouse-env",
  ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
};

describe("buildProductionOutputPreviewPayload", () => {
  it("maps finished lot, product, and metrics fields to the Zoho v1.19 contract", () => {
    const result = buildProductionOutputPreviewPayload(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      purchaseorder_id: "po-1",
      purchaseorder_line_item_id: "line-1",
      quantity_good: 100,
      receive_date: "2026-05-28",
      warehouse_id: "warehouse-1",
      unit_composite_item_id: "unit-composite-1",
      unit_assembly_quantity: 100,
      display_composite_item_id: "display-composite-1",
      display_assembly_quantity: 5,
      case_composite_item_id: "case-composite-1",
      case_assembly_quantity: 1,
      quantity_damaged: 2,
      quantity_ripped: 3,
      quantity_loose: 4,
      luma_operation_id:
        "luma-production-output-preview:11111111-1111-4111-8111-111111111111",
      luma_bag_id: BASE_INPUT.workflowBagId,
      luma_workflow_session_id: BASE_INPUT.workflowBagId,
      notes: "Preview check",
    });
  });

  it("requires display and case composite IDs only when corresponding quantities are positive", () => {
    const noDisplayCase = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      displaysProduced: 0,
      casesProduced: null,
      product: {
        zohoItemIdUnit: "unit-composite-1",
        zohoItemIdDisplay: null,
        zohoItemIdCase: null,
      },
    });
    expect(noDisplayCase.ok).toBe(true);
    if (!noDisplayCase.ok) return;
    expect(noDisplayCase.payload.display_composite_item_id).toBeUndefined();
    expect(noDisplayCase.payload.case_composite_item_id).toBeUndefined();

    const missingDisplay = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      displaysProduced: 1,
      casesProduced: 0,
      product: {
        zohoItemIdUnit: "unit-composite-1",
        zohoItemIdDisplay: null,
        zohoItemIdCase: null,
      },
    });
    expect(missingDisplay.ok).toBe(false);
    if (missingDisplay.ok) return;
    expect(missingDisplay.blockers.map((b) => b.field)).toContain(
      "display_composite_item_id",
    );
    expect(missingDisplay.blockers.map((b) => b.field)).not.toContain(
      "case_composite_item_id",
    );
  });

  it("defaults damaged, ripped, and loose values to zero when metrics are unavailable", () => {
    const result = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      metrics: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.quantity_damaged).toBe(0);
    expect(result.payload.quantity_ripped).toBe(0);
    expect(result.payload.quantity_loose).toBe(0);
  });

  it("returns a clear local blocker when warehouse env and form value are both absent", () => {
    const result = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, warehouseId: "" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers).toContainEqual({
      field: "warehouse_id",
      message:
        "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered.",
    });
  });
});

describe("production output preview client", () => {
  it("uses bearer auth, X-Brand, idempotency key, and no X-Internal-Token", () => {
    const headers = buildProductionOutputPreviewHeaders({
      bearerSecret: "actual-secret",
      brand: "haute_brands",
      idempotencyKey: "idem-1",
    });
    expect(headers["Authorization"]).toBe("Bearer actual-secret");
    expect(headers["X-Brand"]).toBe("haute_brands");
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers)).not.toContain("X-Internal-Token");
  });

  it("posts only to the production output preview endpoint and never commit", async () => {
    const result = buildProductionOutputPreviewPayload(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ preview: true }), { status: 200 }),
      );
    const response = await callProductionOutputPreview({
      payload: result.payload,
      idempotencyKey: "idem-1",
      env: VALID_ENV,
      fetchImpl,
    });

    expect(response.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://192.168.1.205:8000${PRODUCTION_OUTPUT_PREVIEW_PATH}`,
    );
    expect(url).not.toContain("/commit");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-prefix-rest");
    expect(headers["X-Brand"]).toBe("haute_brands");
    expect(Object.keys(headers)).not.toContain("X-Internal-Token");
  });

  it("makes no HTTP call when service config is missing", async () => {
    const result = buildProductionOutputPreviewPayload(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fetchImpl = vi.fn();
    const response = await callProductionOutputPreview({
      payload: result.payload,
      idempotencyKey: "idem-1",
      env: {},
      fetchImpl,
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.httpStatus).toBeNull();
    expect(response.message).toMatch(
      /ZOHO_SERVICE_BASE_URL|ZOHO_INTEGRATION_URL/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [400, "validation"],
    [422, "validation"],
  ])(
    "surfaces HTTP %i preview/preflight feedback instead of swallowing it",
    async (status, phrase) => {
      const result = buildProductionOutputPreviewPayload(BASE_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "PO_NOT_FOUND", message: "missing PO" }),
          {
            status,
          },
        ),
      );

      const response = await callProductionOutputPreview({
        payload: result.payload,
        idempotencyKey: "idem-1",
        env: VALID_ENV,
        fetchImpl,
      });

      expect(response.ok).toBe(false);
      if (response.ok) return;
      expect(response.httpStatus).toBe(status);
      expect(response.message.toLowerCase()).toContain(phrase);
      expect(response.body).toEqual({
        code: "PO_NOT_FOUND",
        message: "missing PO",
      });
    },
  );
});

describe("buildProductionOutputPreviewIdempotencyKey", () => {
  it("is stable for the same payload and changes when admin edits mapping inputs", () => {
    const result = buildProductionOutputPreviewPayload(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = buildProductionOutputPreviewIdempotencyKey(
      BASE_INPUT.finishedLotId,
      result.payload,
    );
    const second = buildProductionOutputPreviewIdempotencyKey(
      BASE_INPUT.finishedLotId,
      result.payload,
    );
    expect(second).toBe(first);

    const changed = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, purchaseorderLineItemId: "line-2" },
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(
      buildProductionOutputPreviewIdempotencyKey(
        BASE_INPUT.finishedLotId,
        changed.payload,
      ),
    ).not.toBe(first);
    expect(buildProductionOutputPreviewRequestHash(changed.payload)).not.toBe(
      buildProductionOutputPreviewRequestHash(result.payload),
    );
  });
});

describe("production output preview data quality states", () => {
  it("classifies metrics as missing when the preview contract had to default to zero", () => {
    expect(
      classifyProductionOutputMetricsState({
        workflowBagId: BASE_INPUT.workflowBagId,
        metrics: BASE_INPUT.metrics,
      }),
    ).toBe("HIGH");
    expect(
      classifyProductionOutputMetricsState({
        workflowBagId: BASE_INPUT.workflowBagId,
        metrics: null,
      }),
    ).toBe("MISSING");
    expect(
      classifyProductionOutputMetricsState({
        workflowBagId: null,
        metrics: BASE_INPUT.metrics,
      }),
    ).toBe("MISSING");
  });

  it("classifies genealogy as high, low, or missing without overstating confidence", () => {
    expect(
      classifyProductionOutputGenealogyState({
        workflowBagId: BASE_INPUT.workflowBagId,
        rawBagLinkCount: 1,
        highConfidenceRawBagLinkCount: 1,
      }),
    ).toBe("HIGH");
    expect(
      classifyProductionOutputGenealogyState({
        workflowBagId: BASE_INPUT.workflowBagId,
        rawBagLinkCount: 0,
        highConfidenceRawBagLinkCount: 0,
      }),
    ).toBe("LOW");
    expect(
      classifyProductionOutputGenealogyState({
        workflowBagId: null,
        rawBagLinkCount: 0,
        highConfidenceRawBagLinkCount: 0,
      }),
    ).toBe("MISSING");
  });
});

describe("validateProductionOutputPreviewConfig", () => {
  it("reads ZOHO_WAREHOUSE_ID as a default only", () => {
    const result = validateProductionOutputPreviewConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.defaultWarehouseId).toBe("warehouse-env");
  });

  it("fails when preview gate is disabled", () => {
    const result = validateProductionOutputPreviewConfig({
      ...VALID_ENV,
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "false",
    });
    expect(result.ok).toBe(false);
  });
});
