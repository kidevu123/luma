import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildLumaProductionOutputOperationId,
  buildLumaProductionOutputStableCommitIdempotencyKey,
  type LumaProductionOutputPayload,
} from "./luma-production-output-payload";
import {
  buildProductionOutputServicePayloadFromLuma,
  isInternalLumaProductionOutputPayloadBody,
  PRODUCTION_OUTPUT_SERVICE_COMMIT_NOTES,
  PRODUCTION_OUTPUT_SERVICE_PREVIEW_NOTES,
} from "./production-output-service-payload";
import {
  FIX_RELAX_FINISHED_LOT_ID,
  FIX_RELAX_PACKAGING_ITEM_ID,
  FIX_RELAX_PRODUCT_ID,
  FIX_RELAX_RAW_TABLET_ITEM_ID,
  FIX_RELAX_SOURCE_BAG_ID,
  FIX_RELAX_UNIT_COMPOSITE_ITEM_ID,
  FIX_RELAX_ZOHO_PURCHASE_RECEIVE_ID,
  deriveFixRelaxBomConsumption,
} from "./v1206-fix-relax-pilot-contract";
import { callProductionOutputCommit } from "./production-output-service-client";
import { stableStringifyProductionOutputPreview } from "./production-output-preview";

const FIX_RELAX_PO_ID = "5254962000006199381";
const FIX_RELAX_PO_LINE_ID = "5254962000006199384";
const UNIT_QTY = 10;

function fixRelaxLumaPayload(): LumaProductionOutputPayload {
  return {
    source: "LUMA",
    luma_finished_lot_id: FIX_RELAX_FINISHED_LOT_ID,
    luma_workflow_bag_id: "97b9994d-4d04-4f28-bb79-fb0fc9a6d347",
    finished_lot_number: "PO-00249-R1-B1-2",
    trace_code: "PO-00249-R1-B1-2",
    product: {
      luma_product_id: FIX_RELAX_PRODUCT_ID,
      sku: "tt-product-19",
      name: "FIX Relax 1ct",
      unit_composite_item_id: FIX_RELAX_UNIT_COMPOSITE_ITEM_ID,
      display_composite_item_id: null,
      case_composite_item_id: null,
    },
    source_receipts: [
      {
        luma_inventory_bag_id: FIX_RELAX_SOURCE_BAG_ID,
        internal_receipt_number: "PO-00249-R1-B1-2",
        luma_po_id: "459e8137-e0d8-4a49-8a41-f1a10cca18a8",
        zoho_purchaseorder_id: FIX_RELAX_PO_ID,
        luma_po_line_id: "978666e1-16af-40ee-bc06-aecc8873a52b",
        zoho_purchaseorder_line_item_id: FIX_RELAX_PO_LINE_ID,
        tablet_type_id: "a877fb1e-6cfa-4604-b944-d3adc3119da8",
        tablet_name: "1ct FIX Relax",
        tablet_zoho_item_id: FIX_RELAX_RAW_TABLET_ITEM_ID,
        quantity_consumed: UNIT_QTY,
      },
    ],
    source_receipt_evidence: [
      {
        source_bag_id: FIX_RELAX_SOURCE_BAG_ID,
        internal_receipt_number: "PO-00249-R1-B1-2",
        zoho_purchase_receive_id: FIX_RELAX_ZOHO_PURCHASE_RECEIVE_ID,
        received_quantity: 500,
        purchaseorder_id: FIX_RELAX_PO_ID,
        purchaseorder_line_item_id: FIX_RELAX_PO_LINE_ID,
        raw_item_id: FIX_RELAX_RAW_TABLET_ITEM_ID,
        api_receive_status: "received",
        api_reconciliation_status: "received_by_luma",
        received_at: "2026-06-11T15:26:00.000Z",
        has_durable_row: true,
      },
    ],
    output: {
      units_produced: UNIT_QTY,
      displays_produced: 0,
      cases_produced: 0,
      damaged_packaging: 0,
      ripped_cards: 0,
      loose_cards: 0,
    },
    production_dates: {
      produced_on: "2026-06-11",
      packed_at: "2026-06-11T14:53:02.251Z",
      receive_date: "2026-06-11",
    },
    component_batches: [],
    idempotency_key: buildLumaProductionOutputStableCommitIdempotencyKey(
      FIX_RELAX_FINISHED_LOT_ID,
    ),
  };
}

describe("buildProductionOutputServicePayloadFromLuma — FIX Relax", () => {
  it("maps FIX Relax pilot to Zoho service commit contract", () => {
    const luma = fixRelaxLumaPayload();
    const service = buildProductionOutputServicePayloadFromLuma(luma);

    expect(service.purchaseorder_id).toBe(FIX_RELAX_PO_ID);
    expect(service.purchaseorder_line_item_id).toBe(FIX_RELAX_PO_LINE_ID);
    expect(service.quantity_good).toBe(UNIT_QTY);
    expect(service.unit_assembly_quantity).toBe(UNIT_QTY);
    expect(service.quantity_loose).toBe(0);
    expect(service.unit_composite_item_id).toBe(FIX_RELAX_UNIT_COMPOSITE_ITEM_ID);
    expect(service.assembly_only).toBe(true);
    expect(service.luma_operation_id).toBe(
      buildLumaProductionOutputOperationId(FIX_RELAX_FINISHED_LOT_ID),
    );

    const receipt = service.source_receipts?.[0];
    expect(receipt?.source_bag_id).toBe(FIX_RELAX_SOURCE_BAG_ID);
    expect(receipt?.zoho_purchase_receive_id).toBe(FIX_RELAX_ZOHO_PURCHASE_RECEIVE_ID);
    expect(receipt?.reconciliation_status).toBe("received_by_luma");

    const bom = deriveFixRelaxBomConsumption(UNIT_QTY);
    expect(bom.find((c) => c.item_id === FIX_RELAX_RAW_TABLET_ITEM_ID)?.quantity_consumed).toBe(
      10,
    );
    expect(bom.find((c) => c.item_id === FIX_RELAX_PACKAGING_ITEM_ID)?.quantity_consumed).toBe(
      10,
    );

    expect(service).not.toHaveProperty("source");
    expect(service).not.toHaveProperty("source_receipt_evidence");
    expect(isInternalLumaProductionOutputPayloadBody(luma)).toBe(true);
    expect(isInternalLumaProductionOutputPayloadBody(service)).toBe(false);
  });

  it("preview and commit bodies match except notes", () => {
    const luma = fixRelaxLumaPayload();
    const preview = buildProductionOutputServicePayloadFromLuma(luma, {
      notes: PRODUCTION_OUTPUT_SERVICE_PREVIEW_NOTES,
    });
    const commit = buildProductionOutputServicePayloadFromLuma(luma, {
      notes: PRODUCTION_OUTPUT_SERVICE_COMMIT_NOTES,
    });

    const previewSansNotes = { ...preview, notes: undefined };
    const commitSansNotes = { ...commit, notes: undefined };
    expect(stableStringifyProductionOutputPreview(previewSansNotes)).toBe(
      stableStringifyProductionOutputPreview(commitSansNotes),
    );
    expect(preview.notes).toBe(PRODUCTION_OUTPUT_SERVICE_PREVIEW_NOTES);
    expect(commit.notes).toBe(PRODUCTION_OUTPUT_SERVICE_COMMIT_NOTES);
  });

  it("uses stable idempotency key on internal LUMA payload only", () => {
    const luma = fixRelaxLumaPayload();
    expect(luma.idempotency_key).toBe(
      "luma-production-output:61c0ad45-dd1a-4764-b560-57291cf35022",
    );
  });
});

describe("callProductionOutputCommit — payload contract", () => {
  const env = {
    ZOHO_SERVICE_BASE_URL: "http://zoho-service.test",
    ZOHO_SERVICE_BEARER_SECRET: "secret",
    ZOHO_BRAND: "haute_brands",
    ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
    ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
    ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "true",
  };

  let fetchBody: string | undefined;

  beforeEach(() => {
    fetchBody = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchBody = typeof init?.body === "string" ? init.body : undefined;
        return Response.json({ committed: true, steps: [] }, { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never POSTs internal LUMA source payload to Zoho commit", async () => {
    const luma = fixRelaxLumaPayload();
    const service = buildProductionOutputServicePayloadFromLuma(luma);

    await callProductionOutputCommit({
      payload: service,
      idempotencyKey: luma.idempotency_key,
      env,
    });

    expect(fetchBody).toBeDefined();
    const posted = JSON.parse(fetchBody!) as Record<string, unknown>;
    expect(posted.source).toBeUndefined();
    expect(posted.luma_finished_lot_id).toBeUndefined();
    expect(posted.source_receipt_evidence).toBeUndefined();
    expect(posted.purchaseorder_id).toBe(FIX_RELAX_PO_ID);
    expect(posted.assembly_only).toBe(true);
    expect(isInternalLumaProductionOutputPayloadBody(posted)).toBe(false);
  });

  it("returns service failure on HTTP 409 without treating as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            detail: {
              error: {
                code: "ZOHO_IDEMPOTENCY_CONFLICT",
                message: "Idempotency-Key has been used with a different request payload.",
              },
            },
          },
          { status: 409 },
        ),
      ),
    );

    const service = buildProductionOutputServicePayloadFromLuma(fixRelaxLumaPayload());
    const result = await callProductionOutputCommit({
      payload: service,
      idempotencyKey: buildLumaProductionOutputStableCommitIdempotencyKey(
        FIX_RELAX_FINISHED_LOT_ID,
      ),
      env,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(409);
    expect(result.kind).toBe("service");
  });
});
