import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireLead = vi.fn();
const mockEditReceive = vi.fn();

vi.mock("@/lib/auth-guards", () => ({
  requireLead: (...args: unknown[]) => mockRequireLead(...args),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/db/queries/receive-edits", () => ({
  editReceive: (...args: unknown[]) => mockEditReceive(...args),
}));

import { editReceiveAction } from "./actions";

const RECEIVE_ID = "rcv-001";
const ACTOR = { id: "user-lead", role: "LEAD" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireLead.mockResolvedValue(ACTOR);
  mockEditReceive.mockResolvedValue({ ok: true });
});

describe("RECEIVE-EDIT-2B-1 · editReceiveAction", () => {
  it("calls requireLead before editing", async () => {
    await editReceiveAction(RECEIVE_ID, { notes: "ok", isClosed: false });
    expect(mockRequireLead).toHaveBeenCalled();
    expect(mockEditReceive).toHaveBeenCalledWith(
      RECEIVE_ID,
      { isClosed: false, notes: "ok" },
      ACTOR,
    );
  });

  it("propagates editReceive errors", async () => {
    mockEditReceive.mockResolvedValue({ ok: false, error: "Receive not found." });
    const result = await editReceiveAction(RECEIVE_ID, { isClosed: true });
    expect(result).toEqual({ ok: false, error: "Receive not found." });
  });
});
