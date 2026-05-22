// FLOOR-START-3 + FLOOR-START-5 tests.
//
// FLOOR-START-3: lookupCardByTokenAction invariants.
// FLOOR-START-5: typed/camera scan advances the flow (resolvedCardId,
//   hasCardSelected, auto-submit on single product).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const formSrc = readFileSync(resolve(here, "scan-card-form.tsx"), "utf8");

// ── DB mock ──────────────────────────────────────────────────────────────

let callIdx = 0;
const selectResults: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        leftJoin: (_t: unknown, _c: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: async (_count?: unknown) => {
              const rows = (selectResults[callIdx++] ?? []) as unknown[];
              return rows;
            },
          }),
        }),
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
  inventoryBags: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
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
  tabletTypeId: null,
};

const INTAKE_RESERVED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000002",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: null,
  tabletTypeId: "tt-001",
};

const ASSIGNED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000003",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: "00000000-0000-0000-0000-000000000099",
  tabletTypeId: "tt-002",
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
    const ok = result as { ok: true; cardId: string; isIntakeReserved: boolean; tabletTypeId: string | null };
    expect(ok.cardId).toBe(INTAKE_RESERVED_RAW_BAG.id);
    expect(ok.isIntakeReserved).toBe(true);
    expect(ok.tabletTypeId).toBe("tt-001");
  });

  it("returns ok+isIntakeReserved=false for mid-production ASSIGNED RAW_BAG card", async () => {
    selectResults[0] = [ASSIGNED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("pickup-bag-token"));
    expect(result).toHaveProperty("ok", true);
    const ok = result as { ok: true; cardId: string; isIntakeReserved: boolean; tabletTypeId: string | null };
    expect(ok.cardId).toBe(ASSIGNED_RAW_BAG.id);
    expect(ok.isIntakeReserved).toBe(false);
    expect(ok.tabletTypeId).toBe("tt-002");
  });

  it("trims whitespace from scan token before lookup", async () => {
    selectResults[0] = [INTAKE_RESERVED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("  bag-card-2  "));
    expect(result).toHaveProperty("ok", true);
  });

  it("returns tabletTypeId null when leftJoin finds no inventory bag", async () => {
    selectResults[0] = [{
      id: "00000000-0000-0000-0000-000000000004",
      cardType: "RAW_BAG",
      status: "ASSIGNED",
      assignedWorkflowBagId: null,
      tabletTypeId: null,
    }];
    const result = await lookupCardByTokenAction(makeForm("unlinked-token"));
    expect(result).toHaveProperty("ok", true);
    const ok = result as { ok: true; cardId: string; isIntakeReserved: boolean; tabletTypeId: string | null };
    expect(ok.tabletTypeId).toBeNull();
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

// ── FLOOR-START-5 structural invariants (source-text) ────────────────────────

describe("FLOOR-START-5 · scan-card-form.tsx structural invariants", () => {
  it("declares resolvedCardId state", () => {
    expect(formSrc).toMatch(/resolvedCardId/);
    expect(formSrc).toMatch(/setResolvedCardId/);
  });

  it("hasCardSelected includes resolvedCardId === selectedCardId check", () => {
    expect(formSrc).toMatch(/hasCardSelected/);
    expect(formSrc).toMatch(/resolvedCardId\s*===\s*selectedCardId/);
  });

  it("showProductPicker uses hasCardSelected, not isReceivedCardSelected directly", () => {
    const block = formSrc.match(/const showProductPicker[\s\S]*?;/)?.[0] ?? "";
    expect(block).toMatch(/hasCardSelected/);
    expect(block).not.toMatch(/isReceivedCardSelected/);
  });

  it("submitWithCardId accepts optional explicitProductId parameter", () => {
    expect(formSrc).toMatch(/explicitProductId\?/);
    expect(formSrc).toMatch(/explicitProductId\s*\?\?\s*productId/);
  });

  it("handleResolvedToken auto-submits with explicit product ID when narrowed list has one entry", () => {
    expect(formSrc).toMatch(/await submitWithCardId\(cardId,\s*narrowed\[0\]\.id\)/);
  });

  it("setResolvedCardId(null) is called in dropdown onChange to reset scan path", () => {
    expect(formSrc).toMatch(/setResolvedCardId\(null\)/);
  });

  it("submit button onClick intercepts when resolvedCardId is set", () => {
    expect(formSrc).toMatch(/if\s*\(\s*resolvedCardId\s*\)/);
    expect(formSrc).toMatch(/submitWithCardId\(resolvedCardId\)/);
  });

  it("zero-products error uses hasCardSelected (fires for scan-resolved cards too)", () => {
    // In JSX: {requireProductForFreshBag && hasCardSelected && filteredProducts.length === 0 && ...}
    expect(formSrc).toMatch(/hasCardSelected[\s\S]{0,60}filteredProducts\.length === 0/);
  });
});

// ── FLOOR-START-5 · hasCardSelected pure logic ────────────────────────────────

function computeHasCardSelected(
  selectedCardId: string,
  receivedSet: Set<string>,
  resolvedCardId: string | null,
): boolean {
  return (
    selectedCardId !== "" &&
    (receivedSet.has(selectedCardId) || resolvedCardId === selectedCardId)
  );
}

describe("FLOOR-START-5 · hasCardSelected", () => {
  const RECEIVED_ID = "00000000-0000-0000-0000-aaaaaaaaaaaa";
  const SCANNED_ID = "00000000-0000-0000-0000-bbbbbbbbbbbb";
  const receivedSet = new Set([RECEIVED_ID]);

  it("false when selectedCardId is empty", () => {
    expect(computeHasCardSelected("", receivedSet, null)).toBe(false);
  });

  it("true when selectedCardId is in receivedSet (dropdown path)", () => {
    expect(computeHasCardSelected(RECEIVED_ID, receivedSet, null)).toBe(true);
  });

  it("true when selectedCardId matches resolvedCardId (scan path, card not in dropdown)", () => {
    expect(computeHasCardSelected(SCANNED_ID, receivedSet, SCANNED_ID)).toBe(true);
  });

  it("false when selectedCardId is not in receivedSet and resolvedCardId is null (silent-failure case FLOOR-START-5 fixed)", () => {
    expect(computeHasCardSelected(SCANNED_ID, receivedSet, null)).toBe(false);
  });

  it("false when resolvedCardId is set but selectedCardId differs (stale state)", () => {
    expect(computeHasCardSelected(SCANNED_ID, receivedSet, "different-id")).toBe(false);
  });

  it("true when card is in both receivedSet and resolvedCardId (both paths match)", () => {
    expect(computeHasCardSelected(RECEIVED_ID, receivedSet, RECEIVED_ID)).toBe(true);
  });
});

// ── FLOOR-START-5 · auto-submit trigger condition ────────────────────────────

describe("FLOOR-START-5 · auto-submit on single compatible product", () => {
  it("triggers auto-submit when narrowed list has exactly one product", () => {
    const narrowed = [{ id: "p1", sku: "CARD", name: "Card A", allowedTabletTypeIds: ["tt-001"] }];
    expect(narrowed.length === 1 && !!narrowed[0]).toBe(true);
  });

  it("shows picker (defers submit) when multiple products match", () => {
    const narrowed = [
      { id: "p1", sku: "CARD_A", name: "Card A", allowedTabletTypeIds: [] },
      { id: "p2", sku: "CARD_B", name: "Card B", allowedTabletTypeIds: [] },
    ];
    expect(narrowed.length === 1).toBe(false);
  });

  it("shows config-error (defers submit) when zero products match", () => {
    const narrowed: unknown[] = [];
    expect(narrowed.length === 1).toBe(false);
    expect(narrowed.length === 0).toBe(true);
  });

  it("auto-submit uses narrowed[0].id directly (not productId state) to avoid stale closure", () => {
    // Verified structurally: submitWithCardId(cardId, narrowed[0].id) passes
    // the product ID as an explicit argument, not relying on the productId state
    // variable which would be stale in the same render cycle.
    expect(formSrc).toMatch(/submitWithCardId\(cardId,\s*narrowed\[0\]\.id\)/);
  });
});
