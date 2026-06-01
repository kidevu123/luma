import { describe, expect, it } from "vitest";
import {
  buildZohoProductionOutputCommitIdempotencyKey,
  canVoidZohoProductionOutputOp,
  evaluateZohoProductionOutputCommitReadiness,
  evaluateZohoProductionOutputQueueEligibility,
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

  it("allows void for QUEUED operations", () => {
    expect(
      canVoidZohoProductionOutputOp({ status: "QUEUED", voidedAt: null }).ok,
    ).toBe(true);
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

const QUEUE_READY = {
  ...APPROVED_READY,
  lumaOperationId: "luma-op-1",
  commitRequestedAt: null,
  commitIdempotencyKey: null,
};

describe("buildZohoProductionOutputCommitIdempotencyKey", () => {
  it("is deterministic for the same operation and approved hash", () => {
    const first = buildZohoProductionOutputCommitIdempotencyKey(
      "luma-op-1",
      "hash-a",
    );
    const second = buildZohoProductionOutputCommitIdempotencyKey(
      "luma-op-1",
      "hash-a",
    );
    expect(first).toBe(second);
    expect(first).toBe("luma-production-output:luma-op-1:hash-a");
  });

  it("changes when the approved hash changes", () => {
    const first = buildZohoProductionOutputCommitIdempotencyKey(
      "luma-op-1",
      "hash-a",
    );
    const second = buildZohoProductionOutputCommitIdempotencyKey(
      "luma-op-1",
      "hash-b",
    );
    expect(first).not.toBe(second);
  });
});

describe("evaluateZohoProductionOutputQueueEligibility", () => {
  it("allows APPROVED ready ops with no prior queue metadata", () => {
    const result = evaluateZohoProductionOutputQueueEligibility(QUEUE_READY);
    expect(result.eligible).toBe(true);
    expect(result.commitIdempotencyKey).toBe(
      "luma-production-output:luma-op-1:hash-a",
    );
  });

  it("blocks NOT_APPROVED, VOIDED, and hash mismatch", () => {
    expect(
      evaluateZohoProductionOutputQueueEligibility({
        ...QUEUE_READY,
        status: "PREVIEWED",
      }).eligible,
    ).toBe(false);
    expect(
      evaluateZohoProductionOutputQueueEligibility({
        ...QUEUE_READY,
        status: "VOIDED",
        voidedAt: new Date(),
      }).blockers.map((b) => b.code),
    ).toContain("VOIDED");
    expect(
      evaluateZohoProductionOutputQueueEligibility({
        ...QUEUE_READY,
        requestHash: "hash-b",
      }).blockers.map((b) => b.code),
    ).toContain("APPROVED_HASH_MISMATCH");
  });

  it("blocks non-HIGH metrics and genealogy", () => {
    expect(
      evaluateZohoProductionOutputQueueEligibility({
        ...QUEUE_READY,
        metricsState: "MISSING",
      }).blockers.map((b) => b.code),
    ).toContain("METRICS_NOT_HIGH");
    expect(
      evaluateZohoProductionOutputQueueEligibility({
        ...QUEUE_READY,
        genealogyState: "LOW",
      }).blockers.map((b) => b.code),
    ).toContain("GENEALOGY_NOT_HIGH");
  });

  it("blocks legacy assembly ops, committed ops, and already queued state", () => {
    const legacy = evaluateZohoProductionOutputQueueEligibility({
      ...QUEUE_READY,
      legacyAssemblyOpExists: true,
    });
    expect(legacy.blockers.map((b) => b.code)).toContain(
      "LEGACY_ASSEMBLY_OP_EXISTS",
    );

    const committed = evaluateZohoProductionOutputQueueEligibility({
      ...QUEUE_READY,
      committedOpExists: true,
    });
    expect(committed.blockers.map((b) => b.code)).toContain("ALREADY_COMMITTED");

    const queued = evaluateZohoProductionOutputQueueEligibility({
      ...QUEUE_READY,
      status: "QUEUED",
      commitRequestedAt: new Date(),
      commitIdempotencyKey: "luma-production-output:luma-op-1:hash-a",
    });
    expect(queued.eligible).toBe(false);
    expect(queued.blockers.map((b) => b.code)).toContain("ALREADY_QUEUED");
  });

  it("blocks mismatched commit idempotency keys", () => {
    const result = evaluateZohoProductionOutputQueueEligibility({
      ...QUEUE_READY,
      commitIdempotencyKey: "stale-key",
    });
    expect(result.blockers.map((b) => b.code)).toContain(
      "COMMIT_IDEMPOTENCY_MISMATCH",
    );
  });
});
