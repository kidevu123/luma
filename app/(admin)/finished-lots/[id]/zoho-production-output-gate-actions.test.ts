import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db/queries/zoho-production-output", () => ({
  approveZohoProductionOutputOp: vi.fn(),
  queueZohoProductionOutputOpForFutureCommit: vi.fn(),
  voidZohoProductionOutputOp: vi.fn(),
}));

import { requireAdmin } from "@/lib/auth-guards";
import { revalidatePath } from "next/cache";
import {
  approveZohoProductionOutputOp,
  queueZohoProductionOutputOpForFutureCommit,
  voidZohoProductionOutputOp,
} from "@/lib/db/queries/zoho-production-output";
import {
  approveZohoProductionOutputAction,
  queueZohoProductionOutputAction,
  voidZohoProductionOutputAction,
} from "./zoho-production-output-gate-actions";

const LOT_ID = "11111111-1111-4111-8111-111111111111";
const OP_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({
    id: "admin-user",
    role: "ADMIN",
    email: "admin@example.com",
  } as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("approveZohoProductionOutputAction", () => {
  it("approves a PREVIEWED op and revalidates the lot page", async () => {
    vi.mocked(approveZohoProductionOutputOp).mockResolvedValue({
      ok: true,
      metadata: {
        id: OP_ID,
        status: "APPROVED",
        requestHash: "hash-a",
        approvedRequestHash: "hash-a",
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
        zohoWarehouseId: "wh-1",
        zohoCompositeItemId: "item-1",
        warehouseRequired: true,
        warehouseOmitted: false,
        capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
        capabilityGatewayRequestId: "test-request-id",
      },
    });

    const result = await approveZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      opId: OP_ID,
    });

    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith(`/finished-lots/${LOT_ID}`);
    expect(approveZohoProductionOutputOp).toHaveBeenCalledWith(
      OP_ID,
      expect.objectContaining({ id: "admin-user" }),
    );
  });

  it("returns query-layer errors without calling Zoho", async () => {
    vi.mocked(approveZohoProductionOutputOp).mockResolvedValue({
      ok: false,
      error: "Metrics state is MISSING — approval is blocked.",
    });

    const result = await approveZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      opId: OP_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("MISSING");
  });
});

describe("queueZohoProductionOutputAction", () => {
  it("queues a ready APPROVED op and revalidates without calling Zoho", async () => {
    vi.mocked(queueZohoProductionOutputOpForFutureCommit).mockResolvedValue({
      ok: true,
      metadata: {
        id: OP_ID,
        status: "QUEUED",
        requestHash: "hash-a",
        approvedRequestHash: "hash-a",
        metricsState: "HIGH",
        genealogyState: "HIGH",
        previewedAt: new Date(),
        previewHttpStatus: 200,
        hasPreviewResponse: true,
        approvedAt: new Date(),
        approvalEligible: false,
        approvalBlockers: [],
        commitRequestedAt: new Date(),
        commitIdempotencyKey: "luma-production-output:op:hash-a",
        zohoPurchaseorderId: "po-1",
        zohoPurchaseorderLineItemId: "line-1",
        zohoWarehouseId: "wh-1",
        zohoCompositeItemId: "item-1",
        warehouseRequired: true,
        warehouseOmitted: false,
        capabilitySource: "gateway:/zoho/brand-capabilities/warehouse",
        capabilityGatewayRequestId: "test-request-id",
      },
      queueEligibility: {
        eligible: true,
        blockers: [],
        commitIdempotencyKey: "luma-production-output:op:hash-a",
      },
    });

    const result = await queueZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      opId: OP_ID,
    });

    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith(`/finished-lots/${LOT_ID}`);
    expect(queueZohoProductionOutputOpForFutureCommit).toHaveBeenCalledWith(
      OP_ID,
      expect.objectContaining({ id: "admin-user" }),
    );
  });

  it("returns query-layer errors without calling Zoho", async () => {
    vi.mocked(queueZohoProductionOutputOpForFutureCommit).mockResolvedValue({
      ok: false,
      error: "Already queued for future commit.",
    });

    const result = await queueZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      opId: OP_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Already queued");
  });
});

describe("voidZohoProductionOutputAction", () => {
  it("requires a void reason", async () => {
    const result = await voidZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      opId: OP_ID,
      reason: "   ",
    });

    expect(result.ok).toBe(false);
    expect(voidZohoProductionOutputOp).not.toHaveBeenCalled();
  });

  it("voids with reason and revalidates", async () => {
    vi.mocked(voidZohoProductionOutputOp).mockResolvedValue({ ok: true });

    const result = await voidZohoProductionOutputAction({
      finishedLotId: LOT_ID,
      opId: OP_ID,
      reason: "Wrong PO line",
    });

    expect(result.ok).toBe(true);
    expect(voidZohoProductionOutputOp).toHaveBeenCalledWith(
      OP_ID,
      "Wrong PO line",
      expect.objectContaining({ id: "admin-user" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/finished-lots/${LOT_ID}`);
  });
});
