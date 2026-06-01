import { describe, expect, it, vi } from "vitest";
import { mockCallZohoProductionOutputCommit } from "./production-output-commit-mock";

describe("mockCallZohoProductionOutputCommit", () => {
  const payload = { purchaseorder_id: "po-1", quantity_good: 10 };
  const key = "luma-production-output:luma-op:hash-a";

  it("returns success without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = mockCallZohoProductionOutputCommit({
      requestPayload: payload,
      commitIdempotencyKey: key,
      fixture: { outcome: "success", externalReferenceId: "zoho-ref-99" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idempotencyKey).toBe(key);
    expect(result.requestPayload).toBe(payload);
    expect(result.externalReferenceId).toBe("zoho-ref-99");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns failure fixture without network I/O", () => {
    const result = mockCallZohoProductionOutputCommit({
      requestPayload: payload,
      commitIdempotencyKey: key,
      fixture: { outcome: "failure", message: "validation failed", httpStatus: 422 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("validation failed");
    expect(result.httpStatus).toBe(422);
    expect(result.requestPayload).toEqual(payload);
  });
});
