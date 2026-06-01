import { describe, expect, it } from "vitest";
import {
  canVoidZohoProductionOutputOp,
  evaluateZohoProductionOutputCommitReadiness,
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

const APPROVED_READY = {
  status: "APPROVED" as const,
  voidedAt: null,
  approvedRequestHash: "hash-a",
  requestHash: "hash-a",
  requestPayload: { purchaseorder_id: "po-1" },
  previewResponse: { preview: true },
  previewHttpStatus: 200,
  metricsState: "HIGH" as const,
  genealogyState: "HIGH" as const,
  finishedLotExists: true,
  committedOpExists: false,
  legacyAssemblyOpExists: false,
  legacyZohoPushExists: false,
};

describe("evaluateZohoProductionOutputCommitReadiness", () => {
  it("marks an approved high-confidence preview as ready without legacy blockers", () => {
    const result = evaluateZohoProductionOutputCommitReadiness(APPROVED_READY);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocks non-approved and voided operations", () => {
    const draft = evaluateZohoProductionOutputCommitReadiness({
      ...APPROVED_READY,
      status: "PREVIEWED",
    });
    expect(draft.ready).toBe(false);
    expect(draft.blockers.map((b) => b.code)).toContain("NOT_APPROVED");

    const voided = evaluateZohoProductionOutputCommitReadiness({
      ...APPROVED_READY,
      status: "VOIDED",
      voidedAt: new Date(),
    });
    expect(voided.blockers.map((b) => b.code)).toContain("VOIDED");
  });

  it("blocks approved hash drift and missing preview response", () => {
    const result = evaluateZohoProductionOutputCommitReadiness({
      ...APPROVED_READY,
      approvedRequestHash: "hash-a",
      requestHash: "hash-b",
      previewResponse: null,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        "APPROVED_HASH_MISMATCH",
        "MISSING_PREVIEW_RESPONSE",
      ]),
    );
  });

  it("blocks unsuccessful preview status", () => {
    const result = evaluateZohoProductionOutputCommitReadiness({
      ...APPROVED_READY,
      previewHttpStatus: 422,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain(
      "PREVIEW_NOT_SUCCESSFUL",
    );
  });

  it("blocks MISSING or LOW metrics and genealogy", () => {
    for (const metricsState of ["MISSING", "LOW"] as const) {
      const result = evaluateZohoProductionOutputCommitReadiness({
        ...APPROVED_READY,
        metricsState,
      });
      expect(result.blockers.map((b) => b.code)).toContain("METRICS_NOT_HIGH");
    }

    for (const genealogyState of ["MISSING", "LOW"] as const) {
      const result = evaluateZohoProductionOutputCommitReadiness({
        ...APPROVED_READY,
        genealogyState,
      });
      expect(result.blockers.map((b) => b.code)).toContain(
        "GENEALOGY_NOT_HIGH",
      );
    }
  });

  it("blocks existing committed ops and legacy Zoho paths to prevent double-posting", () => {
    const result = evaluateZohoProductionOutputCommitReadiness({
      ...APPROVED_READY,
      committedOpExists: true,
      legacyAssemblyOpExists: true,
      legacyZohoPushExists: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        "ALREADY_COMMITTED",
        "LEGACY_ASSEMBLY_OP_EXISTS",
        "LEGACY_ZOHO_PUSH_EXISTS",
      ]),
    );
  });
});
