// ZOHO-STAGING-BUFFER-v1.1.0 — env-driven knobs for the auto-commit buffer.
//
// Two flags, both read at runtime so the cron and the seed paths see
// the same truth on every call:
//
//   ZOHO_AUTO_COMMIT_ENABLED         — master switch. "false" (or unset)
//                                       means seeded rows get NO
//                                       auto_commit_eligible_at and
//                                       the cron skips everything. Manual
//                                       commit-now still works.
//
//   ZOHO_AUTO_COMMIT_BUFFER_HOURS    — review window before auto-commit.
//                                       Default 24. Set to 0 in dev /
//                                       staging when you want immediate
//                                       auto-commit on seed.
//
// Bounds: 0 ≤ buffer ≤ 168 (one week). Beyond a week is almost
// certainly a misconfiguration — the staged op is supposed to be
// reviewed within the review window, not park indefinitely. If your
// real review SLA is longer, set ZOHO_AUTO_COMMIT_ENABLED=false and
// do manual commits.

export const ZOHO_AUTO_COMMIT_ENABLED_ENV = "ZOHO_AUTO_COMMIT_ENABLED";
export const ZOHO_AUTO_COMMIT_BUFFER_HOURS_ENV = "ZOHO_AUTO_COMMIT_BUFFER_HOURS";

const DEFAULT_BUFFER_HOURS = 24;
const MAX_BUFFER_HOURS = 168;

export type ZohoAutoCommitBufferConfig = {
  /** When false, NO row should be seeded with an auto_commit_eligible_at.
   *  The cron is also a no-op in this state. */
  enabled: boolean;
  /** Hours from seed to eligibility. 0 = immediate. */
  bufferHours: number;
};

export function resolveZohoAutoCommitBufferConfig(
  env: Record<string, string | undefined> = process.env,
): ZohoAutoCommitBufferConfig {
  const enabled = env[ZOHO_AUTO_COMMIT_ENABLED_ENV] === "true";
  const raw = env[ZOHO_AUTO_COMMIT_BUFFER_HOURS_ENV];
  let bufferHours = DEFAULT_BUFFER_HOURS;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_BUFFER_HOURS) {
      // Drop fractional hours — the column is timestamptz but our SLA
      // doesn't need sub-hour resolution.
      bufferHours = Math.floor(parsed);
    }
  }
  return { enabled, bufferHours };
}

/** Compute the eligibility timestamp at seed/preview time. Returns null
 *  when auto-commit is disabled, which is the signal seedPendingRawBagReceiveRows
 *  uses to leave the column NULL (and the cron's WHERE clause filters
 *  out rows whose auto_commit_eligible_at is NULL anyway). */
export function deriveAutoCommitEligibleAt(
  now: Date,
  config: ZohoAutoCommitBufferConfig,
): Date | null {
  if (!config.enabled) return null;
  if (config.bufferHours === 0) return new Date(now.getTime());
  return new Date(now.getTime() + config.bufferHours * 60 * 60 * 1000);
}
