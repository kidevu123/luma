import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  requireLead: vi.fn().mockResolvedValue({
    id: "user-001",
    role: "LEAD",
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockEditInventoryBag = vi.fn();

vi.mock("@/lib/db/queries/bag-edits", () => ({
  editInventoryBag: (...args: unknown[]) => mockEditInventoryBag(...args),
}));

import { editBagAction } from "./actions";

const RECEIVE_ID = "rcv-001";
const BAG_ID = "bag-001";

beforeEach(() => {
  vi.clearAllMocks();
  mockEditInventoryBag.mockResolvedValue({ ok: true });
});

describe("editBagAction — weight kg→grams conversion", () => {
  it("converts 1.234 kg to 1234 grams", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { weightKg: "1.234" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, { weightGrams?: number | null }];
    expect(input.weightGrams).toBe(1234);
  });

  it("rounds 1.0005 kg to 1001 grams (Math.round)", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { weightKg: "1.0005" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, { weightGrams?: number | null }];
    expect(input.weightGrams).toBe(1001);
  });

  it("converts empty string weight to null (weight cleared)", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { weightKg: "" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, { weightGrams?: number | null }];
    expect(input.weightGrams).toBeNull();
  });

  it("returns error for negative weight", async () => {
    const result = await editBagAction(RECEIVE_ID, BAG_ID, { weightKg: "-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid weight/i);
    expect(mockEditInventoryBag).not.toHaveBeenCalled();
  });

  it("returns error for non-numeric weight", async () => {
    const result = await editBagAction(RECEIVE_ID, BAG_ID, { weightKg: "abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid weight/i);
  });
});

describe("editBagAction — no-op: unchanged fields not forwarded", () => {
  it("does not include weightGrams when weightKg is absent", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { notes: "updated" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, Record<string, unknown>];
    expect("weightGrams" in input).toBe(false);
  });

  it("does not include bagQrCode when not provided", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { notes: "updated" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, Record<string, unknown>];
    expect("bagQrCode" in input).toBe(false);
  });

  it("forwards all provided fields in a single call", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, {
      weightKg: "2.0",
      notes: "ok",
      internalReceiptNumber: "R-999",
      bagQrCode: "bag-card-999",
      editReason: "correction",
    });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.weightGrams).toBe(2000);
    expect(input.notes).toBe("ok");
    expect(input.internalReceiptNumber).toBe("R-999");
    expect(input.bagQrCode).toBe("bag-card-999");
    expect(input.editReason).toBe("correction");
  });
});

describe("RECEIVE-EDIT-2B-2 · editBagAction — declared pill count", () => {
  it("forwards a valid integer declared pill count", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { declaredPillCount: "4800" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [
      unknown,
      { declaredPillCount?: number | null },
    ];
    expect(input.declaredPillCount).toBe(4800);
  });

  it("clears declared pill count when empty string", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { declaredPillCount: "" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [
      unknown,
      { declaredPillCount?: number | null },
    ];
    expect(input.declaredPillCount).toBeNull();
  });

  it("rejects negative declared pill count", async () => {
    const result = await editBagAction(RECEIVE_ID, BAG_ID, {
      declaredPillCount: "-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid declared pill count/i);
    expect(mockEditInventoryBag).not.toHaveBeenCalled();
  });

  it("does not forward pillCount (live count)", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { declaredPillCount: "100" });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, Record<string, unknown>];
    expect("pillCount" in input).toBe(false);
  });
});

describe("editBagAction — notes trimming and blank→null", () => {
  it("trims whitespace from notes", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { notes: "  padded  " });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, { notes?: string | null }];
    expect(input.notes).toBe("padded");
  });

  it("stores blank notes as null", async () => {
    await editBagAction(RECEIVE_ID, BAG_ID, { notes: "   " });
    const [, input] = mockEditInventoryBag.mock.calls[0] as [unknown, { notes?: string | null }];
    expect(input.notes).toBeNull();
  });
});

describe("editBagAction — propagates editInventoryBag error", () => {
  it("returns the error from editInventoryBag unchanged", async () => {
    mockEditInventoryBag.mockResolvedValue({
      ok: false,
      error: "Edit reason is required for QR, receipt, or lot changes.",
    });
    const result = await editBagAction(RECEIVE_ID, BAG_ID, {
      bagQrCode: "bag-card-999",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/reason/i);
  });
});
