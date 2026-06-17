import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/lib/zoho/production-output-preview", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/zoho/production-output-preview")
    >();
  return {
    ...actual,
    callProductionOutputPreview: vi.fn(),
  };
});

vi.mock("@/lib/db/queries/zoho-production-output", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/db/queries/zoho-production-output")
    >();
  return {
    ...actual,
    getActiveZohoProductionOutputOpForLot: vi.fn(),
    upsertZohoProductionOutputPreviewOp: vi.fn(),
  };
});

// WAREHOUSE-CAPABILITY-v1.4.0 — mock the gateway capability call so
// tests can drive REQUIRED / OPTIONAL / UNKNOWN deterministically
// without hitting the gateway.
vi.mock("@/lib/zoho/brand-capabilities-client", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/zoho/brand-capabilities-client")
    >();
  return {
    ...actual,
    fetchWarehouseCapability: vi.fn(),
  };
});

// SNAPSHOT-ATTACH-v1.4.2 — mock the source-allocations builder and
// persistor so tests don't need a real allocation ledger.
vi.mock("@/lib/zoho/production-output-source-allocations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/zoho/production-output-source-allocations")
    >();
  return {
    ...actual,
    buildSourceAllocationsForFinishedLot: vi.fn(),
    persistSourceAllocationsForOp: vi.fn(),
  };
});

import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { upsertZohoProductionOutputPreviewOp, getActiveZohoProductionOutputOpForLot } from "@/lib/db/queries/zoho-production-output";
import { callProductionOutputPreview } from "@/lib/zoho/production-output-preview";
import { fetchWarehouseCapability } from "@/lib/zoho/brand-capabilities-client";
import {
  buildSourceAllocationsForFinishedLot,
  persistSourceAllocationsForOp,
} from "@/lib/zoho/production-output-source-allocations";
import { previewZohoProductionOutputAction } from "./zoho-production-output-preview-actions";

const LOT_ID = "11111111-1111-4111-8111-111111111111";

type LotRow = {
  finishedLot: {
    id: string;
    workflowBagId: string | null;
    producedOn: string;
    unitsProduced: number;
    displaysProduced: number;
    casesProduced: number;
  };
  product: {
    // SNAPSHOT-ATTACH-v1.4.2 — id/productSku/productName/productFamily
    // needed for the snapshot builder.
    id: string;
    productSku: string;
    productName: string;
    productFamily: string | null;
    zohoItemIdUnit: string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase: string | null;
    // WAREHOUSE-RESOLUTION-v1.3.0 — per-product override.
    zohoDefaultWarehouseId: string | null;
  };
  metrics: {
    damagedPackaging: number | null;
    rippedCards: number | null;
    looseCards: number | null;
  } | null;
  // SNAPSHOT-ATTACH-v1.4.2 — workflow-bag finalized_at for snapshot.
  workflowFinalizedAt: Date | null;
};

const LOT_ROW: LotRow = {
  finishedLot: {
    id: LOT_ID,
    workflowBagId: "22222222-2222-4222-8222-222222222222",
    producedOn: "2026-05-28",
    unitsProduced: 100,
    displaysProduced: 0,
    casesProduced: 0,
  },
  product: {
    id: "33333333-3333-4333-8333-333333333333",
    productSku: "tt-product-1",
    productName: "Test Product",
    productFamily: "HYROXI_MIT_A",
    zohoItemIdUnit: "unit-composite-1",
    zohoItemIdDisplay: null,
    zohoItemIdCase: null,
    zohoDefaultWarehouseId: null,
  },
  metrics: {
    damagedPackaging: 0,
    rippedCards: 0,
    looseCards: 0,
  },
  workflowFinalizedAt: new Date("2026-05-28T12:00:00Z"),
};

// SNAPSHOT-ATTACH-v1.4.2 — BlueRaz #36 fixture. Matches the real
// finished lot d353853e-3313-42e2-a0a1-c06b9e3dada4 shape:
// unit + display + case quantities all > 0 with all three composite
// item IDs populated. This is the shape that triggered the
// zoho_prod_output_ops_case_item_check failure in the consolidated
// path before the v1.4.2 fix. Used by BlueRaz-shaped tests below to
// pin that the v1.4.2 admin preview-action attaches a snapshot, omits
// warehouse_id under OPTIONAL capability, and persists snapshotSource
// + source allocations without tripping the check constraint.
const BLUERAZ_LOT_ROW: LotRow = {
  finishedLot: {
    id: LOT_ID,
    workflowBagId: "8f876446-7bd1-4aa8-af24-97df1bc2f424",
    producedOn: "2026-06-15",
    unitsProduced: 4021,
    displaysProduced: 21,
    casesProduced: 9,
  },
  product: {
    id: "44444444-4444-4444-8444-444444444444",
    productSku: "tt-product-30",
    productName: "Hyroxi Mit A - BlueRaz",
    productFamily: "HYROXI_MIT_A",
    zohoItemIdUnit: "5254962000002477016",
    zohoItemIdDisplay: "5254962000002477047",
    zohoItemIdCase: "5254962000002477064",
    zohoDefaultWarehouseId: null,
  },
  metrics: {
    damagedPackaging: 3,
    rippedCards: 5,
    looseCards: 1,
  },
  workflowFinalizedAt: new Date("2026-06-15T18:00:00Z"),
};

function mockLotQuery(
  row: LotRow | null,
  rawBagLinks: Array<{ confidence: string }> = [{ confidence: "HIGH" }],
  /** WAREHOUSE-RESOLUTION-v1.3.0 — preview-actions also reads
   *  zoho_credentials.warehouseId via loadAppSettingsWarehouseId(). */
  appSettingsWarehouseId: string | null = null,
) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn(() => ({ limit }));
  // SNAPSHOT-ATTACH-v1.4.2 — chain now has TWO leftJoins (readBagMetrics,
  // then workflowBags) before .where().limit().
  const leftJoinWorkflow = vi.fn(() => ({ where }));
  const leftJoin = vi.fn(() => ({ leftJoin: leftJoinWorkflow }));
  const innerJoin = vi.fn(() => ({ leftJoin }));
  const from = vi.fn(() => ({ innerJoin }));
  const rawWhere = vi.fn().mockResolvedValue(rawBagLinks);
  const rawFrom = vi.fn(() => ({ where: rawWhere }));
  const settingsLimit = vi
    .fn()
    .mockResolvedValue([{ warehouseId: appSettingsWarehouseId }]);
  const settingsFrom = vi.fn(() => ({ limit: settingsLimit }));
  vi.mocked(db.select)
    .mockReturnValueOnce({ from } as never)
    .mockReturnValueOnce({ from: rawFrom } as never)
    .mockReturnValueOnce({ from: settingsFrom } as never);
}

beforeEach(() => {
  // WAREHOUSE-CAPABILITY-v1.4.0 — use resetAllMocks (not clearAll)
  // so per-test mock implementations and queued mockResolvedValueOnce
  // values don't leak between tests. clearAllMocks only resets call
  // history; implementations from the previous test would carry over
  // and made v1.4 tests see stale capability states.
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({
    id: "admin-user",
    role: "ADMIN",
    email: "admin@example.com",
  } as Awaited<ReturnType<typeof requireAdmin>>);
  vi.stubEnv("ZOHO_SERVICE_BASE_URL", "http://192.168.1.205:8000");
  vi.stubEnv("ZOHO_SERVICE_BEARER_SECRET", "secret-prefix-rest");
  vi.stubEnv("ZOHO_BRAND", "haute_brands");
  vi.stubEnv("ZOHO_WAREHOUSE_ID", "");
  // The preview action gates on persist+preview being enabled together
  // (lib/zoho/production-output-config.ts). Without these the action
  // short-circuits with LOCAL_ERROR before reaching any of the
  // assertions in these tests, so we enable both for the suite.
  vi.stubEnv("ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED", "true");
  vi.stubEnv("ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED", "true");
  vi.mocked(getActiveZohoProductionOutputOpForLot).mockResolvedValue(null);
  vi.mocked(upsertZohoProductionOutputPreviewOp).mockResolvedValue({
    id: "op-1",
    status: "PREVIEWED",
    requestHash: "request-hash",
    approvedRequestHash: null,
    metricsState: "HIGH",
    genealogyState: "HIGH",
    previewedAt: new Date("2026-05-30T12:00:00Z"),
    previewHttpStatus: 200,
    hasPreviewResponse: true,
    approvedAt: null,
    approvalEligible: true,
    approvalBlockers: [],
    zohoPurchaseorderId: "po-1",
    zohoPurchaseorderLineItemId: "line-1",
    zohoWarehouseId: "warehouse-1",
    zohoCompositeItemId: "unit-composite-1",
    warehouseRequired: true,
    warehouseOmitted: false,
    capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
    capabilityGatewayRequestId: "test-request-id",
  });
  // Default capability for legacy tests: REQUIRED (matches v1.3
  // behavior where a warehouse must resolve or the action blocks).
  vi.mocked(fetchWarehouseCapability).mockResolvedValue({
    state: "REQUIRED",
    gatewayRequestId: "test-request-id",
  });
  // SNAPSHOT-ATTACH-v1.4.2 — default source-allocation mock returns a
  // single valid row so the snapshot builder succeeds. Individual
  // tests can override.
  vi.mocked(buildSourceAllocationsForFinishedLot).mockResolvedValue({
    ok: true,
    rows: [
      {
        zohoComponentItemId: "tablet-component-1",
        lumaInventoryBagId: "44444444-4444-4444-8444-444444444444",
        humanLotNumber: "LOT-A",
        componentRole: null,
        quantityAllocated: 100,
        allocationSessionId: null,
        workflowBagId: null,
        varietyRunId: null,
        parentScanToken: null,
        manufactureDate: null,
        expiryDate: null,
        zohoBatchId: null,
        batchResolutionStatus: "NOT_BATCH_TRACKED",
        outQuantity: null,
      },
    ],
    componentBatches: [],
    productFamily: "HYROXI_MIT_A",
  });
  vi.mocked(persistSourceAllocationsForOp).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("previewZohoProductionOutputAction", () => {
  it("returns a clear warehouse error before HTTP when ALL four resolution sources are empty", async () => {
    // WAREHOUSE-RESOLUTION-v1.3.0 — the v1.2 error string was
    // env-centric. The v1.3 resolver returns a single
    // operator-actionable message that names both safe fix
    // surfaces.
    mockLotQuery(LOT_ROW, undefined, null);

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    expect(result.blockers).toContainEqual({
      field: "warehouse_id",
      message:
        "No warehouse configured. Set one in Zoho settings or choose a warehouse on the preview form.",
    });
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
  });

  it("uses app-settings warehouse when env is empty and operator did not pick one", async () => {
    // WAREHOUSE-RESOLUTION-v1.3.0 — the #36 unblocker. With env
    // empty (production posture today) and no operator pick, the
    // resolver should fall through to zoho_credentials.warehouseId.
    mockLotQuery(LOT_ROW, undefined, "appsettings-wh-123");
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.warehouse_id).toBe("appsettings-wh-123");
  });

  it("product-level warehouse override beats app-settings default", async () => {
    const productLot: LotRow = {
      ...LOT_ROW,
      product: {
        ...LOT_ROW.product,
        zohoDefaultWarehouseId: "product-wh-999",
      },
    };
    mockLotQuery(productLot, undefined, "appsettings-wh-123");
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.warehouse_id).toBe("product-wh-999");
  });

  it("operator form value beats both product override and app-settings default", async () => {
    const productLot: LotRow = {
      ...LOT_ROW,
      product: {
        ...LOT_ROW.product,
        zohoDefaultWarehouseId: "product-wh-999",
      },
    };
    mockLotQuery(productLot, undefined, "appsettings-wh-123");
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "operator-typed-wh-7",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.warehouse_id).toBe("operator-typed-wh-7");
  });

  it("persists a PREVIEWED operation row after a successful preview", async () => {
    mockLotQuery(LOT_ROW);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(result.ok).toBe(true);
    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        finishedLotId: LOT_ID,
        workflowBagId: LOT_ROW.finishedLot.workflowBagId,
        status: "PREVIEWED",
        previewHttpStatus: 200,
        previewResponse: { preview: true },
        metricsState: "HIGH",
        genealogyState: "HIGH",
        userId: "admin-user",
      }),
    );
    if (!result.ok) return;
    expect(result.persistedPreview.status).toBe("PREVIEWED");
  });

  it("stores service validation responses as DRAFT, not PREVIEWED", async () => {
    mockLotQuery(LOT_ROW);
    vi.mocked(upsertZohoProductionOutputPreviewOp).mockResolvedValueOnce({
      id: "op-1",
      status: "DRAFT",
      requestHash: "request-hash",
      approvedRequestHash: null,
      metricsState: "HIGH",
      genealogyState: "HIGH",
      previewedAt: null,
      previewHttpStatus: 422,
      hasPreviewResponse: true,
      approvedAt: null,
      approvalEligible: false,
      approvalBlockers: ["Run a successful Zoho preview before approval."],
      zohoPurchaseorderId: "po-1",
      zohoPurchaseorderLineItemId: "line-1",
      zohoWarehouseId: "warehouse-1",
      zohoCompositeItemId: "unit-composite-1",
      warehouseRequired: true,
      warehouseOmitted: false,
      capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
      capabilityGatewayRequestId: "test-request-id",
    });
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: false,
      httpStatus: 422,
      body: { code: "INSUFFICIENT_PO_REMAINING" },
      message: "validation",
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(result.ok).toBe(false);
    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "DRAFT",
        previewHttpStatus: 422,
        previewResponse: { code: "INSUFFICIENT_PO_REMAINING" },
      }),
    );
    if (result.ok) return;
    expect(result.persistedPreview?.status).toBe("DRAFT");
  });

  it("persists missing metrics and missing genealogy honestly", async () => {
    // SNAPSHOT-ATTACH-v1.4.2 — snapshot builder requires a non-null
    // workflowBagId. Keep the original v1.4.0 test but with a valid
    // workflowBagId so we still exercise the missing-metrics path.
    mockLotQuery(
      {
        ...LOT_ROW,
        metrics: null,
      },
      [],
    );
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        metricsState: "MISSING",
        // SNAPSHOT-ATTACH-v1.4.2 — workflowBagId stays valid (snapshot
        // requires it) so genealogy is LOW (no high-conf links) rather
        // than the v1.4.0 case's "MISSING" (no workflowBagId).
        genealogyState: "LOW",
      }),
    );
  });

  // SNAPSHOT-ATTACH-v1.4.2 — new tests for the v1.4.2 contract.

  it("attaches luma_operation_snapshot + verification.mode=snapshot to the payload (so gateway does not emit script-only blockers)", async () => {
    mockLotQuery(LOT_ROW);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Snapshot is attached with the documented shape.
    const payloadAny = result.payload as Record<string, unknown>;
    expect(Object.hasOwn(payloadAny, "luma_operation_snapshot")).toBe(true);
    expect(Object.hasOwn(payloadAny, "verification")).toBe(true);
    expect(payloadAny.verification).toEqual({ mode: "snapshot" });
    const snapshot = payloadAny.luma_operation_snapshot as Record<string, unknown>;
    expect(snapshot.status).toBe("finalized");
    expect(snapshot.finished_lot_id).toBe(LOT_ID);
    expect(snapshot.workflow_bag_id).toBe(LOT_ROW.finishedLot.workflowBagId);
    expect(Array.isArray(snapshot.source_allocations)).toBe(true);
    expect((snapshot.source_allocations as unknown[]).length).toBeGreaterThan(0);
  });

  it("persists source allocations via persistSourceAllocationsForOp after the upsert", async () => {
    mockLotQuery(LOT_ROW);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(persistSourceAllocationsForOp).toHaveBeenCalledWith(
      "op-1",
      expect.arrayContaining([
        expect.objectContaining({ lumaInventoryBagId: expect.any(String) }),
      ]),
    );
  });

  it("upsert receives snapshotSource (finalizedAt + productId + productFamily + finishedSku)", async () => {
    mockLotQuery(LOT_ROW);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotSource: expect.objectContaining({
          productId: LOT_ROW.product.id,
          productFamily: expect.any(String),
          finishedSku: LOT_ROW.product.productSku,
          finalizedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("returns PAYLOAD_BLOCKED when source allocations cannot be built (no allocation ledger)", async () => {
    mockLotQuery(LOT_ROW);
    vi.mocked(buildSourceAllocationsForFinishedLot).mockResolvedValueOnce({
      ok: false,
      blockers: [
        {
          code: "MISSING_ALLOCATION_LEDGER",
          message: "No closed allocation sessions exist for this finished lot.",
        },
      ],
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ field: "MISSING_ALLOCATION_LEDGER" }),
    );
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
  });

  it("v1.4.0 warehouse omission preserved: OPTIONAL + missing -> payload still omits warehouse_id + snapshot still attached", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-omit-1",
    });
    mockLotQuery(LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payloadAny = result.payload as Record<string, unknown>;
    // v1.4.0 contract intact:
    expect(Object.hasOwn(payloadAny, "warehouse_id")).toBe(false);
    // v1.4.2 contract present:
    expect(Object.hasOwn(payloadAny, "luma_operation_snapshot")).toBe(true);
    expect(payloadAny.verification).toEqual({ mode: "snapshot" });
  });

  // SNAPSHOT-ATTACH-v1.4.2 — BlueRaz #36 unit + display + case path.
  // The shape that triggered zoho_prod_output_ops_case_item_check
  // before this patch. Must build cleanly and persist without
  // tripping the check constraint.

  it("BlueRaz #36 shape (unit + display + case) builds payload with all three composite IDs, attaches snapshot, omits warehouse_id under OPTIONAL capability", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-blueraz-1",
    });
    mockLotQuery(BLUERAZ_LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "5254962000004878112",
      purchaseorderLineItemId: "5254962000004878118",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;

    // All three assembly quantities > 0.
    expect(payload.unit_assembly_quantity).toBe(4021);
    expect(payload.display_assembly_quantity).toBe(21);
    expect(payload.case_assembly_quantity).toBe(9);

    // All three composite item IDs present in the payload.
    expect(payload.unit_composite_item_id).toBe("5254962000002477016");
    expect(payload.display_composite_item_id).toBe("5254962000002477047");
    expect(payload.case_composite_item_id).toBe("5254962000002477064");

    // Warehouse capability OPTIONAL + no resolution → warehouse_id key
    // absent from JSON entirely (not empty string, not null).
    expect(Object.hasOwn(payload, "warehouse_id")).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(/"warehouse_id"/);

    // Snapshot + verification mode attached.
    expect(Object.hasOwn(payload, "luma_operation_snapshot")).toBe(true);
    expect(payload.verification).toEqual({ mode: "snapshot" });

    // Snapshot carries the BlueRaz identity (lot, workflow bag, SKU).
    const snapshot = payload.luma_operation_snapshot as Record<string, unknown>;
    expect(snapshot.status).toBe("finalized");
    expect(snapshot.finished_lot_id).toBe(LOT_ID);
    expect(snapshot.workflow_bag_id).toBe(BLUERAZ_LOT_ROW.finishedLot.workflowBagId);
    expect(snapshot.finished_sku).toBe(BLUERAZ_LOT_ROW.product.productSku);
    expect(snapshot.unit_composite_item_id).toBe("5254962000002477016");
    expect(Array.isArray(snapshot.source_allocations)).toBe(true);
    expect((snapshot.source_allocations as unknown[]).length).toBeGreaterThan(0);
  });

  it("BlueRaz #36 shape: upsert receives all four v1.4.0 capability audit fields + v1.4.2 snapshotSource", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-blueraz-2",
    });
    mockLotQuery(BLUERAZ_LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "5254962000004878112",
      purchaseorderLineItemId: "5254962000004878118",
      warehouseId: "",
      notes: "",
    });

    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        // The persisted PREVIEWED payload still carries all three
        // composite item IDs. The upsert reads them off the payload
        // (input.payload.unit_composite_item_id etc.) which is what
        // populates the zoho_*_composite_item_id columns and lets the
        // table's three check constraints all pass.
        payload: expect.objectContaining({
          unit_composite_item_id: "5254962000002477016",
          display_composite_item_id: "5254962000002477047",
          case_composite_item_id: "5254962000002477064",
          unit_assembly_quantity: 4021,
          display_assembly_quantity: 21,
          case_assembly_quantity: 9,
        }),
        // v1.4.0 capability audit fields.
        warehouseAudit: expect.objectContaining({
          warehouseRequired: false,
          warehouseOmitted: true,
          capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
          capabilityGatewayRequestId: "wh-cap-blueraz-2",
        }),
        // v1.4.2 snapshotSource columns persisted on the op row so
        // the gateway snapshot-verification callback can reconstruct
        // the snapshot on subsequent reads.
        snapshotSource: expect.objectContaining({
          productId: BLUERAZ_LOT_ROW.product.id,
          productFamily: expect.any(String),
          finishedSku: BLUERAZ_LOT_ROW.product.productSku,
          finalizedAt: expect.any(Date),
        }),
      }),
    );
    // Source allocations persisted after the upsert so the commit
    // path can reload + verify the snapshot.
    expect(persistSourceAllocationsForOp).toHaveBeenCalled();
  });

  it("BlueRaz #36 shape: case_assembly_quantity > 0 AND case_composite_item_id present together (no zoho_prod_output_ops_case_item_check failure path)", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-blueraz-3",
    });
    mockLotQuery(BLUERAZ_LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "5254962000004878112",
      purchaseorderLineItemId: "5254962000004878118",
      warehouseId: "",
      notes: "",
    });

    // The check constraint is:
    //   case_assembly_quantity = 0 OR zoho_case_composite_item_id IS NOT NULL
    // The upsert reads case_composite_item_id off the payload (see
    // buildZohoProductionOutputPreviewOpValues:140). So if the payload
    // carries case_assembly_quantity > 0, it MUST also carry a
    // non-empty case_composite_item_id. Assert exactly that on every
    // upsert call.
    const calls = vi.mocked(upsertZohoProductionOutputPreviewOp).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      const p = arg.payload as Record<string, unknown>;
      const caseQty = Number(p.case_assembly_quantity ?? 0);
      const caseComposite = p.case_composite_item_id;
      const displayQty = Number(p.display_assembly_quantity ?? 0);
      const displayComposite = p.display_composite_item_id;
      const unitQty = Number(p.unit_assembly_quantity ?? 0);
      const unitComposite = p.unit_composite_item_id;
      if (caseQty > 0) {
        expect(typeof caseComposite).toBe("string");
        expect((caseComposite as string).length).toBeGreaterThan(0);
      }
      if (displayQty > 0) {
        expect(typeof displayComposite).toBe("string");
        expect((displayComposite as string).length).toBeGreaterThan(0);
      }
      if (unitQty > 0) {
        expect(typeof unitComposite).toBe("string");
        expect((unitComposite as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("blocks preview when an approved op is still active", async () => {
    vi.mocked(getActiveZohoProductionOutputOpForLot).mockResolvedValueOnce({
      id: "op-approved",
      status: "APPROVED",
      requestHash: "hash",
      approvedRequestHash: "hash",
      metricsState: "HIGH",
      genealogyState: "HIGH",
      previewedAt: new Date(),
      previewHttpStatus: 200,
      hasPreviewResponse: true,
      approvedAt: new Date(),
      approvalEligible: false,
      approvalBlockers: [],
      zohoPurchaseorderId: "po-1",
      zohoPurchaseorderLineItemId: "line-1",
      zohoWarehouseId: "warehouse-1",
      zohoCompositeItemId: "unit-composite-1",
      warehouseRequired: true,
      warehouseOmitted: false,
      capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
      capabilityGatewayRequestId: "test-request-id",
    });
    mockLotQuery(LOT_ROW);

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "warehouse-1",
      notes: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Void it");
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
  });

  // WAREHOUSE-CAPABILITY-v1.4.0 — decision matrix tests.

  it("OPTIONAL + missing -> omits warehouse_id and proceeds", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-1",
    });
    mockLotQuery(LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole point: payload omits the warehouse_id KEY entirely.
    // Not present, not empty string, not null.
    expect(Object.hasOwn(result.payload, "warehouse_id")).toBe(false);
    expect((result.payload as Record<string, unknown>).warehouse_id).toBe(
      undefined,
    );
    expect(callProductionOutputPreview).toHaveBeenCalled();
  });

  it("OPTIONAL + resolved -> uses the resolved warehouseId", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-2",
    });
    mockLotQuery(LOT_ROW, undefined, "appsettings-wh-9");
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.warehouse_id).toBe("appsettings-wh-9");
  });

  it("UNKNOWN + missing -> blocks with the canonical UNKNOWN message", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "UNKNOWN",
      reason: "gateway returned HTTP 500",
    });
    mockLotQuery(LOT_ROW, undefined, null);

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    expect(result.message).toBe(
      "Cannot confirm whether this Zoho org uses warehouses. Resolve gateway warehouse capability before previewing.",
    );
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
  });

  it("UNKNOWN + supplied warehouse -> STILL blocks with the UNKNOWN message", async () => {
    // Critical pin: UNKNOWN dominates even when an operator has
    // typed a warehouse on the form. Fail closed.
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "UNKNOWN",
      reason: "gateway unreachable",
    });
    mockLotQuery(LOT_ROW, undefined, "appsettings-wh-9");

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "operator-typed-wh-1",
      notes: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    expect(result.message).toContain("Cannot confirm");
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
  });

  it("REQUIRED + missing -> blocks with the v1.3 canonical message (unchanged)", async () => {
    // Default REQUIRED capability is set in beforeEach; this is the
    // legacy v1.3 path that still must hold under v1.4.
    mockLotQuery(LOT_ROW, undefined, null);

    const result = await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    expect(result.message).toBe(
      "No warehouse configured. Set one in Zoho settings or choose a warehouse on the preview form.",
    );
  });

  it("OPTIONAL + missing -> persists audit row with warehouseOmitted=true and gateway request id", async () => {
    vi.mocked(fetchWarehouseCapability).mockResolvedValueOnce({
      state: "OPTIONAL",
      gatewayRequestId: "wh-cap-AUDIT",
    });
    mockLotQuery(LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "",
      notes: "",
    });

    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouseAudit: {
          warehouseRequired: false,
          warehouseOmitted: true,
          capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
          capabilityGatewayRequestId: "wh-cap-AUDIT",
        },
      }),
    );
  });

  it("REQUIRED + resolved -> audit row has warehouseRequired=true, warehouseOmitted=false", async () => {
    mockLotQuery(LOT_ROW, undefined, null);
    vi.mocked(callProductionOutputPreview).mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: { preview: true },
      idempotencyReplay: false,
    });

    await previewZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      purchaseorderId: "po-1",
      purchaseorderLineItemId: "line-1",
      warehouseId: "operator-typed-wh-1",
      notes: "",
    });

    expect(upsertZohoProductionOutputPreviewOp).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouseAudit: expect.objectContaining({
          warehouseRequired: true,
          warehouseOmitted: false,
          capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
          capabilityGatewayRequestId: "test-request-id",
        }),
      }),
    );
  });
});
