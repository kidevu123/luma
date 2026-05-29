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
  const actual = await importOriginal<typeof import("@/lib/zoho/production-output-preview")>();
  return {
    ...actual,
    callProductionOutputPreview: vi.fn(),
  };
});

import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { callProductionOutputPreview } from "@/lib/zoho/production-output-preview";
import { previewZohoProductionOutputAction } from "./zoho-production-output-preview-actions";

const LOT_ID = "11111111-1111-4111-8111-111111111111";

const LOT_ROW = {
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

function mockLotQuery(row: typeof LOT_ROW | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const innerJoin = vi.fn(() => ({ leftJoin }));
  const from = vi.fn(() => ({ innerJoin }));
  vi.mocked(db.select).mockReturnValue({ from } as never);
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
      message: "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered.",
    });
    expect(callProductionOutputPreview).not.toHaveBeenCalled();
  });
});
