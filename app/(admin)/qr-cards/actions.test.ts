import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireAdmin = vi.fn();
const mockRetireQrCard = vi.fn();
const mockRevalidatePath = vi.fn();

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

vi.mock("@/lib/db/queries/qr-cards", () => ({
  createQrCard: vi.fn(),
  retireQrCard: (...args: unknown[]) => mockRetireQrCard(...args),
}));

import { retireQrCardAction } from "./actions";

const CARD_ID = "card-1111-2222-3333-4444-555566667777";
const ACTOR = { id: "admin-1", role: "ADMIN" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ACTOR);
  mockRetireQrCard.mockResolvedValue({ id: CARD_ID, status: "RETIRED" });
});

describe("QR-CARDS-RETIRE-1 · retireQrCardAction", () => {
  it("requires admin and calls retireQrCard", async () => {
    const result = await retireQrCardAction(CARD_ID);
    expect(mockRequireAdmin).toHaveBeenCalled();
    expect(mockRetireQrCard).toHaveBeenCalledWith(CARD_ID, ACTOR);
    expect(result).toEqual({ ok: true });
  });

  it("revalidates the QR cards page on success", async () => {
    await retireQrCardAction(CARD_ID);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/qr-cards");
  });

  it("returns a friendly error when retireQrCard throws mid-bag", async () => {
    mockRetireQrCard.mockRejectedValue(
      new Error("Cannot retire a card that's mid-bag. Finalize the bag first."),
    );
    const result = await retireQrCardAction(CARD_ID);
    expect(result).toEqual({
      error: "Cannot retire a card that's mid-bag. Finalize the bag first.",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
