// Production: one controlled Sweet Trip production-output assembly commit (PM-approved).
//
// Luma gates open/close in-process via withPilotProductionOutputCommitWindow.
// Zoho CT 9503 requires shell trap — see docs/CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md
//
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/archive/pilot/_pilot-sweet-trip-po-commit-once.ts

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import {
  processConsolidatedProductionOutputCommit,
  queueConsolidatedProductionOutputOp,
  upsertConsolidatedProductionOutputOpForLot,
} from "@/lib/db/queries/zoho-production-output-consolidated";
import type { CurrentUser } from "@/lib/auth";
import { withPilotProductionOutputCommitWindow } from "@/lib/zoho/pilot-production-output-commit-window";

const SCRIPT_TAG = "sweet-trip-po-commit";
const OP_ID = "7bef5edc-2010-4834-815c-8fcc999e4945";
const FINISHED_LOT_ID = "79c41fa1-7267-4911-9017-8565039290be";

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

  const preview = await upsertConsolidatedProductionOutputOpForLot(FINISHED_LOT_ID, actor);
  console.log(JSON.stringify({ step: "preview_refresh", preview }, null, 2));
  if (!preview.ok) {
    return 1;
  }

  const [before] = await db
    .select({
      id: zohoProductionOutputOps.id,
      status: zohoProductionOutputOps.status,
      finishedLotId: zohoProductionOutputOps.finishedLotId,
      committedAt: zohoProductionOutputOps.committedAt,
      quantityGood: zohoProductionOutputOps.quantityGood,
      unitAssemblyQuantity: zohoProductionOutputOps.unitAssemblyQuantity,
      quantityLoose: zohoProductionOutputOps.quantityLoose,
      previewStatus: zohoProductionOutputOps.previewStatus,
      previewResponse: zohoProductionOutputOps.previewResponse,
      mappingBlockers: zohoProductionOutputOps.mappingBlockers,
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

  const pr = before.previewResponse as Record<string, unknown> | null;
  const blockers = (pr?.blockers as unknown[]) ?? [];
  if (blockers.length > 0) {
    console.log(
      JSON.stringify({ ok: false, phase: "precheck", error: "preview blockers", blockers }),
    );
    return 1;
  }
  const warehouseRequired = blockers.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      "code" in b &&
      (b as { code: string }).code === "WAREHOUSE_REQUIRED",
  );
  if (warehouseRequired) {
    console.log(JSON.stringify({ ok: false, phase: "precheck", error: "WAREHOUSE_REQUIRED" }));
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
