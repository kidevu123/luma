// Production: one controlled FIX Relax production-output assembly commit (PM-approved).
//
// Luma gates open/close in-process via withPilotProductionOutputCommitWindow.
// Zoho CT 9503 requires shell trap — see docs/CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md
//
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/archive/pilot/_pilot-fix-relax-po-commit-once.ts

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import {
  processConsolidatedProductionOutputCommit,
  queueConsolidatedProductionOutputOp,
} from "@/lib/db/queries/zoho-production-output-consolidated";
import type { CurrentUser } from "@/lib/auth";
import { withPilotProductionOutputCommitWindow } from "@/lib/zoho/pilot-production-output-commit-window";

const SCRIPT_TAG = "fix-relax-po-commit";
const OP_ID = "f0256ebc-5f3c-4d54-aff8-3e76228a3847";
const FINISHED_LOT_ID = "61c0ad45-dd1a-4764-b560-57291cf35022";

function pilotActor(): CurrentUser {
  const id = process.env.PILOT_ACTOR_ID ?? "00000000-0000-4000-8000-000000000001";
  return {
    id,
    email: "pilot-commit@luma.local",
    role: "OWNER",
    employeeId: null,
  };
}

async function runCommit(): Promise<number> {
  const actor = pilotActor();

  const [before] = await db
    .select({
      id: zohoProductionOutputOps.id,
      status: zohoProductionOutputOps.status,
      finishedLotId: zohoProductionOutputOps.finishedLotId,
      committedAt: zohoProductionOutputOps.committedAt,
      quantityGood: zohoProductionOutputOps.quantityGood,
      unitAssemblyQuantity: zohoProductionOutputOps.unitAssemblyQuantity,
      quantityLoose: zohoProductionOutputOps.quantityLoose,
    })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, OP_ID))
    .limit(1);

  if (!before) {
    console.log(JSON.stringify({ ok: false, phase: "precheck", error: "op not found" }));
    return 1;
  }
  if (before.finishedLotId !== FINISHED_LOT_ID) {
    console.log(
      JSON.stringify({ ok: false, phase: "precheck", error: "finished lot mismatch" }),
    );
    return 1;
  }
  if (before.committedAt) {
    console.log(JSON.stringify({ ok: false, phase: "precheck", error: "already committed" }));
    return 1;
  }

  console.log(JSON.stringify({ step: "before", op: before }, null, 2));

  if (before.status === "READY" || before.status === "FAILED") {
    const queued = await queueConsolidatedProductionOutputOp(OP_ID, actor);
    if (!queued.ok) {
      console.log(JSON.stringify({ ok: false, phase: "queue", error: queued.error }));
      return 1;
    }
    console.log(JSON.stringify({ step: "queued", opId: OP_ID }));
  }

  const result = await processConsolidatedProductionOutputCommit(OP_ID, actor);
  console.log(JSON.stringify({ step: "commit", result }, null, 2));

  const [after] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, OP_ID))
    .limit(1);

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        after: after
          ? {
              status: after.status,
              committedAt: after.committedAt,
              zohoBundleIds: after.zohoBundleIds,
              zohoReceiveId: after.zohoReceiveId,
              commitError: after.commitError,
            }
          : null,
      },
      null,
      2,
    ),
  );

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
