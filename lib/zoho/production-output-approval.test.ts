import { describe, expect, it } from "vitest";
import {
  canVoidZohoProductionOutputOp,
  evaluateZohoProductionOutputApproval,
} from "./production-output-approval";

const PREVIEWED_ELIGIBLE = {
  status: "PREVIEWED" as const,
  voidedAt: null,
  previewResponse: { preview: true },
  previewHttpStatus: 200,
  metricsState: "HIGH" as const,
  genealogyState: "HIGH" as const,
  requestHash: "hash-a",
  approvedRequestHash: null,
};

describe("evaluateZohoProductionOutputApproval", () => {
  it("allows PREVIEWED op with high-confidence metrics and genealogy", () => {
    const result = evaluateZohoProductionOutputApproval(PREVIEWED_ELIGIBLE);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks DRAFT approval", () => {
    const result = evaluateZohoProductionOutputApproval({
      ...PREVIEWED_ELIGIBLE,
      status: "DRAFT",
      previewResponse: null,
      previewHttpStatus: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("preview"))).toBe(true);
  });

  it("blocks missing metrics", () => {
    const result = evaluateZohoProductionOutputApproval({
      ...PREVIEWED_ELIGIBLE,
      metricsState: "MISSING",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(
      "Metrics state is MISSING — approval is blocked.",
    );
  });

  it("blocks missing genealogy", () => {
    const result = evaluateZohoProductionOutputApproval({
      ...PREVIEWED_ELIGIBLE,
      genealogyState: "MISSING",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(
      "Genealogy state is MISSING — approval is blocked.",
    );
  });

  it("blocks LOW genealogy", () => {
    const result = evaluateZohoProductionOutputApproval({
      ...PREVIEWED_ELIGIBLE,
      genealogyState: "LOW",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(
      "Genealogy state is LOW — approval is blocked.",
    );
  });

  it("blocks when approved hash drifted from preview hash", () => {
    const result = evaluateZohoProductionOutputApproval({
      ...PREVIEWED_ELIGIBLE,
      status: "APPROVED",
      approvedRequestHash: "hash-a",
      requestHash: "hash-b",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("hash"))).toBe(true);
  });
});

describe("canVoidZohoProductionOutputOp", () => {
  it("allows void for DRAFT, PREVIEWED, and APPROVED", () => {
    for (const status of ["DRAFT", "PREVIEWED", "APPROVED"] as const) {
      expect(canVoidZohoProductionOutputOp({ status, voidedAt: null }).ok).toBe(
        true,
      );
    }
  });

  it("rejects void without reason path when already voided", () => {
    expect(
      canVoidZohoProductionOutputOp({
        status: "VOIDED",
        voidedAt: new Date(),
      }).ok,
    ).toBe(false);
  });
});
