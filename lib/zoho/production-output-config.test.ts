import { describe, expect, it, vi } from "vitest";
import {
  isProductionOutputCommitEnabled,
  isProductionOutputPersistEnabled,
  isProductionOutputPreviewEnabled,
  resolveProductionOutputGateConfig,
} from "@/lib/zoho/production-output-config";
import { callProductionOutputCommit } from "@/lib/zoho/production-output-service-client";
import { buildLumaProductionOutputPayloadFromContext } from "@/lib/zoho/luma-production-output-payload";
import { buildProductionOutputServicePayloadFromLuma } from "@/lib/zoho/production-output-service-payload";

const baseEnv = {
  ZOHO_SERVICE_BASE_URL: "http://zoho.test",
  ZOHO_SERVICE_BEARER_SECRET: "secret",
};

describe("resolveProductionOutputGateConfig state matrix", () => {
  it("all false → no persist/preview/commit", () => {
    const g = resolveProductionOutputGateConfig({
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "false",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "false",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
    });
    expect(g.persistEnabled).toBe(false);
    expect(g.previewEnabled).toBe(false);
    expect(g.commitEnabled).toBe(false);
    expect(isProductionOutputPersistEnabled({
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "false",
    })).toBe(false);
  });

  it("persist only → op path without preview/commit", () => {
    const env = {
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "false",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
    };
    expect(isProductionOutputPersistEnabled(env)).toBe(true);
    expect(isProductionOutputPreviewEnabled(env)).toBe(false);
    expect(isProductionOutputCommitEnabled(env)).toBe(false);
  });

  it("persist + preview → preview eligible, commit blocked", () => {
    const env = {
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
    };
    expect(isProductionOutputPersistEnabled(env)).toBe(true);
    expect(isProductionOutputPreviewEnabled(env)).toBe(true);
    expect(isProductionOutputCommitEnabled(env)).toBe(false);
  });

  it("persist + preview + commit → commit eligible after readiness gates", () => {
    const env = {
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "true",
    };
    expect(isProductionOutputCommitEnabled(env)).toBe(true);
  });

  it("preview without persist → invalid combination", () => {
    const g = resolveProductionOutputGateConfig({
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "false",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
    });
    expect(g.invalidCombination).toContain("PERSIST");
    expect(
      isProductionOutputPreviewEnabled({
        ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "false",
        ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
      }),
    ).toBe(false);
  });

  it("legacy ZOHO_PRODUCTION_OUTPUT_ENABLED=true maps persist+preview only, never commit", () => {
    const g = resolveProductionOutputGateConfig({
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_ENABLED: "true",
    });
    expect(g.legacyEnabledFlagSeen).toBe(true);
    expect(g.persistEnabled).toBe(true);
    expect(g.previewEnabled).toBe(true);
    expect(g.commitEnabled).toBe(false);
    expect(
      isProductionOutputCommitEnabled({
        ZOHO_PRODUCTION_OUTPUT_ENABLED: "true",
      }),
    ).toBe(false);
  });

  it("split flags override legacy — legacy cannot enable commit", () => {
    const env = {
      ...baseEnv,
      ZOHO_PRODUCTION_OUTPUT_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
    };
    expect(isProductionOutputCommitEnabled(env)).toBe(false);
  });
});

describe("callProductionOutputCommit guard", () => {
  const payloadEnv = {
    ...baseEnv,
    ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
    ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
    ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
  };

  it("does not call fetch when commit disabled", async () => {
    const fetchMock = vi.fn();
    const built = buildLumaProductionOutputPayloadFromContext({
      finishedLotId: "lot-1",
      workflowBagId: "wf-1",
      finishedLotNumber: "FL-1",
      traceCode: "FL-1",
      producedOn: "2026-06-04",
      packedAt: new Date("2026-06-04T20:00:00Z"),
      unitsProduced: 10,
      displaysProduced: 0,
      casesProduced: 0,
      metrics: null,
      product: {
        id: "p1",
        sku: "453535",
        name: "Choco",
        zohoItemIdUnit: "unit-1",
        zohoItemIdDisplay: null,
        zohoItemIdCase: null,
      },
      ledgerRows: [
        {
          inventoryBagId: "inv-1",
          internalReceiptNumber: "352171",
          consumedQty: 40,
          tabletTypeId: "tt-1",
          tabletName: "MIT B",
          tabletZohoItemId: "tab-1",
          lumaPoId: "po-1",
          lumaPoLineId: "line-1",
          zohoPoId: "zoho-po",
          zohoLineItemId: "zoho-line",
        },
      ],
      warehouseId: "wh-1",
    });
    if (!built.ok) throw new Error("payload build failed");
    const bagId = built.payload.source_receipts[0]!.luma_inventory_bag_id;
    const servicePayload = buildProductionOutputServicePayloadFromLuma({
      ...built.payload,
      source_receipt_evidence: [
        {
          source_bag_id: bagId,
          internal_receipt_number: "352171",
          zoho_purchase_receive_id: "5254962000000000001",
          received_quantity: 1000,
          purchaseorder_id: built.payload.source_receipts[0]!.zoho_purchaseorder_id,
          purchaseorder_line_item_id:
            built.payload.source_receipts[0]!.zoho_purchaseorder_line_item_id,
          raw_item_id: built.payload.source_receipts[0]!.tablet_zoho_item_id,
          api_receive_status: "received",
          api_reconciliation_status: "received_by_luma",
          received_at: "2026-06-04T00:00:00.000Z",
          has_durable_row: true,
        },
      ],
    });
    const r = await callProductionOutputCommit({
      payload: servicePayload,
      idempotencyKey: "luma-production-output:lot-1",
      env: payloadEnv,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("guard");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
