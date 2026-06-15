// Pilot-only wrapper — opens Luma commit gates in-process and always closes in finally.
// Zoho CT 9503 gates (ENABLE_LIVE_INVENTORY_WRITES + capabilities) require shell trap;
// see docs/CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md.

import {
  withProductionOutputCommitWindow,
  ZOHO_GATE_CLOSE_CHECKLIST,
} from "@/lib/zoho/controlled-production-output-window";

export function assertStagingPilotApproved(
  scriptTag: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const allow =
    env.ALLOW_STAGING_QA_DATA === "true" || env.ALLOW_STAGING_QA_DATA === "1";
  if (!allow) {
    throw new Error(
      `[${scriptTag}] Refusing: set ALLOW_STAGING_QA_DATA=true for controlled pilot commits`,
    );
  }
  if (env.ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED === "true") {
    throw new Error(
      `[${scriptTag}] Refusing: ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED must stay false`,
    );
  }
  if (env.ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS === "true") {
    throw new Error(
      `[${scriptTag}] Refusing: ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS must stay false`,
    );
  }
}

/** Run one production-output commit attempt with Luma gates closed afterward. */
export async function withPilotProductionOutputCommitWindow<T>(
  scriptTag: string,
  fn: () => Promise<T>,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  assertStagingPilotApproved(scriptTag, env);
  return withProductionOutputCommitWindow(env, fn);
}

export { ZOHO_GATE_CLOSE_CHECKLIST };
