import { describe, expect, it } from "vitest";
import {
  isLikelyLumaInternalReceiptNumber,
  looksLikeZohoPurchaseReceiveEntityId,
  validateZohoPurchaseReceiveIdCandidate,
} from "./receipt-id-validation";

describe("receipt-id-validation", () => {
  it("treats 352176 as a Luma internal receipt number", () => {
    expect(isLikelyLumaInternalReceiptNumber("352176")).toBe(true);
    expect(looksLikeZohoPurchaseReceiveEntityId("352176")).toBe(false);
  });

  it("accepts long Zoho entity IDs", () => {
    expect(
      looksLikeZohoPurchaseReceiveEntityId("5254962000001234567"),
    ).toBe(true);
  });

  it("rejects internal receipt submitted as Zoho purchase receive ID", () => {
    const result = validateZohoPurchaseReceiveIdCandidate("352176", "352176");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Luma receipt number/i);
    }
  });

  it("rejects short numeric values even when receipt numbers differ", () => {
    const result = validateZohoPurchaseReceiveIdCandidate("352176", "999999");
    expect(result.ok).toBe(false);
  });

  it("accepts valid Zoho entity ID distinct from Luma receipt", () => {
    const result = validateZohoPurchaseReceiveIdCandidate(
      "5254962000001234567",
      "352176",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.zohoPurchaseReceiveId).toBe("5254962000001234567");
    }
  });
});
