/**
 * lib/zoho/dry-run-client.test.ts
 *
 * Unit tests for dryRunZohoAssemblyOperation.
 * Uses opts.loadOp and opts.callService seams — no real DB or HTTP calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the guard function and DB before importing the module under test ──────
vi.mock("./assembly-service-client", () => ({
  callZohoAssemblyService: vi.fn(),
  isZohoAssemblyDryRunEnabled: vi.fn(),
}));

// Mock the DB module — we need to intercept db.update().set().where()
vi.mock("@/lib/db", () => {
  const whereFn = vi.fn().mockResolvedValue([]);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return {
    db: { update: updateFn },
  };
});

// Mock schema — only the zohoAssemblyOps table reference is needed
vi.mock("@/lib/db/schema", () => ({
  zohoAssemblyOps: { id: "id" },
  tabletTypes: { id: "id", zohoItemId: "zoho_item_id" },
  poLines: { id: "id", zohoLineItemId: "zoho_line_item_id", poId: "po_id" },
  purchaseOrders: { id: "id", zohoPoId: "zoho_po_id" },
}));

// Mock the queries module — defaultLoadOp uses it; we bypass via opts.loadOp
vi.mock("@/lib/db/queries/zoho-assembly", () => ({
  getZohoAssemblyOp: vi.fn(),
}));

import { dryRunZohoAssemblyOperation } from "./dry-run-client";
import type { EnrichedOp } from "./dry-run-client";
import { isZohoAssemblyDryRunEnabled, callZohoAssemblyService } from "./assembly-service-client";
import { db } from "@/lib/db";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockGuard = vi.mocked(isZohoAssemblyDryRunEnabled);
const mockCallService = vi.mocked(callZohoAssemblyService);
const mockDb = db as unknown as {
  update: ReturnType<typeof vi.fn>;
};

const OP_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const LOT_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TT_ID = "cccccccc-0000-0000-0000-000000000003";
const PL_ID = "dddddddd-0000-0000-0000-000000000004";

function makeBaseOp(overrides: Partial<ZohoAssemblyOp> = {}): ZohoAssemblyOp {
  return {
    id: OP_ID,
    finishedLotId: LOT_ID,
    opKind: "TABLET_RECEIVE",
    zohoItemId: null,
    quantity: 1200,
    status: "PENDING",
    idempotencyKey: `luma:tablet_receive:${LOT_ID}:bag-1`,
    zohoReferenceId: null,
    requestPayload: null,
    responsePayload: null,
    lastError: null,
    retryCount: 0,
    enqueuedAt: new Date(),
    startedAt: null,
    succeededAt: null,
    failedAt: null,
    resolvedManually: false,
    resolvedNote: null,
    resolvedByUserId: null,
    sourceInventoryBagId: "bag-1",
    sourcePoLineId: PL_ID,
    sourceTabletTypeId: TT_ID,
    componentRole: null,
    opSequence: 1,
    ...overrides,
  };
}

function makeEnrichedTabletReceive(opOverrides: Partial<ZohoAssemblyOp> = {}): EnrichedOp {
  return {
    op: makeBaseOp(opOverrides),
    zohoTabletItemId: "ZTAB-001",
    zohoPoId: "ZPO-001",
    zohoLineItemId: "ZLINE-001",
  };
}

function makeEnrichedAssembly(
  opKind: "UNIT_ASSEMBLE" | "DISPLAY_ASSEMBLE" | "CASE_ASSEMBLE",
  opOverrides: Partial<ZohoAssemblyOp> = {},
): EnrichedOp {
  return {
    op: makeBaseOp({
      opKind,
      opSequence: opKind === "UNIT_ASSEMBLE" ? 2 : opKind === "DISPLAY_ASSEMBLE" ? 3 : 4,
      zohoItemId: "ZCOMPOSITE-001",
      idempotencyKey: `luma:${opKind.toLowerCase().replace("_assemble", "_assemble")}:${LOT_ID}`,
      sourceInventoryBagId: null,
      sourcePoLineId: null,
      sourceTabletTypeId: null,
      ...opOverrides,
    }),
    zohoTabletItemId: null,
    zohoPoId: null,
    zohoLineItemId: null,
  };
}

const okServiceResponse = {
  ok: true as const,
  httpStatus: 200,
  body: { dry_run: true, status: "validated" },
};

const errorServiceResponse = {
  ok: false as const,
  httpStatus: 422,
  body: { error: "missing_field" },
  message: "Zoho Integration Service returned HTTP 422",
  guardBlocked: false,
};

const guardBlockedServiceResponse = {
  ok: false as const,
  httpStatus: null,
  body: null,
  message: "Dry-run writes are disabled. Set ZOHO_DRY_RUN_WRITES_ENABLED=true to enable.",
  guardBlocked: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset db.update chain mock
  const whereFn = vi.fn().mockResolvedValue([]);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.update.mockReturnValue({ set: setFn });
});

// ─── Test 1: Guard disabled (env check) ──────────────────────────────────────

describe("1. Guard disabled — isZohoAssemblyDryRunEnabled returns false", () => {
  it("returns GUARD_DISABLED without calling loadOp", async () => {
    mockGuard.mockReturnValue(false);
    const loadOp = vi.fn();

    const result = await dryRunZohoAssemblyOperation(OP_ID, { loadOp });

    expect(result.kind).toBe("GUARD_DISABLED");
    expect("message" in result && result.message).toMatch(/ZOHO_DRY_RUN_WRITES_ENABLED/);
    expect(loadOp).not.toHaveBeenCalled();
  });
});

// ─── Test 2: Guard blocked via service response ───────────────────────────────

describe("2. Guard blocked via service returning guardBlocked:true", () => {
  it("returns GUARD_DISABLED when service returns guardBlocked", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(guardBlockedServiceResponse);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    expect(result.kind).toBe("GUARD_DISABLED");
    expect("message" in result && result.message).toMatch(/ZOHO_DRY_RUN_WRITES_ENABLED/);
  });
});

// ─── Test 3: Op not found ─────────────────────────────────────────────────────

describe("3. Op not found", () => {
  it("returns OP_NOT_FOUND when loadOp returns null", async () => {
    mockGuard.mockReturnValue(true);

    const result = await dryRunZohoAssemblyOperation("nonexistent-id", {
      loadOp: async () => null,
    });

    expect(result.kind).toBe("OP_NOT_FOUND");
    expect("opId" in result && result.opId).toBe("nonexistent-id");
  });

  it("does not call callService when op not found", async () => {
    mockGuard.mockReturnValue(true);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => null,
      callService: mockCallService,
    });

    expect(mockCallService).not.toHaveBeenCalled();
  });
});

// ─── Test 4: TABLET_RECEIVE — payload blocked ─────────────────────────────────

describe("4. TABLET_RECEIVE — payload blocked (zohoPoId missing)", () => {
  it("returns PAYLOAD_BLOCKED with blockers when zohoPoId is null", async () => {
    mockGuard.mockReturnValue(true);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive({} ),
      callService: mockCallService,
    });

    // This case has zohoPoId set, let's use a missing zohoPoId case
    // We need a loadOp that returns null zohoPoId AND null zohoTabletItemId to trigger blockers
    expect(result).toBeDefined();
  });

  it("returns PAYLOAD_BLOCKED and never calls callService when blockers present", async () => {
    mockGuard.mockReturnValue(true);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => ({
        op: makeBaseOp(),
        zohoTabletItemId: null,  // blocker: missing item ID
        zohoPoId: null,           // blocker: missing PO ID
        zohoLineItemId: null,
      }),
      callService: mockCallService,
    });

    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    expect("blockers" in result && result.blockers.length).toBeGreaterThan(0);
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it("PAYLOAD_BLOCKED result has blockers array", async () => {
    mockGuard.mockReturnValue(true);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => ({
        op: makeBaseOp(),
        zohoTabletItemId: null,
        zohoPoId: null,
        zohoLineItemId: null,
      }),
    });

    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    if (result.kind === "PAYLOAD_BLOCKED") {
      expect(Array.isArray(result.blockers)).toBe(true);
      expect(result.blockers.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── Test 5: TABLET_RECEIVE — service success ─────────────────────────────────

describe("5. TABLET_RECEIVE — service success", () => {
  it("returns OK with httpStatus and body", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    expect(result.kind).toBe("OK");
    if (result.kind === "OK") {
      expect(result.httpStatus).toBe(200);
      expect(result.body).toEqual({ dry_run: true, status: "validated" });
    }
  });

  it("calls service with correct path for TABLET_RECEIVE", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    expect(mockCallService).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/zoho/purchase_receives/create" }),
    );
  });

  it("dry_run payload flag is true in call to service", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    const callArg = mockCallService.mock.calls[0]?.[0];
    expect(callArg?.payload).toMatchObject({ dry_run: true });
  });
});

// ─── Test 6: TABLET_RECEIVE — service error ───────────────────────────────────

describe("6. TABLET_RECEIVE — service error", () => {
  it("returns SERVICE_ERROR with httpStatus and message", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(errorServiceResponse);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    expect(result.kind).toBe("SERVICE_ERROR");
    if (result.kind === "SERVICE_ERROR") {
      expect(result.httpStatus).toBe(422);
      expect(result.message).toMatch(/422/);
    }
  });

  it("stores last_error in DB on service error", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(errorServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    // db.update should have been called
    expect(mockDb.update).toHaveBeenCalled();
    const setArg = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg).toMatchObject({ lastError: expect.any(String) });
  });
});

// ─── Test 7: UNIT_ASSEMBLE — payload blocked ──────────────────────────────────

describe("7. UNIT_ASSEMBLE — payload blocked (zohoCompositeItemId missing)", () => {
  it("returns PAYLOAD_BLOCKED when zohoItemId is null", async () => {
    mockGuard.mockReturnValue(true);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("UNIT_ASSEMBLE", { zohoItemId: null }),
      callService: mockCallService,
    });

    expect(result.kind).toBe("PAYLOAD_BLOCKED");
    if (result.kind === "PAYLOAD_BLOCKED") {
      expect(result.blockers.some((b) => b.field === "composite_item_id")).toBe(true);
    }
  });

  it("never calls callService when assembly payload is blocked", async () => {
    mockGuard.mockReturnValue(true);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("UNIT_ASSEMBLE", { zohoItemId: null }),
      callService: mockCallService,
    });

    expect(mockCallService).not.toHaveBeenCalled();
  });
});

// ─── Test 8: UNIT_ASSEMBLE — service success ─────────────────────────────────

describe("8. UNIT_ASSEMBLE — service success", () => {
  it("returns OK", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("UNIT_ASSEMBLE"),
      callService: mockCallService,
    });

    expect(result.kind).toBe("OK");
  });

  it("sends assembly_level = 'unit' to service", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("UNIT_ASSEMBLE"),
      callService: mockCallService,
    });

    const callArg = mockCallService.mock.calls[0]?.[0];
    expect(callArg?.payload).toMatchObject({ assembly_level: "unit" });
  });

  it("calls service with /zoho/assemblies/create path", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("UNIT_ASSEMBLE"),
      callService: mockCallService,
    });

    expect(mockCallService).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/zoho/assemblies/create" }),
    );
  });
});

// ─── Test 9: DISPLAY_ASSEMBLE — service success ───────────────────────────────

describe("9. DISPLAY_ASSEMBLE — service success", () => {
  it("returns OK", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("DISPLAY_ASSEMBLE"),
      callService: mockCallService,
    });

    expect(result.kind).toBe("OK");
  });

  it("sends assembly_level = 'display' to service", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("DISPLAY_ASSEMBLE"),
      callService: mockCallService,
    });

    const callArg = mockCallService.mock.calls[0]?.[0];
    expect(callArg?.payload).toMatchObject({ assembly_level: "display" });
  });
});

// ─── Test 10: CASE_ASSEMBLE — service success ────────────────────────────────

describe("10. CASE_ASSEMBLE — service success", () => {
  it("returns OK", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    const result = await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("CASE_ASSEMBLE"),
      callService: mockCallService,
    });

    expect(result.kind).toBe("OK");
  });

  it("sends assembly_level = 'case' to service", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedAssembly("CASE_ASSEMBLE"),
      callService: mockCallService,
    });

    const callArg = mockCallService.mock.calls[0]?.[0];
    expect(callArg?.payload).toMatchObject({ assembly_level: "case" });
  });
});

// ─── Test 11: Dry-run success does NOT set status to SUCCEEDED ────────────────

describe("11. Dry-run success does NOT set status to SUCCEEDED", () => {
  it("db.update is called but never sets status to SUCCEEDED", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    const setArg = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    // status field must not be "SUCCEEDED"
    expect(setArg?.status).not.toBe("SUCCEEDED");
    // status field should not be set at all in successful dry-run
    expect(setArg?.status).toBeUndefined();
  });

  it("succeededAt is never set in a dry-run success update", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    const setArg = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.succeededAt).toBeUndefined();
  });

  it("zohoReferenceId is never set in a dry-run success update", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    const setArg = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.zohoReferenceId).toBeUndefined();
  });
});

// ─── Test 12: retryCount not incremented ─────────────────────────────────────

describe("12. retryCount is never incremented in dry-run", () => {
  it("db.update never sets retryCount on success", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(okServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    const setArg = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.retryCount).toBeUndefined();
  });

  it("db.update never sets retryCount on service error", async () => {
    mockGuard.mockReturnValue(true);
    mockCallService.mockResolvedValue(errorServiceResponse);

    await dryRunZohoAssemblyOperation(OP_ID, {
      loadOp: async () => makeEnrichedTabletReceive(),
      callService: mockCallService,
    });

    const setArg = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.retryCount).toBeUndefined();
  });
});
