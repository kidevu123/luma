#!/usr/bin/env npx tsx
/**
 * RECOVERY-DRY-RUN-HARNESS-1 — read-only material-change recovery preview.
 *
 * Usage:
 *   npx tsx scripts/material-change-recovery-dry-run.ts --help
 *
 * SELECT-only. No writes. No apply path.
 */

import { db } from "@/lib/db";
import { planMaterialChangeRecovery } from "@/lib/production/material-change-recovery";
import { loadMaterialChangeRecoveryContext } from "@/lib/production/material-change-recovery-loader";
import {
  buildRecoveryDryRunReport,
  buildRecoveryInputFromCli,
  formatRecoveryDryRunReportHuman,
  formatRecoveryDryRunReportJson,
  parseRecoveryDryRunCliArgs,
  recoveryDryRunExitCode,
  recoveryDryRunUsage,
} from "@/lib/production/material-change-recovery-dry-run-cli";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(recoveryDryRunUsage());
    return 0;
  }

  const parsed = parseRecoveryDryRunCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error("");
    console.error(recoveryDryRunUsage());
    return 1;
  }

  const loaded = await loadMaterialChangeRecoveryContext(db, {
    workflowBagId: parsed.args.workflowBagId,
    stationId: parsed.args.stationId,
    oldRollLotId: parsed.args.oldRollLotId,
    newRollLotId: parsed.args.newRollLotId,
    boundaryWorkflowEventId: parsed.args.boundaryWorkflowEventId ?? null,
    eventBoundaryTimestamp: parsed.args.eventBoundaryTimestamp ?? null,
  });

  const input = buildRecoveryInputFromCli(
    parsed.args,
    loaded.eventBoundaryTimestamp,
  );
  const result = planMaterialChangeRecovery(input, loaded.context);
  const report = buildRecoveryDryRunReport({
    input,
    result,
    boundaryResolvedFromEvent: loaded.boundaryResolvedFromEvent,
    eventBoundaryTimestamp: loaded.eventBoundaryTimestamp,
  });

  if (parsed.args.json) {
    console.log(formatRecoveryDryRunReportJson(report));
  } else {
    console.log(formatRecoveryDryRunReportHuman(report));
  }

  return recoveryDryRunExitCode(result);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
