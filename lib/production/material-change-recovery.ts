export type MaterialChangeRecoveryRole = "PVC" | "FOIL";

export type MaterialChangeRecoveryReason =
  | "roll_exhausted"
  | "material_swap"
  | "machine_issue"
  | "operator_correction"
  | "historical_backfill"
  | "temporary_removal";

export type MaterialChangeRecoveryOldRollEndState =
  | "depleted"
  | "removed_partial";

export type MaterialChangeRecoveryEligibility = "OK" | "WARNING" | "BLOCKED";

export type MaterialChangeRecoveryBlockerCode =
  | "MISSING_WORKFLOW_BAG"
  | "MISSING_STATION"
  | "MISSING_OLD_ROLL"
  | "MISSING_NEW_ROLL"
  | "SAME_OLD_NEW_ROLL"
  | "INVALID_SEGMENT_COUNT"
  | "COUNTER_REVERSAL_UNSUPPORTED"
  | "OLD_ROLL_NOT_ACTIVE_AT_BOUNDARY"
  | "NEW_ROLL_ACTIVE_CONFLICT"
  | "AMBIGUOUS_ACTIVE_ROLLS"
  | "DUPLICATE_SEGMENT_RISK"
  | "FINALIZED_BAG_BOUNDARY"
  | "FINISHED_LOT_BOUNDARY"
  | "MISSING_REASON"
  | "MISSING_REQUESTER";

export type MaterialChangeRecoveryWarningCode =
  | "ENDING_WEIGHT_MISSING_FOR_PARTIAL"
  | "LEGACY_OR_INCOMPLETE_LINEAGE"
  | "BOUNDARY_EVENT_NOT_LINKED"
  | "READ_MODEL_REBUILD_REQUIRED"
  | "OLD_ROLL_STATUS_SUSPECT";

export type MaterialChangeRecoveryReadModelImpact =
  | "read_roll_usage"
  | "read_material_lot_state"
  | "finished_lot_packaging_genealogy"
  | "material_reconciliation";

export type MaterialChangeRecoveryRollState = {
  lotId: string;
  rollNumber?: string | null;
  role: MaterialChangeRecoveryRole;
  status: "AVAILABLE" | "IN_USE" | "DEPLETED" | "HELD" | "SCRAPPED" | string;
  activeAtBoundary: boolean;
  stationId?: string | null;
  machineId?: string | null;
  segmentTotal?: number | null;
};

export type MaterialChangeRecoveryWorkflowBagState = {
  id: string;
  finalizedAt?: string | Date | null;
  finishedLotIds?: string[];
  isLegacy?: boolean;
  lineageState?: "HIGH" | "LOW" | "MISSING";
};

export type MaterialChangeRecoveryStationState = {
  id: string;
  machineId?: string | null;
};

export type MaterialChangeRecoveryExistingSegment = {
  workflowBagId: string;
  packagingLotId: string;
  role: MaterialChangeRecoveryRole;
  segmentCount: number;
  segmentReason?: string | null;
  oldLotId?: string | null;
  newLotId?: string | null;
  occurredAt?: string | Date | null;
};

export type MaterialChangeRecoveryInput = {
  workflowBagId: string;
  stationId: string;
  eventBoundaryTimestamp: string | Date;
  oldRollLotId: string;
  newRollLotId: string;
  segmentCount: unknown;
  materialRole: MaterialChangeRecoveryRole;
  reason?: MaterialChangeRecoveryReason | "" | null;
  oldRollEndState: MaterialChangeRecoveryOldRollEndState;
  requestedByUserId?: string | null;
  requestedByRole?: string | null;
  endingWeightGrams?: number | null;
  minimumExpectedSegmentCount?: number | null;
  allowCounterReversal?: boolean;
};

export type MaterialChangeRecoveryContext = {
  workflowBag?: MaterialChangeRecoveryWorkflowBagState | null;
  station?: MaterialChangeRecoveryStationState | null;
  rolls: MaterialChangeRecoveryRollState[];
  activeRollsAtBoundary: MaterialChangeRecoveryRollState[];
  existingSegments?: MaterialChangeRecoveryExistingSegment[];
  boundaryWorkflowEventId?: string | null;
};

export type MaterialChangeRecoveryIssue<
  Code extends MaterialChangeRecoveryBlockerCode | MaterialChangeRecoveryWarningCode,
> = {
  code: Code;
  message: string;
};

export type MaterialChangeRecoveryPreviewEvent =
  | {
      previewOnly: true;
      willPersist: false;
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED";
      role: MaterialChangeRecoveryRole;
      packagingLotId: string;
      workflowBagId: string;
      stationId: string;
      counterSegmentCount: number;
      segmentReason: "RECOVERY_ROLL_CHANGE";
      payloadPreview: {
        recovery_reason: MaterialChangeRecoveryReason;
        old_roll_end_state: MaterialChangeRecoveryOldRollEndState;
        old_lot_id: string;
        new_lot_id: string;
        replacement_receives_prior_count: false;
      };
    }
  | {
      previewOnly: true;
      willPersist: false;
      eventType: "ROLL_UNMOUNTED" | "ROLL_DEPLETED" | "ROLL_MOUNTED";
      role: MaterialChangeRecoveryRole;
      packagingLotId: string;
      workflowBagId: string;
      stationId: string;
      payloadPreview: {
        recovery_reason: MaterialChangeRecoveryReason;
        old_roll_end_state: MaterialChangeRecoveryOldRollEndState;
        old_lot_id: string;
        new_lot_id: string;
        ending_weight_grams?: number | null;
        replacement_receives_prior_count: false;
      };
    };

export type MaterialChangeRecoveryDryRunResult = {
  eligibility: MaterialChangeRecoveryEligibility;
  blockers: Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryBlockerCode>>;
  warnings: Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryWarningCode>>;
  proposedEvents: MaterialChangeRecoveryPreviewEvent[];
  beforeState: {
    workflowBag: MaterialChangeRecoveryWorkflowBagState | null;
    station: MaterialChangeRecoveryStationState | null;
    oldRoll: MaterialChangeRecoveryRollState | null;
    newRoll: MaterialChangeRecoveryRollState | null;
    activePairedRoll: MaterialChangeRecoveryRollState | null;
    activeRollsAtBoundary: MaterialChangeRecoveryRollState[];
  };
  afterStatePreview: {
    expectedOldRollStatus: "AVAILABLE" | "DEPLETED" | null;
    expectedNewRollStatus: "IN_USE" | null;
    expectedActiveRolls: Array<{
      lotId: string;
      role: MaterialChangeRecoveryRole;
      source: "existing" | "replacement";
    }>;
    segmentAttribution: {
      oldRoll: { lotId: string; count: number } | null;
      pairedRoll: { lotId: string; count: number } | null;
      replacementRoll: { lotId: string; count: 0 } | null;
    };
  };
  affectedReadModels: MaterialChangeRecoveryReadModelImpact[];
};

export function planMaterialChangeRecovery(
  input: MaterialChangeRecoveryInput,
  context: MaterialChangeRecoveryContext,
): MaterialChangeRecoveryDryRunResult {
  const segmentCount = normalizeSegmentCount(input.segmentCount);
  const workflowBag = context.workflowBag?.id === input.workflowBagId
    ? context.workflowBag
    : null;
  const station = context.station?.id === input.stationId ? context.station : null;
  const oldRoll = context.rolls.find((r) => r.lotId === input.oldRollLotId) ?? null;
  const newRoll = context.rolls.find((r) => r.lotId === input.newRollLotId) ?? null;
  const activeSameRole = context.activeRollsAtBoundary.filter(
    (r) => r.role === input.materialRole,
  );
  const activeOtherRole = context.activeRollsAtBoundary.filter(
    (r) => r.role !== input.materialRole,
  );
  const activePairedRoll = activeOtherRole.length === 1 ? activeOtherRole[0]! : null;
  const blockers = detectRecoveryBlockers({
    input,
    context,
    segmentCount,
    workflowBag,
    station,
    oldRoll,
    newRoll,
    activeSameRole,
    activeOtherRole,
  });
  const warnings = detectRecoveryWarnings({
    input,
    context,
    workflowBag,
    oldRoll,
  });
  const proposedEvents =
    blockers.length === 0 && segmentCount != null && workflowBag && station && oldRoll && newRoll
      ? buildRecoveryPreviewEvents({
          input,
          segmentCount,
          oldRoll,
          newRoll,
          pairedRoll: activePairedRoll,
        })
      : [];
  const eligibility: MaterialChangeRecoveryEligibility =
    blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "WARNING" : "OK";

  return {
    eligibility,
    blockers,
    warnings,
    proposedEvents,
    beforeState: {
      workflowBag,
      station,
      oldRoll,
      newRoll,
      activePairedRoll,
      activeRollsAtBoundary: [...context.activeRollsAtBoundary],
    },
    afterStatePreview: buildAfterStatePreview({
      input,
      context,
      segmentCount,
      oldRoll,
      newRoll,
      pairedRoll: activePairedRoll,
      blockers,
    }),
    affectedReadModels: summarizeRecoveryReadModelImpact(workflowBag),
  };
}

function normalizeSegmentCount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }
  return null;
}

function detectRecoveryBlockers(args: {
  input: MaterialChangeRecoveryInput;
  context: MaterialChangeRecoveryContext;
  segmentCount: number | null;
  workflowBag: MaterialChangeRecoveryWorkflowBagState | null;
  station: MaterialChangeRecoveryStationState | null;
  oldRoll: MaterialChangeRecoveryRollState | null;
  newRoll: MaterialChangeRecoveryRollState | null;
  activeSameRole: MaterialChangeRecoveryRollState[];
  activeOtherRole: MaterialChangeRecoveryRollState[];
}): Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryBlockerCode>> {
  const {
    input,
    context,
    segmentCount,
    workflowBag,
    station,
    oldRoll,
    newRoll,
    activeSameRole,
    activeOtherRole,
  } = args;
  const blockers: Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryBlockerCode>> = [];
  if (!workflowBag) {
    blockers.push({
      code: "MISSING_WORKFLOW_BAG",
      message: "Workflow bag is missing; recovery cannot attach material history.",
    });
  }
  if (!station) {
    blockers.push({
      code: "MISSING_STATION",
      message: "Station is missing; recovery cannot resolve the machine boundary.",
    });
  }
  if (!oldRoll) {
    blockers.push({
      code: "MISSING_OLD_ROLL",
      message: "Old roll lot is missing.",
    });
  }
  if (!newRoll) {
    blockers.push({
      code: "MISSING_NEW_ROLL",
      message: "Replacement roll lot is missing.",
    });
  }
  if (input.oldRollLotId === input.newRollLotId) {
    blockers.push({
      code: "SAME_OLD_NEW_ROLL",
      message: "Old roll and replacement roll cannot be the same lot.",
    });
  }
  if (segmentCount == null) {
    blockers.push({
      code: "INVALID_SEGMENT_COUNT",
      message: "Segment count must be a nonnegative whole number.",
    });
  }
  if (
    segmentCount != null &&
    input.minimumExpectedSegmentCount != null &&
    segmentCount < input.minimumExpectedSegmentCount &&
    !input.allowCounterReversal
  ) {
    blockers.push({
      code: "COUNTER_REVERSAL_UNSUPPORTED",
      message:
        "Segment count is lower than the expected boundary and no reversal policy is enabled.",
    });
  }
  if (oldRoll && !activeSameRole.some((r) => r.lotId === oldRoll.lotId)) {
    blockers.push({
      code: "OLD_ROLL_NOT_ACTIVE_AT_BOUNDARY",
      message: "Old roll was not the active roll for this role at the proposed boundary.",
    });
  }
  if (newRoll?.activeAtBoundary) {
    blockers.push({
      code: "NEW_ROLL_ACTIVE_CONFLICT",
      message: "Replacement roll is already active at the proposed boundary.",
    });
  }
  if (activeSameRole.length !== 1 || activeOtherRole.length > 1) {
    blockers.push({
      code: "AMBIGUOUS_ACTIVE_ROLLS",
      message:
        "Active roll state at the boundary is ambiguous for this station/machine.",
    });
  }
  if (
    segmentCount != null &&
    oldRoll &&
    context.existingSegments?.some(
      (s) =>
        s.workflowBagId === input.workflowBagId &&
        s.packagingLotId === oldRoll.lotId &&
        s.role === input.materialRole &&
        s.segmentCount === segmentCount &&
        (s.oldLotId == null || s.oldLotId === input.oldRollLotId) &&
        (s.newLotId == null || s.newLotId === input.newRollLotId),
    )
  ) {
    blockers.push({
      code: "DUPLICATE_SEGMENT_RISK",
      message:
        "An equivalent segment already exists for this bag/roll/count; appending would risk double-counting.",
    });
  }
  if (workflowBag?.finalizedAt) {
    blockers.push({
      code: "FINALIZED_BAG_BOUNDARY",
      message: "Workflow bag is finalized; recovery across this boundary needs higher approval.",
    });
  }
  if ((workflowBag?.finishedLotIds?.length ?? 0) > 0) {
    blockers.push({
      code: "FINISHED_LOT_BOUNDARY",
      message:
        "Workflow bag contributes to a finished lot; dry-run apply is blocked for now.",
    });
  }
  if (!input.reason) {
    blockers.push({
      code: "MISSING_REASON",
      message: "Correction reason is required.",
    });
  }
  if (!input.requestedByUserId && !input.requestedByRole) {
    blockers.push({
      code: "MISSING_REQUESTER",
      message: "Requester identity metadata is required for recovery preview.",
    });
  }
  return blockers;
}

function detectRecoveryWarnings(args: {
  input: MaterialChangeRecoveryInput;
  context: MaterialChangeRecoveryContext;
  workflowBag: MaterialChangeRecoveryWorkflowBagState | null;
  oldRoll: MaterialChangeRecoveryRollState | null;
}): Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryWarningCode>> {
  const warnings: Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryWarningCode>> = [];
  if (args.input.oldRollEndState === "removed_partial" && args.input.endingWeightGrams == null) {
    warnings.push({
      code: "ENDING_WEIGHT_MISSING_FOR_PARTIAL",
      message:
        "Ending weight is missing for a partial roll; later actual weight confidence may remain lower.",
    });
  }
  if (
    args.workflowBag?.isLegacy ||
    args.workflowBag?.lineageState === "LOW" ||
    args.workflowBag?.lineageState === "MISSING"
  ) {
    warnings.push({
      code: "LEGACY_OR_INCOMPLETE_LINEAGE",
      message: "Bag lineage is legacy or incomplete; preview must keep that uncertainty visible.",
    });
  }
  if (!args.context.boundaryWorkflowEventId) {
    warnings.push({
      code: "BOUNDARY_EVENT_NOT_LINKED",
      message: "Boundary is not linked to a known workflow event.",
    });
  }
  warnings.push({
    code: "READ_MODEL_REBUILD_REQUIRED",
    message: "Applying this recovery would require material and genealogy read-model rebuilds.",
  });
  if (args.oldRoll && (args.oldRoll.status === "AVAILABLE" || args.oldRoll.status === "DEPLETED")) {
    warnings.push({
      code: "OLD_ROLL_STATUS_SUSPECT",
      message:
        "Old roll current status suggests prior manual correction or a later lifecycle event.",
    });
  }
  return warnings;
}

function buildRecoveryPreviewEvents(args: {
  input: MaterialChangeRecoveryInput;
  segmentCount: number;
  oldRoll: MaterialChangeRecoveryRollState;
  newRoll: MaterialChangeRecoveryRollState;
  pairedRoll: MaterialChangeRecoveryRollState | null;
}): MaterialChangeRecoveryPreviewEvent[] {
  const basePayload = {
    recovery_reason: args.input.reason as MaterialChangeRecoveryReason,
    old_roll_end_state: args.input.oldRollEndState,
    old_lot_id: args.oldRoll.lotId,
    new_lot_id: args.newRoll.lotId,
    replacement_receives_prior_count: false as const,
  };
  const segmentEvents: MaterialChangeRecoveryPreviewEvent[] = [
    {
      previewOnly: true,
      willPersist: false,
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      role: args.oldRoll.role,
      packagingLotId: args.oldRoll.lotId,
      workflowBagId: args.input.workflowBagId,
      stationId: args.input.stationId,
      counterSegmentCount: args.segmentCount,
      segmentReason: "RECOVERY_ROLL_CHANGE",
      payloadPreview: basePayload,
    },
  ];
  if (args.pairedRoll) {
    segmentEvents.push({
      previewOnly: true,
      willPersist: false,
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      role: args.pairedRoll.role,
      packagingLotId: args.pairedRoll.lotId,
      workflowBagId: args.input.workflowBagId,
      stationId: args.input.stationId,
      counterSegmentCount: args.segmentCount,
      segmentReason: "RECOVERY_ROLL_CHANGE",
      payloadPreview: basePayload,
    });
  }
  const oldRollLifecycleEvent: MaterialChangeRecoveryPreviewEvent = {
    previewOnly: true,
    willPersist: false,
    eventType:
      args.input.oldRollEndState === "depleted" ? "ROLL_DEPLETED" : "ROLL_UNMOUNTED",
    role: args.oldRoll.role,
    packagingLotId: args.oldRoll.lotId,
    workflowBagId: args.input.workflowBagId,
    stationId: args.input.stationId,
    payloadPreview: {
      ...basePayload,
      ending_weight_grams: args.input.endingWeightGrams ?? null,
    },
  };
  const replacementMountEvent: MaterialChangeRecoveryPreviewEvent = {
    previewOnly: true,
    willPersist: false,
    eventType: "ROLL_MOUNTED",
    role: args.newRoll.role,
    packagingLotId: args.newRoll.lotId,
    workflowBagId: args.input.workflowBagId,
    stationId: args.input.stationId,
    payloadPreview: basePayload,
  };
  return [...segmentEvents, oldRollLifecycleEvent, replacementMountEvent];
}

function buildAfterStatePreview(args: {
  input: MaterialChangeRecoveryInput;
  context: MaterialChangeRecoveryContext;
  segmentCount: number | null;
  oldRoll: MaterialChangeRecoveryRollState | null;
  newRoll: MaterialChangeRecoveryRollState | null;
  pairedRoll: MaterialChangeRecoveryRollState | null;
  blockers: Array<MaterialChangeRecoveryIssue<MaterialChangeRecoveryBlockerCode>>;
}): MaterialChangeRecoveryDryRunResult["afterStatePreview"] {
  const canPreview = args.blockers.length === 0 && args.segmentCount != null;
  const expectedActiveRolls = canPreview && args.newRoll
    ? [
        ...args.context.activeRollsAtBoundary
          .filter((r) => r.role !== args.input.materialRole)
          .map((r) => ({
            lotId: r.lotId,
            role: r.role,
            source: "existing" as const,
          })),
        {
          lotId: args.newRoll.lotId,
          role: args.input.materialRole,
          source: "replacement" as const,
        },
      ]
    : [];
  return {
    expectedOldRollStatus: canPreview
      ? args.input.oldRollEndState === "depleted"
        ? "DEPLETED"
        : "AVAILABLE"
      : null,
    expectedNewRollStatus: canPreview ? "IN_USE" : null,
    expectedActiveRolls,
    segmentAttribution: {
      oldRoll:
        canPreview && args.oldRoll && args.segmentCount != null
          ? { lotId: args.oldRoll.lotId, count: args.segmentCount }
          : null,
      pairedRoll:
        canPreview && args.pairedRoll && args.segmentCount != null
          ? { lotId: args.pairedRoll.lotId, count: args.segmentCount }
          : null,
      replacementRoll:
        canPreview && args.newRoll ? { lotId: args.newRoll.lotId, count: 0 } : null,
    },
  };
}

function summarizeRecoveryReadModelImpact(
  workflowBag: MaterialChangeRecoveryWorkflowBagState | null,
): MaterialChangeRecoveryReadModelImpact[] {
  const impacts: MaterialChangeRecoveryReadModelImpact[] = [
    "read_roll_usage",
    "read_material_lot_state",
    "material_reconciliation",
  ];
  if (workflowBag) impacts.push("finished_lot_packaging_genealogy");
  return impacts;
}
