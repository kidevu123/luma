import { describe, expect, it } from "vitest";
import {
  buildCorrectedValueFromFields,
  buildOriginalValueSnapshot,
} from "@/lib/production/submission-correction-fields";
import {
  buildLatestSubmissionCorrectionByTarget,
  mergeCorrectedSubmissionPayload,
  resolveEffectiveEventPayload,
} from "@/lib/production/submission-correction-effective";
import { computePackagingCountsFromEvents } from "@/lib/projector/bag-metrics-snapshot";
import { evaluateSubmissionCorrectionEligibility } from "@/lib/production/submission-correction-eligibility";
import { evaluateWorkflowRecoveryEligibility } from "@/lib/production/workflow-recovery";

describe("submission correction effective payloads", () => {
  const packagingEventId = "evt-pack-1";
  const events = [
    {
      id: packagingEventId,
      eventType: "PACKAGING_COMPLETE",
      occurredAt: "2026-06-01T10:00:00Z",
      payload: {
        master_cases: 19,
        displays_made: 2,
        loose_cards: 0,
      },
    },
    {
      id: "evt-corr-1",
      eventType: "SUBMISSION_CORRECTED",
      occurredAt: "2026-06-01T11:00:00Z",
      payload: {
        corrected_event_id: packagingEventId,
        corrected_value: { master_cases: 10 },
      },
    },
  ];

  it("latest correction overrides master_cases for metrics projection", () => {
    const counts = computePackagingCountsFromEvents(events);
    expect(counts.masterCases).toBe(10);
    expect(counts.displaysMade).toBe(2);
  });

  it("chains corrections — latest wins", () => {
    const chained = [
      ...events,
      {
        id: "evt-corr-2",
        eventType: "SUBMISSION_CORRECTED",
        occurredAt: "2026-06-01T12:00:00Z",
        payload: {
          corrected_event_id: packagingEventId,
          corrected_value: { master_cases: 12 },
        },
      },
    ];
    expect(computePackagingCountsFromEvents(chained).masterCases).toBe(12);
  });

  it("resolveEffectiveEventPayload merges corrected fields", () => {
    const map = buildLatestSubmissionCorrectionByTarget(events);
    const effective = resolveEffectiveEventPayload(events[0]!, map);
    expect(effective["master_cases"]).toBe(10);
  });

  it("uses stable idempotency unrelated — field builder for PO 69 style packaging", () => {
    const original = { master_cases: 19, displays_made: 0, loose_cards: 0 };
    const corrected = buildCorrectedValueFromFields(
      "PACKAGING_COMPLETE",
      original,
      { master_cases: 10, displays_made: 0, loose_cards: 0 },
    );
    expect(corrected).toEqual({ master_cases: 10 });
    expect(buildOriginalValueSnapshot("PACKAGING_COMPLETE", original)).toEqual({
      master_cases: 19,
      displays_made: 0,
      loose_cards: 0,
    });
  });
});

describe("submission correction eligibility", () => {
  it("blocks when Zoho output committed", () => {
    const r = evaluateSubmissionCorrectionEligibility({
      eventType: "PACKAGING_COMPLETE",
      isCorrectableEventType: true,
      zohoOutputCommitted: true,
      hasFinishedLot: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.blockers.some((b) => b.code === "ZOHO_OUTPUT_COMMITTED")).toBe(true);
  });

  it("warns when finished lot exists without committed Zoho", () => {
    const r = evaluateSubmissionCorrectionEligibility({
      eventType: "PACKAGING_COMPLETE",
      isCorrectableEventType: true,
      zohoOutputCommitted: false,
      hasFinishedLot: true,
    });
    expect(r.eligible).toBe(true);
    expect(r.warnings.some((b) => b.code === "FINISHED_LOT_NEEDS_REVIEW")).toBe(true);
  });
});

describe("workflow recovery eligibility", () => {
  it("allows reset when not finalized and no finished lot", () => {
    const r = evaluateWorkflowRecoveryEligibility({
      alreadyRecovered: false,
      zohoOutputCommitted: false,
      isFinalized: false,
      finishedLotExists: false,
    });
    expect(r.eligible).toBe(true);
    expect(r.resetAllowed).toBe(true);
  });

  it("blocks simple reset when finalized", () => {
    const r = evaluateWorkflowRecoveryEligibility({
      alreadyRecovered: false,
      zohoOutputCommitted: false,
      isFinalized: true,
      finishedLotExists: false,
    });
    expect(r.resetAllowed).toBe(false);
    expect(r.recoveryStatus).toBe("VOIDED_FROM_OUTPUT");
  });

  it("marks external recovery when Zoho committed", () => {
    const r = evaluateWorkflowRecoveryEligibility({
      alreadyRecovered: false,
      zohoOutputCommitted: true,
      isFinalized: true,
      finishedLotExists: true,
    });
    expect(r.recoveryStatus).toBe("EXTERNAL_RECOVERY_REQUIRED");
    expect(r.resetAllowed).toBe(false);
  });
});

describe("mergeCorrectedSubmissionPayload", () => {
  it("preserves untouched fields", () => {
    const merged = mergeCorrectedSubmissionPayload(
      { master_cases: 19, displays_made: 5 },
      { master_cases: 10 },
    );
    expect(merged).toEqual({ master_cases: 10, displays_made: 5 });
  });
});
