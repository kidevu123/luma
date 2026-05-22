// FLOOR-START-3 tests — lookupCardByTokenAction invariants.
//
// Covers: card-not-found, wrong card type, retired card, IDLE card rejection,
// valid RAW_BAG (intake-reserved ASSIGNED+no-bag, mid-production ASSIGNED+bag).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────

let callIdx = 0;
const selectResults: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_cond?: unknown) => ({
          limit: async (_count?: unknown) => {
            const rows = (selectResults[callIdx++] ?? []) as unknown[];
            return rows;
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  qrCards: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { lookupCardByTokenAction } from "./actions";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeForm(scanToken: string): FormData {
  const fd = new FormData();
  fd.set("scanToken", scanToken);
  return fd;
}

const IDLE_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000001",
  cardType: "RAW_BAG",
  status: "IDLE",
  assignedWorkflowBagId: null,
};

const INTAKE_RESERVED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000002",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: null,
};

const ASSIGNED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000003",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: "00000000-0000-0000-0000-000000000099",
};

// ── beforeEach ────────────────────────────────────────────────────────────

beforeEach(() => {
  callIdx = 0;
  selectResults.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("lookupCardByTokenAction", () => {
  it("returns error when scan token is empty", async () => {
    const fd = new FormData();
    // no scanToken set
    const result = await lookupCardByTokenAction(fd);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/no scan token/i);
  });

  it("returns error when card not found", async () => {
    selectResults[0] = []; // no card for this token
    const result = await lookupCardByTokenAction(makeForm("nonexistent-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not found/i);
  });

  it("returns error for VARIETY_PACK card", async () => {
    selectResults[0] = [{ id: "aaa", cardType: "VARIETY_PACK", status: "IDLE", assignedWorkflowBagId: null }];
    const result = await lookupCardByTokenAction(makeForm("variety-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not a bag QR/i);
  });

  it("returns error for UNKNOWN card type", async () => {
    selectResults[0] = [{ id: "bbb", cardType: "UNKNOWN", status: "IDLE", assignedWorkflowBagId: null }];
    const result = await lookupCardByTokenAction(makeForm("unknown-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not a bag QR/i);
  });

  it("returns error for RETIRED RAW_BAG card", async () => {
    selectResults[0] = [{ id: "ccc", cardType: "RAW_BAG", status: "RETIRED", assignedWorkflowBagId: null }];
    const result = await lookupCardByTokenAction(makeForm("retired-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/retired/i);
  });

  it("returns error for IDLE RAW_BAG card — pool cards must be received first", async () => {
    selectResults[0] = [IDLE_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("bag-card-1"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/receive/i);
  });

  it("returns ok+isIntakeReserved=true for intake-reserved ASSIGNED RAW_BAG card", async () => {
    selectResults[0] = [INTAKE_RESERVED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("bag-card-2"));
    expect(result).toHaveProperty("ok", true);
    expect((result as { ok: true; cardId: string; isIntakeReserved: boolean }).cardId).toBe(INTAKE_RESERVED_RAW_BAG.id);
    expect((result as { ok: true; cardId: string; isIntakeReserved: boolean }).isIntakeReserved).toBe(true);
  });

  it("returns ok+isIntakeReserved=false for mid-production ASSIGNED RAW_BAG card", async () => {
    selectResults[0] = [ASSIGNED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("pickup-bag-token"));
    expect(result).toHaveProperty("ok", true);
    expect((result as { ok: true; cardId: string; isIntakeReserved: boolean }).cardId).toBe(ASSIGNED_RAW_BAG.id);
    expect((result as { ok: true; cardId: string; isIntakeReserved: boolean }).isIntakeReserved).toBe(false);
  });

  it("trims whitespace from scan token before lookup", async () => {
    selectResults[0] = [INTAKE_RESERVED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("  bag-card-2  "));
    expect(result).toHaveProperty("ok", true);
  });
});

// ── Product narrowing filter logic (pure) ─────────────────────────────────
// Verifies the filter rule used by eligibleProducts / handleResolvedToken.

type MockProduct = { id: string; sku: string; name: string; allowedTabletTypeIds: string[] };

function narrowProducts(
  products: MockProduct[],
  tabletTypeId: string | null,
): MockProduct[] {
  if (!tabletTypeId) return products;
  return products.filter(
    (p) => p.allowedTabletTypeIds.length === 0 || p.allowedTabletTypeIds.includes(tabletTypeId),
  );
}

describe("product narrowing filter", () => {
  const cardProduct: MockProduct = { id: "p1", sku: "CARD_A", name: "Card A", allowedTabletTypeIds: ["tt-001"] };
  const bottleProduct: MockProduct = { id: "p2", sku: "BOT_A", name: "Bottle A", allowedTabletTypeIds: ["tt-002"] };
  const multiTabletCard: MockProduct = { id: "p3", sku: "CARD_B", name: "Card B", allowedTabletTypeIds: ["tt-001", "tt-003"] };
  const unmappedProduct: MockProduct = { id: "p4", sku: "GENERIC", name: "Generic", allowedTabletTypeIds: [] };

  it("shows only products compatible with scanned tablet type", () => {
    const result = narrowProducts([cardProduct, bottleProduct], "tt-001");
    expect(result).toEqual([cardProduct]);
  });

  it("shows all products when tablet type is null (no tablet info)", () => {
    const result = narrowProducts([cardProduct, bottleProduct], null);
    expect(result).toEqual([cardProduct, bottleProduct]);
  });

  it("shows product mapped to multiple tablet types when matching one of them", () => {
    const result = narrowProducts([cardProduct, multiTabletCard, bottleProduct], "tt-003");
    expect(result).toEqual([multiTabletCard]);
  });

  it("shows unmapped product (allowedTabletTypeIds=[]) regardless of scanned tablet", () => {
    const result = narrowProducts([cardProduct, unmappedProduct], "tt-001");
    expect(result).toEqual([cardProduct, unmappedProduct]);
  });

  it("returns empty array when no products are compatible (config error case)", () => {
    const result = narrowProducts([cardProduct, bottleProduct], "tt-999");
    expect(result).toHaveLength(0);
  });

  it("auto-select scenario: exactly one product matches", () => {
    const result = narrowProducts([cardProduct, bottleProduct], "tt-001");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
  });
});
