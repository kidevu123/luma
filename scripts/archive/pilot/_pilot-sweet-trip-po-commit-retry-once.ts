// Commit-only retry after clearing preview idempotency conflict (no preview refresh).
//
// Luma gates open/close in-process via withPilotProductionOutputCommitWindow.
// Zoho CT 9503 requires shell trap — see docs/CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md
//
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/archive/pilot/_pilot-sweet-trip-po-commit-retry-once.ts

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import {
  processConsolidatedProductionOutputCommit,
  queueConsolidatedProductionOutputOp,
} from "@/lib/db/queries/zoho-production-output-consolidated";
import type { CurrentUser } from "@/lib/auth";
import { withPilotProductionOutputCommitWindow } from "@/lib/zoho/pilot-production-output-commit-window";

const SCRIPT_TAG = "sweet-trip-po-commit-retry";
const OP_ID = "7bef5edc-2010-4834-815c-8fcc999e4945";

function actor(): CurrentUser {
  return {
    id: process.env.PILOT_ACTOR_ID ?? "5a179969-7d33-4c77-bb9a-242283fe117a",
    email: "pilot-commit@luma.local",
    role: "OWNER",
    employeeId: null,
  };
}

async function runCommit(): Promise<number> {
  const [before] = await db
    .select({
      status: zohoProductionOutputOps.status,
      committedAt: zohoProductionOutputOps.committedAt,
    })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, OP_ID))
    .limit(1);
  if (!before) return 1;
  if (before.committedAt) {
    console.log(JSON.stringify({ ok: true, note: "already committed" }));
    return 0;
  }

  if (before.status === "READY" || before.status === "FAILED") {
    const q = await queueConsolidatedProductionOutputOp(OP_ID, actor());
    if (!q.ok) {
      console.log(JSON.stringify({ ok: false, phase: "queue", error: q.error }));
      return 1;
    }
  }

  const result = await processConsolidatedProductionOutputCommit(OP_ID, actor());
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

async function main() {
  try {
    const code = await withPilotProductionOutputCommitWindow(SCRIPT_TAG, runCommit);
    process.exit(code);
  } catch (err) {
    console.error(err);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
