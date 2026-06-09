// ZOHO-PRODUCTION-OUTPUT-V1206 — block one-shot script commits without persisted ops.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";

export type ScriptCommitGuardResult =
  | { allowed: true; opId: string }
  | { allowed: false; reason: string };

/** Scripts must reference an existing persisted operation by luma_operation_id. */
export async function assertPersistedOperationForScriptCommit(
  lumaOperationId: string,
): Promise<ScriptCommitGuardResult> {
  const trimmed = lumaOperationId.trim();
  if (!trimmed) {
    return { allowed: false, reason: "luma_operation_id is required." };
  }

  const [row] = await db
    .select({ id: zohoProductionOutputOps.id, status: zohoProductionOutputOps.status })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.lumaOperationId, trimmed))
    .limit(1);

  if (!row) {
    return {
      allowed: false,
      reason:
        "No persisted zoho_production_output_ops row exists for this luma_operation_id. Create the operation from a finalized finished lot first.",
    };
  }

  if (row.status === "COMMITTED") {
    return {
      allowed: false,
      reason: "Operation is already COMMITTED. Duplicate processing is blocked.",
    };
  }

  return { allowed: true, opId: row.id };
}

export function blockDirectScriptCommitInProduction(
  env: Record<string, string | undefined> = process.env,
): { blocked: boolean; reason: string | null } {
  const nodeEnv = env.NODE_ENV ?? "development";
  const allowBypass = env.ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS === "true";
  if (nodeEnv === "production" && !allowBypass) {
    return {
      blocked: true,
      reason:
        "Direct production-output script commits are disabled in production. Use the Zoho Operations UI with a persisted operation.",
    };
  }
  return { blocked: false, reason: null };
}
