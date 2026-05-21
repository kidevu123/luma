// QR-1 Task 6 — Unit tests for qr-cards validation helpers.
//
// All 14 test cases use a fully mocked DB; no real Postgres connection.
// The mock supports the select().from().where().orderBy().limit() chain
// used by every helper in this module.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
//
// selectResult holds the rows that the next awaited query will return.
// Each query consumes it once (single-use per test).

let selectResult: unknown[] = [];

function buildChain(rows: unknown[]) {
  return {
    // .where(...)
    where: (_cond?: unknown) => ({
      // .where().orderBy(...)
      orderBy: (_ord?: unknown) => ({
        // .where().orderBy().limit(n) — used by getNext*
        limit: async (_n?: number) => rows,
        // awaitable: .where().orderBy() — used by list* helpers
        then: (
          resolve: (v: unknown[]) => void,
          reject: (e: unknown) => void,
        ) => {
          Promise.resolve(rows).then(resolve, reject);
        },
      }),
      // awaitable: .where() directly — used by validate* helpers
      then: (
        resolve: (v: unknown[]) => void,
        reject: (e: unknown) => void,
      ) => {
        Promise.resolve(rows).then(resolve, reject);
      },
    }),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (_table?: unknown) => buildChain(selectResult),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  qrCards: {},
  workflowBags: {},
  products: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (_a: unknown, _b: unknown) => ({}),
  and: (..._args: unknown[]) => ({}),
  asc: (_col: unknown) => ({}),
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

// ── Import module under test AFTER mocks ─────────────────────────────────────
import {
  listAvailableRawBagQrCards,
  listAvailableVarietyPackQrCards,
  getNextAvailableRawBagQrCard,
  validateQrCardUsableForRawBag,
  validateQrCardUsableForVarietyPack,
  type QrCardRow,
} from "./qr-cards";

// ── Fixture builder ──────────────────────────────────────────────────────────

function makeCard(
  overrides: Partial<QrCardRow> = {},
): QrCardRow {
  return {
    id: "card-id-1",
    label: "QR-001",
    scanToken: "token-abc",
    status: "IDLE",
    cardType: "RAW_BAG",
    assignedWorkflowBagId: null,
    retiredAt: null,
    notes: null,
    ...overrides,
  };
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  selectResult = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. listAvailableRawBagQrCards
// ─────────────────────────────────────────────────────────────────────────────

describe("listAvailableRawBagQrCards", () => {
  it("returns only RAW_BAG IDLE cards", async () => {
    const card1 = makeCard({ id: "a", label: "QR-001", cardType: "RAW_BAG", status: "IDLE" });
    const card2 = makeCard({ id: "b", label: "QR-002", cardType: "RAW_BAG", status: "IDLE" });
    selectResult = [card1, card2];

    const result = await listAvailableRawBagQrCards();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(card1);
    expect(result[1]).toEqual(card2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. listAvailableVarietyPackQrCards
// ─────────────────────────────────────────────────────────────────────────────

describe("listAvailableVarietyPackQrCards", () => {
  it("returns only VARIETY_PACK IDLE cards", async () => {
    const card = makeCard({ id: "vp-1", label: "VP-001", cardType: "VARIETY_PACK", status: "IDLE" });
    selectResult = [card];

    const result = await listAvailableVarietyPackQrCards();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(card);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. getNextAvailableRawBagQrCard
// ─────────────────────────────────────────────────────────────────────────────

describe("getNextAvailableRawBagQrCard", () => {
  it("returns the first available RAW_BAG IDLE card when one exists", async () => {
    const card = makeCard({ id: "first", label: "QR-001", cardType: "RAW_BAG", status: "IDLE" });
    selectResult = [card];

    const result = await getNextAvailableRawBagQrCard();

    expect(result).toEqual(card);
  });

  it("returns null when no RAW_BAG IDLE cards are available", async () => {
    selectResult = [];

    const result = await getNextAvailableRawBagQrCard();

    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–10. validateQrCardUsableForRawBag
// ─────────────────────────────────────────────────────────────────────────────

describe("validateQrCardUsableForRawBag", () => {
  it("returns { valid: true, card } for a RAW_BAG IDLE card", async () => {
    const card = makeCard({ cardType: "RAW_BAG", status: "IDLE" });
    selectResult = [card];

    const result = await validateQrCardUsableForRawBag("token-abc");

    expect(result).toEqual({ valid: true, card });
  });

  it("returns not-found reason when no card matches the token", async () => {
    selectResult = [];

    const result = await validateQrCardUsableForRawBag("token-missing");

    expect(result).toEqual({ valid: false, reason: "QR card not found" });
  });

  it("rejects a VARIETY_PACK card with the correct type reason", async () => {
    const card = makeCard({ cardType: "VARIETY_PACK", status: "IDLE" });
    selectResult = [card];

    const result = await validateQrCardUsableForRawBag("token-abc");

    expect(result).toEqual({
      valid: false,
      reason: "Card is designated for variety packs, not raw bags",
    });
  });

  it("rejects an UNKNOWN card type with the correct reason", async () => {
    const card = makeCard({ cardType: "UNKNOWN", status: "IDLE" });
    selectResult = [card];

    const result = await validateQrCardUsableForRawBag("token-abc");

    expect(result).toEqual({
      valid: false,
      reason: "Card type is not configured — contact admin",
    });
  });

  it("rejects a RAW_BAG card that is ASSIGNED with the correct reason", async () => {
    const card = makeCard({ cardType: "RAW_BAG", status: "ASSIGNED" });
    selectResult = [card];

    const result = await validateQrCardUsableForRawBag("token-abc");

    expect(result).toEqual({
      valid: false,
      reason: "Card is already assigned to an active bag",
    });
  });

  it("rejects a RAW_BAG card that is RETIRED with the correct reason", async () => {
    const card = makeCard({ cardType: "RAW_BAG", status: "RETIRED", retiredAt: new Date() });
    selectResult = [card];

    const result = await validateQrCardUsableForRawBag("token-abc");

    expect(result).toEqual({ valid: false, reason: "Card has been retired" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11–14. validateQrCardUsableForVarietyPack
// ─────────────────────────────────────────────────────────────────────────────

describe("validateQrCardUsableForVarietyPack", () => {
  it("returns { valid: true, card } for a VARIETY_PACK IDLE card", async () => {
    const card = makeCard({ cardType: "VARIETY_PACK", status: "IDLE" });
    selectResult = [card];

    const result = await validateQrCardUsableForVarietyPack("token-abc");

    expect(result).toEqual({ valid: true, card });
  });

  it("returns not-found reason when no card matches the token", async () => {
    selectResult = [];

    const result = await validateQrCardUsableForVarietyPack("token-missing");

    expect(result).toEqual({ valid: false, reason: "QR card not found" });
  });

  it("rejects a RAW_BAG card with the correct type reason", async () => {
    const card = makeCard({ cardType: "RAW_BAG", status: "IDLE" });
    selectResult = [card];

    const result = await validateQrCardUsableForVarietyPack("token-abc");

    expect(result).toEqual({
      valid: false,
      reason: "Card is designated for raw bags, not variety packs",
    });
  });

  it("rejects a VARIETY_PACK card that is ASSIGNED with the correct reason", async () => {
    const card = makeCard({ cardType: "VARIETY_PACK", status: "ASSIGNED" });
    selectResult = [card];

    const result = await validateQrCardUsableForVarietyPack("token-abc");

    expect(result).toEqual({
      valid: false,
      reason: "Card is already assigned to an active bag",
    });
  });
});
