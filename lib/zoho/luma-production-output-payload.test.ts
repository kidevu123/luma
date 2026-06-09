import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildLumaProductionOutputPayloadFromContext,
  buildLumaProductionOutputStableCommitIdempotencyKey,
} from "@/lib/zoho/luma-production-output-payload";
import { evaluateConsolidatedProductionOutputProcessCommitEligibility } from "@/lib/zoho/production-output-consolidated-eligibility";
import { callProductionOutputCommit } from "@/lib/zoho/production-output-service-client";
import { isLegacyAssemblyEnqueueEnabled } from "@/lib/zoho/production-output-config";

const baseProduct = {
  id: "prod-1",
  sku: "SKU-1",
  name: "Test Product",
  zohoItemIdUnit: "zoho-unit-1",
  zohoItemIdDisplay: "zoho-display-1",
  zohoItemIdCase: "zoho-case-1",
};

const baseLedgerRow = {
  inventoryBagId: "inv-1",
  internalReceiptNumber: "352171",
  consumedQty: 1000,
  tabletTypeId: "tt-1",
  tabletName: "MIT B Orange Citrus",
  tabletZohoItemId: "zoho-tablet-1",
  lumaPoId: "po-luma-69",
  lumaPoLineId: "line-luma-69",
  zohoPoId: "zoho-po-69",
  zohoLineItemId: "zoho-line-69",
};

function buildInput(overrides: Partial<Parameters<typeof buildLumaProductionOutputPayloadFromContext>[0]> = {}) {
  return {
    finishedLotId: "lot-1",
    workflowBagId: "wf-1",
    finishedLotNumber: "FL-001",
    traceCode: "FL-TRACE-001",
    producedOn: "2026-06-04",
    packedAt: new Date("2026-06-04T20:00:00Z"),
    unitsProduced: 900,
    displaysProduced: 20,
    casesProduced: 5,
    product: baseProduct,
    metrics: { damagedPackaging: 0, rippedCards: 1, looseCards: 2 },
    ledgerRows: [baseLedgerRow],
    warehouseId: "wh-1",
    ...overrides,
  };
}

describe("buildLumaProductionOutputPayloadFromContext", () => {
  it("builds PO 69-style source receipt with quantity_consumed 1000", () => {
    const r = buildLumaProductionOutputPayloadFromContext(buildInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.source_receipts).toHaveLength(1);
    expect(r.payload.source_receipts[0]?.quantity_consumed).toBe(1000);
    expect(r.payload.source_receipts[0]?.zoho_purchaseorder_id).toBe("zoho-po-69");
    expect(r.payload.output.units_produced).toBe(900);
    expect(r.payload.output.displays_produced).toBe(20);
    expect(r.payload.output.cases_produced).toBe(5);
  });

  it("uses stable idempotency key per finished lot", () => {
    expect(buildLumaProductionOutputStableCommitIdempotencyKey("lot-1")).toBe(
      "luma-production-output:lot-1",
    );
    const r = buildLumaProductionOutputPayloadFromContext(buildInput());
    if (!r.ok) throw new Error("expected ok");
    expect(r.payload.idempotency_key).toBe("luma-production-output:lot-1");
  });

  it("returns NEEDS_MAPPING blockers when Zoho PO ID missing", () => {
    const r = buildLumaProductionOutputPayloadFromContext(
      buildInput({
        ledgerRows: [{ ...baseLedgerRow, zohoPoId: null }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers.some((b) => b.code === "MISSING_ZOHO_PO_ID")).toBe(true);
  });

  it("returns NEEDS_MAPPING when PO line Zoho ID missing", () => {
    const r = buildLumaProductionOutputPayloadFromContext(
      buildInput({
        ledgerRows: [{ ...baseLedgerRow, zohoLineItemId: null }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers.some((b) => b.code === "MISSING_ZOHO_PO_LINE_ITEM_ID")).toBe(true);
  });

  it("blocks live commit when allocation ledger missing", () => {
    const r = buildLumaProductionOutputPayloadFromContext(
      buildInput({ ledgerRows: [] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockers.some((b) => b.code === "MISSING_ALLOCATION_LEDGER")).toBe(true);
  });

  it("does not treat missing metrics as zero — sends null", () => {
    const r = buildLumaProductionOutputPayloadFromContext(
      buildInput({ metrics: null }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.output.damaged_packaging).toBeNull();
    expect(r.metricsState).toBe("MISSING");
  });
});

describe("consolidated commit eligibility", () => {
  it("blocks when already committed op exists", () => {
    const r = evaluateConsolidatedProductionOutputProcessCommitEligibility({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: {
        source: "LUMA",
        idempotency_key: "luma-production-output:lot-1",
      },
      commitIdempotencyKey: "luma-production-output:lot-1",
      finishedLotExists: true,
      committedOpExists: true,
      legacyAssemblyOpExists: false,
      legacyZohoPushExists: false,
      productionOutputEnabled: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.blockers.some((b) => b.code === "ALREADY_COMMITTED")).toBe(true);
  });

  it("blocks when legacy assembly ops exist", () => {
    const r = evaluateConsolidatedProductionOutputProcessCommitEligibility({
      opExists: true,
      status: "QUEUED",
      voidedAt: null,
      payloadKind: "consolidated",
      requestPayload: {
        source: "LUMA",
        idempotency_key: "luma-production-output:lot-1",
      },
      commitIdempotencyKey: "luma-production-output:lot-1",
      finishedLotExists: true,
      committedOpExists: false,
      legacyAssemblyOpExists: true,
      legacyZohoPushExists: false,
      productionOutputEnabled: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.blockers.some((b) => b.code === "LEGACY_ASSEMBLY_OP_EXISTS")).toBe(true);
  });
});

describe("callProductionOutputCommit", () => {
  const env = {
    ZOHO_SERVICE_BASE_URL: "http://zoho-service.test",
    ZOHO_SERVICE_BEARER_SECRET: "secret",
    ZOHO_BRAND: "haute_brands",
    ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
    ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
    ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "true",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: true, external_reference_id: "zoho-ref-123" },
          { status: 200 },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns guard failure when commit disabled", async () => {
    const built = buildLumaProductionOutputPayloadFromContext(buildInput());
    if (!built.ok) throw new Error("expected ok");
    const r = await callProductionOutputCommit({
      payload: built.payload,
      idempotencyKey: "luma-production-output:lot-1",
      env: {
        ...env,
        ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("guard");
  });

  it("marks service success on 200", async () => {
    const built = buildLumaProductionOutputPayloadFromContext(buildInput());
    if (!built.ok) throw new Error("expected ok");
    const r = await callProductionOutputCommit({
      payload: built.payload,
      idempotencyKey: "luma-production-output:lot-1",
      env,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.externalReferenceId).toBe("zoho-ref-123");
  });
});

describe("legacy assembly enqueue gate", () => {
  it("disables legacy enqueue when consolidated persist enabled without override", () => {
    expect(
      isLegacyAssemblyEnqueueEnabled({
        ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
        ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED: "false",
      }),
    ).toBe(false);
  });
});
