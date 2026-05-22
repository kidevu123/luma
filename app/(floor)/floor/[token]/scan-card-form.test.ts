// FLOOR-START-1 tests — lookupCardByTokenAction invariants.
//
// Covers: card-not-found, wrong card type, retired card, valid RAW_BAG
// (IDLE and intake-reserved ASSIGNED+no-bag).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────

let callIdx = 0;
const selectResults: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_cond?: unknown) => ({
          limit: async (_n?: number) => {
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
};

const INTAKE_RESERVED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000002",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
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
    expect((result as { error: string }).error).toMatch(/required/i);
  });

  it("returns error when card not found", async () => {
    selectResults[0] = []; // no card for this token
    const result = await lookupCardByTokenAction(makeForm("nonexistent-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not found/i);
  });

  it("returns error for VARIETY_PACK card", async () => {
    selectResults[0] = [{ id: "aaa", cardType: "VARIETY_PACK", status: "IDLE" }];
    const result = await lookupCardByTokenAction(makeForm("variety-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not a bag QR/i);
  });

  it("returns error for UNKNOWN card type", async () => {
    selectResults[0] = [{ id: "bbb", cardType: "UNKNOWN", status: "IDLE" }];
    const result = await lookupCardByTokenAction(makeForm("unknown-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not a bag QR/i);
  });

  it("returns error for RETIRED RAW_BAG card", async () => {
    selectResults[0] = [{ id: "ccc", cardType: "RAW_BAG", status: "RETIRED" }];
    const result = await lookupCardByTokenAction(makeForm("retired-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/retired/i);
  });

  it("returns cardId for IDLE RAW_BAG card", async () => {
    selectResults[0] = [IDLE_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("bag-card-1"));
    expect(result).toHaveProperty("ok", true);
    expect((result as { ok: true; cardId: string }).cardId).toBe(IDLE_RAW_BAG.id);
  });

  it("returns cardId for intake-reserved ASSIGNED RAW_BAG card", async () => {
    selectResults[0] = [INTAKE_RESERVED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("bag-card-2"));
    expect(result).toHaveProperty("ok", true);
    expect((result as { ok: true; cardId: string }).cardId).toBe(INTAKE_RESERVED_RAW_BAG.id);
  });

  it("returns cardId for ASSIGNED RAW_BAG card (pickup path forwarded to scanCardAction)", async () => {
    selectResults[0] = [{ id: "ddd", cardType: "RAW_BAG", status: "ASSIGNED" }];
    const result = await lookupCardByTokenAction(makeForm("pickup-bag-token"));
    expect(result).toHaveProperty("ok", true);
    expect((result as { ok: true; cardId: string }).cardId).toBe("ddd");
  });

  it("trims whitespace from scan token before lookup", async () => {
    selectResults[0] = [IDLE_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("  bag-card-1  "));
    expect(result).toHaveProperty("ok", true);
  });
});
