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

import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { upsertZohoProductionOutputPreviewOp, getActiveZohoProductionOutputOpForLot } from "@/lib/db/queries/zoho-production-output";
import { callProductionOutputPreview } from "@/lib/zoho/production-output-preview";
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
    zohoItemIdUnit: string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase: string | null;
  };
  metrics: {
    damagedPackaging: number | null;
    rippedCards: number | null;
    looseCards: number | null;
  } | null;
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
    zohoItemIdUnit: "unit-composite-1",
    zohoItemIdDisplay: null,
    zohoItemIdCase: null,
  },
  metrics: {
    damagedPackaging: 0,
    rippedCards: 0,
    looseCards: 0,
  },
};

function mockLotQuery(
  row: LotRow | null,
  rawBagLinks = [{ confidence: "HIGH" }],
) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const innerJoin = vi.fn(() => ({ leftJoin }));
  const from = vi.fn(() => ({ innerJoin }));
  const rawWhere = vi.fn().mockResolvedValue(rawBagLinks);
  const rawFrom = vi.fn(() => ({ where: rawWhere }));
  vi.mocked(db.select)
    .mockReturnValueOnce({ from } as never)
    .mockReturnValueOnce({ from: rawFrom } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({
    id: "admin-user",
    role: "ADMIN",
    email: "admin@example.com",
  } as Awaited<ReturnType<typeof requireAdmin>>);
  vi.stubEnv("ZOHO_SERVICE_BASE_URL", "http://192.168.1.205:8000");
  vi.stubEnv("ZOHO_SERVICE_BEARER_SECRET", "secret-prefix-rest");
  vi.stubEnv("ZOHO_BRAND", "haute_brands");
  vi.stubEnv("ZOHO_WAREHOUSE_ID", "");
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
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("previewZohoProductionOutputAction", () => {
  it("returns a clear warehouse error before HTTP when env and form value are blank", async () => {
    mockLotQuery(LOT_ROW);

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
        "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered.",
    });
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
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
    mockLotQuery(
      {
        ...LOT_ROW,
        finishedLot: {
          ...LOT_ROW.finishedLot,
          workflowBagId: null,
        },
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
        genealogyState: "MISSING",
      }),
    );
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
});
