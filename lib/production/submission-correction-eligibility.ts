// Eligibility guards for admin submission corrections.

export type SubmissionCorrectionBlocker = {
  code: string;
  message: string;
};

export type SubmissionCorrectionEligibility = {
  eligible: boolean;
  blockers: SubmissionCorrectionBlocker[];
  warnings: SubmissionCorrectionBlocker[];
};

export function evaluateSubmissionCorrectionEligibility(args: {
  eventType: string;
  isCorrectableEventType: boolean;
  zohoOutputCommitted: boolean;
  hasFinishedLot: boolean;
}): SubmissionCorrectionEligibility {
  const blockers: SubmissionCorrectionBlocker[] = [];
  const warnings: SubmissionCorrectionBlocker[] = [];

  if (!args.isCorrectableEventType) {
    blockers.push({
      code: "NOT_CORRECTABLE_EVENT",
      message: "This event type cannot be corrected from workflow submissions.",
    });
  }

  if (args.zohoOutputCommitted) {
    blockers.push({
      code: "ZOHO_OUTPUT_COMMITTED",
      message:
        "Zoho production output is already committed for this bag. Use wrong-route recovery or external Zoho correction before changing submission numbers.",
    });
  }

  if (args.hasFinishedLot && !args.zohoOutputCommitted) {
    warnings.push({
      code: "FINISHED_LOT_NEEDS_REVIEW",
      message:
        "A finished lot exists for this bag. Corrected counts will mark the lot and Zoho output for admin review.",
    });
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    warnings,
  };
}
