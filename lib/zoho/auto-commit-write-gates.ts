// ZOHO-STAGING-BUFFER-v1.1.0 — env-driven gates the cron uses to
// decide whether it's allowed to ATTEMPT a commit at all.
//
// The point of pre-checking here (rather than letting the shared
// commit fn discover the guard later) is to AVOID claiming the row.
// Once a row is claimed, the shared commit fn increments
// commit_attempt_count even on guard-blocked failures, which would
// burn retry budget for an operator-corrected env flag. The cron
// therefore inspects the env upfront and SKIPS rows without claiming
// when the env says writes are disabled. The auto-commit master
// switch (ZOHO_AUTO_COMMIT_ENABLED) is the broadest gate; if that's
// off, the cron is a no-op for every row.

import { isProductionOutputCommitEnabled } from "@/lib/zoho/production-output-config";
import { resolveZohoAutoCommitBufferConfig } from "@/lib/zoho/zoho-auto-commit-buffer-config";

export const ZOHO_DRY_RUN_WRITES_ENABLED_ENV = "ZOHO_DRY_RUN_WRITES_ENABLED";
export const ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED_ENV =
  "ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED";

export type AutoCommitWriteGates = {
  /** Master switch — if false, every row is skipped. */
  autoCommitEnabled: boolean;
  /** Raw-bag receive commits can land at the gateway. */
  rawBagWritesAllowed: boolean;
  /** Production-output commits can land at the gateway. */
  productionOutputWritesAllowed: boolean;
  /** Per-gate diagnostics for the cron's audit summary. */
  reasons: {
    autoCommit?: string;
    rawBag?: string;
    productionOutput?: string;
  };
};

export function resolveAutoCommitWriteGates(
  env: Record<string, string | undefined> = process.env,
): AutoCommitWriteGates {
  const reasons: AutoCommitWriteGates["reasons"] = {};

  const buffer = resolveZohoAutoCommitBufferConfig(env);
  const autoCommitEnabled = buffer.enabled;
  if (!autoCommitEnabled) {
    reasons.autoCommit = "ZOHO_AUTO_COMMIT_ENABLED is not 'true'.";
  }

  // Raw-bag commit goes through callBagFinishReceiveCommit, which
  // refuses unless ZOHO_DRY_RUN_WRITES_ENABLED=true. We mirror that
  // here so the cron can skip without claiming.
  const dryRunWrites = env[ZOHO_DRY_RUN_WRITES_ENABLED_ENV] === "true";
  // The bag-finish-receive-client also consults
  // ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED via the requireLiveWriteGate
  // path — when that flag is true, the writes-gate guard is OFF (which
  // is the desired state for live commits). We treat the raw-bag
  // gateway as live-allowed when dry-run is on; the actual gateway
  // call enforces both flags.
  const rawBagWritesAllowed = dryRunWrites;
  if (!rawBagWritesAllowed) {
    reasons.rawBag = `${ZOHO_DRY_RUN_WRITES_ENABLED_ENV} is not 'true'.`;
  }

  // Production-output is gated by the persist/preview/commit chain in
  // production-output-config.ts. The commit gate requires all three.
  const productionOutputWritesAllowed = isProductionOutputCommitEnabled(env);
  if (!productionOutputWritesAllowed) {
    reasons.productionOutput =
      "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED chain is not satisfied.";
  }

  return {
    autoCommitEnabled,
    rawBagWritesAllowed,
    productionOutputWritesAllowed,
    reasons,
  };
}
