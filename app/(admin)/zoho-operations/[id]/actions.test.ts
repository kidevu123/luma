// Unit tests for Zoho operations server actions.
// Mocks are hoisted by vitest before module imports.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/queries/zoho-assembly", () => ({
  resetZohoAssemblyOpToPending: vi.fn(),
  resolveZohoAssemblyOpManually: vi.fn(),
}));

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  resetZohoAssemblyOpToPending,
  resolveZohoAssemblyOpManually,
} from "@/lib/db/queries/zoho-assembly";
import { requireAdmin } from "@/lib/auth-guards";
import { resetToPendingAction, resolveManuallyAction } from "./actions";

const OP_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const mockReset = vi.mocked(resetZohoAssemblyOpToPending);
const mockResolve = vi.mocked(resolveZohoAssemblyOpManually);
const mockRequireAdmin = vi.mocked(requireAdmin);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    id: "user-id-1",
    role: "ADMIN",
    email: "admin@test.com",
  } as Awaited<ReturnType<typeof requireAdmin>>);
});

// ─── resetToPendingAction ─────────────────────────────────────────────────────

describe("resetToPendingAction", () => {
  it("returns {} on success", async () => {
    mockReset.mockResolvedValue(undefined as never);
    const result = await resetToPendingAction(OP_ID);
    expect(result).toEqual({});
  });

  it("calls resetZohoAssemblyOpToPending with the op id", async () => {
    mockReset.mockResolvedValue(undefined as never);
    await resetToPendingAction(OP_ID);
    expect(mockReset).toHaveBeenCalledWith(OP_ID);
  });

  it("returns { error } when query throws (non-resettable status)", async () => {
    mockReset.mockRejectedValue(
      new Error("cannot reset op in status SUCCEEDED"),
    );
    const result = await resetToPendingAction(OP_ID);
    expect(result.error).toContain("cannot reset");
  });

  it("returns generic error message for non-Error throws", async () => {
    mockReset.mockRejectedValue("some string throw");
    const result = await resetToPendingAction(OP_ID);
    expect(result.error).toBe("Unexpected error.");
  });
});

// ─── resolveManuallyAction ────────────────────────────────────────────────────

describe("resolveManuallyAction", () => {
  it("returns validation error for empty note — no DB call", async () => {
    const result = await resolveManuallyAction(OP_ID, "");
    expect(result.error).toBe("A resolved note is required.");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns validation error for whitespace-only note — no DB call", async () => {
    const result = await resolveManuallyAction(OP_ID, "   ");
    expect(result.error).toBe("A resolved note is required.");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns {} on success", async () => {
    mockResolve.mockResolvedValue(undefined as never);
    const result = await resolveManuallyAction(OP_ID, "Fixed the issue");
    expect(result).toEqual({});
  });

  it("calls resolveZohoAssemblyOpManually with trimmed note and user id", async () => {
    mockResolve.mockResolvedValue(undefined as never);
    await resolveManuallyAction(OP_ID, "  Fixed  ");
    expect(mockResolve).toHaveBeenCalledWith(OP_ID, {
      note: "Fixed",
      resolvedByUserId: "user-id-1",
    });
  });

  it("returns { error } when query throws", async () => {
    mockResolve.mockRejectedValue(new Error("DB connection failed"));
    const result = await resolveManuallyAction(OP_ID, "some note");
    expect(result.error).toContain("DB connection failed");
  });
});
