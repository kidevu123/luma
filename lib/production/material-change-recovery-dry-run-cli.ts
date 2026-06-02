/** RECOVERY-DRY-RUN-HARNESS-1 — CLI parsing and report formatting. */

import type {
  MaterialChangeRecoveryDryRunResult,
  MaterialChangeRecoveryInput,
  MaterialChangeRecoveryOldRollEndState,
  MaterialChangeRecoveryReason,
  MaterialChangeRecoveryRole,
} from "@/lib/production/material-change-recovery";

export const DRY_RUN_BANNER =
  "DRY RUN ONLY — no data was changed, no events were written, no read models were rebuilt.";

export type RecoveryDryRunCliArgs = {
  workflowBagId: string;
  stationId: string;
  oldRollLotId: string;
  newRollLotId: string;
  segmentCount: number;
  recoveryKind: MaterialChangeRecoveryOldRollEndState;
  materialRole: MaterialChangeRecoveryRole;
  reason: MaterialChangeRecoveryReason;
  requestedBy: string;
  requestedByRole?: string | null;
  boundaryWorkflowEventId?: string | null;
  eventBoundaryTimestamp?: string | null;
  endingWeightGrams?: number | null;
  minimumExpectedSegmentCount?: number | null;
  allowCounterReversal?: boolean;
  json: boolean;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASONS = new Set<MaterialChangeRecoveryReason>([
  "roll_exhausted",
  "material_swap",
  "machine_issue",
  "operator_correction",
  "historical_backfill",
  "temporary_removal",
]);

export function recoveryDryRunUsage(): string {
  return `Usage:
  npx tsx scripts/material-change-recovery-dry-run.ts \\
    --workflow-bag-id <uuid> \\
    --station-id <uuid> \\
    --old-roll-lot-id <uuid> \\
    --new-roll-lot-id <uuid> \\
    --segment-count <int> \\
    --recovery-kind partial_removed|depleted \\
    --material-role PVC|FOIL \\
    --reason <roll_exhausted|material_swap|machine_issue|operator_correction|historical_backfill|temporary_removal> \\
    --requested-by <user-or-operator-id> \\
    [--boundary-event-id <uuid>] \\
    [--event-boundary-timestamp <iso8601>] \\
    [--ending-weight-grams <int>] \\
    [--minimum-expected-segment-count <int>] \\
    [--allow-counter-reversal] \\
    [--json]

Exit codes:
  0 = dry-run generated (OK or WARNING)
  2 = planner BLOCKED the scenario
  1 = missing args or runtime failure`;
}

function readFlagValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function parseRecoveryDryRunCliArgs(
  argv: string[],
): { ok: true; args: RecoveryDryRunCliArgs } | { ok: false; error: string } {
  const workflowBagId = readFlagValue(argv, "--workflow-bag-id");
  const stationId = readFlagValue(argv, "--station-id");
  const oldRollLotId = readFlagValue(argv, "--old-roll-lot-id");
  const newRollLotId = readFlagValue(argv, "--new-roll-lot-id");
  const segmentCountRaw = readFlagValue(argv, "--segment-count");
  const recoveryKindRaw = readFlagValue(argv, "--recovery-kind");
  const materialRoleRaw = readFlagValue(argv, "--material-role");
  const reasonRaw = readFlagValue(argv, "--reason");
  const requestedBy = readFlagValue(argv, "--requested-by");

  const missing: string[] = [];
  if (!workflowBagId) missing.push("--workflow-bag-id");
  if (!stationId) missing.push("--station-id");
  if (!oldRollLotId) missing.push("--old-roll-lot-id");
  if (!newRollLotId) missing.push("--new-roll-lot-id");
  if (!segmentCountRaw) missing.push("--segment-count");
  if (!recoveryKindRaw) missing.push("--recovery-kind");
  if (!materialRoleRaw) missing.push("--material-role");
  if (!reasonRaw) missing.push("--reason");
  if (!requestedBy) missing.push("--requested-by");
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required arguments: ${missing.join(", ")}`,
    };
  }

  for (const [label, value] of [
    ["--workflow-bag-id", workflowBagId],
    ["--station-id", stationId],
    ["--old-roll-lot-id", oldRollLotId],
    ["--new-roll-lot-id", newRollLotId],
  ] as const) {
    if (!UUID_RE.test(value!)) {
      return { ok: false, error: `${label} must be a UUID.` };
    }
  }

  const segmentCount = Number(segmentCountRaw);
  if (!Number.isInteger(segmentCount) || segmentCount < 0) {
    return { ok: false, error: "--segment-count must be a nonnegative integer." };
  }

  let recoveryKind: MaterialChangeRecoveryOldRollEndState;
  if (recoveryKindRaw === "partial_removed") {
    recoveryKind = "removed_partial";
  } else if (recoveryKindRaw === "depleted") {
    recoveryKind = "depleted";
  } else {
    return {
      ok: false,
      error: "--recovery-kind must be partial_removed or depleted.",
    };
  }

  const materialRole = materialRoleRaw as MaterialChangeRecoveryRole;
  if (materialRole !== "PVC" && materialRole !== "FOIL") {
    return { ok: false, error: "--material-role must be PVC or FOIL." };
  }

  const reason = reasonRaw as MaterialChangeRecoveryReason;
  if (!REASONS.has(reason)) {
    return { ok: false, error: `--reason must be one of: ${[...REASONS].join(", ")}` };
  }

  const boundaryWorkflowEventId = readFlagValue(argv, "--boundary-event-id");
  if (boundaryWorkflowEventId && !UUID_RE.test(boundaryWorkflowEventId)) {
    return { ok: false, error: "--boundary-event-id must be a UUID." };
  }

  const eventBoundaryTimestamp = readFlagValue(argv, "--event-boundary-timestamp");
  if (!boundaryWorkflowEventId && !eventBoundaryTimestamp) {
    return {
      ok: false,
      error:
        "Provide --boundary-event-id or --event-boundary-timestamp for the recovery boundary.",
    };
  }

  const endingWeightRaw = readFlagValue(argv, "--ending-weight-grams");
  const minimumExpectedRaw = readFlagValue(argv, "--minimum-expected-segment-count");

  return {
    ok: true,
    args: {
      workflowBagId: workflowBagId!,
      stationId: stationId!,
      oldRollLotId: oldRollLotId!,
      newRollLotId: newRollLotId!,
      segmentCount,
      recoveryKind,
      materialRole,
      reason,
      requestedBy: requestedBy!,
      requestedByRole: readFlagValue(argv, "--requested-by-role"),
      boundaryWorkflowEventId,
      eventBoundaryTimestamp,
      endingWeightGrams:
        endingWeightRaw == null ? null : Number(endingWeightRaw),
      minimumExpectedSegmentCount:
        minimumExpectedRaw == null ? null : Number(minimumExpectedRaw),
      allowCounterReversal: hasFlag(argv, "--allow-counter-reversal"),
      json: hasFlag(argv, "--json"),
    },
  };
}

export function buildRecoveryInputFromCli(
  cli: RecoveryDryRunCliArgs,
  eventBoundaryTimestamp: Date,
): MaterialChangeRecoveryInput {
  return {
    workflowBagId: cli.workflowBagId,
    stationId: cli.stationId,
    eventBoundaryTimestamp,
    oldRollLotId: cli.oldRollLotId,
    newRollLotId: cli.newRollLotId,
    segmentCount: cli.segmentCount,
    materialRole: cli.materialRole,
    reason: cli.reason,
    oldRollEndState: cli.recoveryKind,
    requestedByUserId: cli.requestedBy,
    ...(cli.requestedByRole ? { requestedByRole: cli.requestedByRole } : {}),
    ...(cli.endingWeightGrams != null
      ? { endingWeightGrams: cli.endingWeightGrams }
      : {}),
    ...(cli.minimumExpectedSegmentCount != null
      ? { minimumExpectedSegmentCount: cli.minimumExpectedSegmentCount }
      : {}),
    ...(cli.allowCounterReversal ? { allowCounterReversal: true } : {}),
  };
}

export function recoveryDryRunExitCode(
  result: MaterialChangeRecoveryDryRunResult,
): 0 | 1 | 2 {
  if (result.eligibility === "BLOCKED") return 2;
  return 0;
}

export type RecoveryDryRunReport = {
  banner: string;
  eligibility: MaterialChangeRecoveryDryRunResult["eligibility"];
  input: MaterialChangeRecoveryInput;
  result: MaterialChangeRecoveryDryRunResult;
  meta: {
    boundaryResolvedFromEvent: boolean;
    eventBoundaryTimestamp: string;
  };
};

export function buildRecoveryDryRunReport(args: {
  input: MaterialChangeRecoveryInput;
  result: MaterialChangeRecoveryDryRunResult;
  boundaryResolvedFromEvent: boolean;
  eventBoundaryTimestamp: Date;
}): RecoveryDryRunReport {
  return {
    banner: DRY_RUN_BANNER,
    eligibility: args.result.eligibility,
    input: args.input,
    result: args.result,
    meta: {
      boundaryResolvedFromEvent: args.boundaryResolvedFromEvent,
      eventBoundaryTimestamp: args.eventBoundaryTimestamp.toISOString(),
    },
  };
}

export function formatRecoveryDryRunReportHuman(report: RecoveryDryRunReport): string {
  const lines: string[] = [
    report.banner,
    "",
    `Eligibility: ${report.eligibility}`,
    `Boundary: ${report.meta.eventBoundaryTimestamp}${
      report.meta.boundaryResolvedFromEvent ? " (from workflow event)" : ""
    }`,
    "",
    "Input:",
    `  workflow bag: ${report.input.workflowBagId}`,
    `  station: ${report.input.stationId}`,
    `  old roll lot: ${report.input.oldRollLotId}`,
    `  new roll lot: ${report.input.newRollLotId}`,
    `  segment count: ${report.input.segmentCount}`,
    `  material role: ${report.input.materialRole}`,
    `  recovery kind: ${report.input.oldRollEndState}`,
    `  reason: ${report.input.reason}`,
  ];

  if (report.result.blockers.length > 0) {
    lines.push("", "Blockers:");
    for (const blocker of report.result.blockers) {
      lines.push(`  - [${blocker.code}] ${blocker.message}`);
    }
  }

  if (report.result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.result.warnings) {
      lines.push(`  - [${warning.code}] ${warning.message}`);
    }
  }

  lines.push("", "Before state:");
  lines.push(
    `  old roll: ${report.result.beforeState.oldRoll?.rollNumber ?? "missing"} (${report.result.beforeState.oldRoll?.status ?? "—"})`,
  );
  lines.push(
    `  new roll: ${report.result.beforeState.newRoll?.rollNumber ?? "missing"} (${report.result.beforeState.newRoll?.status ?? "—"})`,
  );
  lines.push(
    `  active rolls at boundary: ${report.result.beforeState.activeRollsAtBoundary
      .map((roll) => `${roll.role}:${roll.rollNumber ?? roll.lotId}`)
      .join(", ") || "none"}`,
  );

  lines.push("", "After-state preview:");
  lines.push(
    `  old roll status: ${report.result.afterStatePreview.expectedOldRollStatus ?? "—"}`,
  );
  lines.push(
    `  new roll status: ${report.result.afterStatePreview.expectedNewRollStatus ?? "—"}`,
  );
  lines.push(
    `  segment attribution old: ${report.result.afterStatePreview.segmentAttribution.oldRoll?.count ?? "—"}`,
  );
  lines.push(
    `  segment attribution paired: ${report.result.afterStatePreview.segmentAttribution.pairedRoll?.count ?? "—"}`,
  );
  lines.push(
    `  replacement prior count: ${report.result.afterStatePreview.segmentAttribution.replacementRoll?.count ?? 0}`,
  );

  if (report.result.proposedEvents.length > 0) {
    lines.push("", "Proposed preview events (NOT PERSISTED):");
    for (const event of report.result.proposedEvents) {
      lines.push(
        `  - ${event.eventType} role=${event.role} lot=${event.packagingLotId} previewOnly=${event.previewOnly}`,
      );
    }
  } else {
    lines.push("", "Proposed preview events: none (blocked or invalid input).");
  }

  if (report.result.affectedReadModels.length > 0) {
    lines.push("", "Affected read models if apply existed:");
    for (const model of report.result.affectedReadModels) {
      lines.push(`  - ${model}`);
    }
  }

  lines.push("", "Next steps:");
  if (report.eligibility === "BLOCKED") {
    lines.push(
      "  - Do not attempt floor repair. Escalate to Sahil with this dry-run output.",
    );
    lines.push("  - No apply path is shipped. This report is preview-only.");
  } else {
    lines.push(
      "  - Review warnings and proposed preview events with a supervisor.",
    );
    lines.push("  - Apply is not shipped. Do not manually edit production data.");
  }

  return lines.join("\n");
}

export function formatRecoveryDryRunReportJson(report: RecoveryDryRunReport): string {
  return JSON.stringify(
    {
      banner: report.banner,
      eligibility: report.eligibility,
      input: report.input,
      blockers: report.result.blockers,
      warnings: report.result.warnings,
      beforeState: report.result.beforeState,
      afterStatePreview: report.result.afterStatePreview,
      proposedEvents: report.result.proposedEvents,
      affectedReadModels: report.result.affectedReadModels,
      meta: report.meta,
      previewOnly: true,
      willPersist: false,
    },
    null,
    2,
  );
}
