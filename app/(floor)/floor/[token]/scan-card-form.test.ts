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
