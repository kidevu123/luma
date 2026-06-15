// Controlled production-output commit window — always close Luma gates in finally.

export type ProductionOutputCommitWindowEnv = {
  ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED?: string | undefined;
  ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED?: string | undefined;
  ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS?: string | undefined;
};

export type ProductionOutputCommitWindowSnapshot = {
  before: ProductionOutputCommitWindowEnv;
  openedAt: string;
};

const LUMA_GATE_KEYS = [
  "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED",
  "ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED",
  "ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS",
] as const;

export function snapshotProductionOutputCommitWindow(
  env: Record<string, string | undefined> = process.env,
): ProductionOutputCommitWindowSnapshot {
  const before: ProductionOutputCommitWindowEnv = {};
  for (const key of LUMA_GATE_KEYS) {
    before[key] = env[key];
  }
  return { before, openedAt: new Date().toISOString() };
}

export function openProductionOutputCommitWindow(
  env: Record<string, string | undefined>,
): ProductionOutputCommitWindowSnapshot {
  const snap = snapshotProductionOutputCommitWindow(env);
  env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED = "true";
  env.ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED = "false";
  env.ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS = "false";
  return snap;
}

export function closeProductionOutputCommitWindow(
  env: Record<string, string | undefined>,
  snap: ProductionOutputCommitWindowSnapshot,
): void {
  for (const key of LUMA_GATE_KEYS) {
    const prior = snap.before[key];
    if (prior === undefined) {
      delete env[key];
    } else {
      env[key] = prior;
    }
  }
  env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED = "false";
  env.ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED = "false";
  env.ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS = "false";
}

export async function withProductionOutputCommitWindow<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const snap = openProductionOutputCommitWindow(env);
  try {
    return await fn();
  } finally {
    closeProductionOutputCommitWindow(env, snap);
  }
}

/** Shell operators must also close Zoho CT 9503 gates — see docs/CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md */
export const ZOHO_GATE_CLOSE_CHECKLIST = [
  "ENABLE_LIVE_INVENTORY_WRITES=false on CT 9503",
  "luma.production_output.commit capability disabled",
  "luma.raw_intake.commit remains disabled",
  "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false on Luma",
] as const;
