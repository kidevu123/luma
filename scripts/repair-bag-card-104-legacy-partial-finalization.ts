// BAG-CARD-104 legacy partial finalization — dry-run by default.
//
//   npx tsx scripts/repair-bag-card-104-legacy-partial-finalization.ts
//   ALLOW_PRODUCTION_REPAIR=true CONFIRM_WORKFLOW_BAG_ID=3d026c01-4521-4825-9c08-3e8e9bd87196 CONFIRM_BAG_CARD=bag-card-104 npx tsx scripts/repair-bag-card-104-legacy-partial-finalization.ts --apply

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { synthesizerSupportsVoidedBagFinalization } from "@/lib/production/bag-finalization-void";
import {
  DEFAULT_TARGET,
  REPAIR_SCRIPT_VERSION,
  applyLegacyPartialFinalizationRepair,
  loadRepairCurrentState,
  loadWorkflowEventSlices,
  verifyLegacyPartialFinalizationRepair,
} from "@/lib/production/legacy-partial-finalization-repair";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readSynthSource(): string {
  return readFileSync(
    resolve(root, "lib/legacy/read-model-synthesizer.ts"),
    "utf8",
  );
}

function printSection(title: string, body: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set");
    process.exit(1);
  }

  const workflowBagId =
    process.env.CONFIRM_WORKFLOW_BAG_ID ?? DEFAULT_TARGET.workflowBagId;
  const bagCardToken = process.env.CONFIRM_BAG_CARD ?? DEFAULT_TARGET.bagCardToken;
  const inventoryBagId = DEFAULT_TARGET.inventoryBagId;
  const receiptNumber = DEFAULT_TARGET.receiptNumber;

  if (apply) {
    if (process.env.ALLOW_PRODUCTION_REPAIR !== "true") {
      console.error("Refusing apply: set ALLOW_PRODUCTION_REPAIR=true");
      process.exit(1);
    }
    if (workflowBagId !== DEFAULT_TARGET.workflowBagId) {
      console.error(
        `Refusing apply: CONFIRM_WORKFLOW_BAG_ID must be ${DEFAULT_TARGET.workflowBagId}`,
      );
      process.exit(1);
    }
    if (bagCardToken !== DEFAULT_TARGET.bagCardToken) {
      console.error(
        `Refusing apply: CONFIRM_BAG_CARD must be ${DEFAULT_TARGET.bagCardToken}`,
      );
      process.exit(1);
    }
  }

  const synthesizerSupportsVoid = synthesizerSupportsVoidedBagFinalization(
    readSynthSource(),
  );

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [current, events] = await Promise.all([
      loadRepairCurrentState(db, { workflowBagId, bagCardToken }),
      loadWorkflowEventSlices(db, workflowBagId),
    ]);

    const verified = verifyLegacyPartialFinalizationRepair({
      workflowBagId,
      inventoryBagId,
      bagCardToken,
      receiptNumber,
      events,
      current,
      synthesizerSupportsVoid,
    });

    console.log(
      `[repair-bag-card-104] mode=${apply ? "APPLY" : "DRY-RUN"} script=${REPAIR_SCRIPT_VERSION}`,
    );

    if (!verified.ok) {
      printSection("ABORT", verified.abortReason);
      process.exit(1);
    }

    printSection("TARGET", verified.target);
    printSection("EVENT CHAIN", verified.eventChain);
    printSection("CURRENT STATE", verified.current);
    printSection("PROPOSED MUTATIONS", verified.proposedMutations);
    printSection("REBUILD SAFETY", verified.rebuildSafety);
    printSection("RESUMABLE STAGE", verified.resumableStage);
    printSection("ALREADY REPAIRED", verified.alreadyRepaired);

    if (!apply) {
      console.log(
        "\nDry-run complete — no mutations written. Apply requires ALLOW_PRODUCTION_REPAIR=true, CONFIRM_WORKFLOW_BAG_ID, CONFIRM_BAG_CARD, and --apply.",
      );
      return;
    }

    if (!verified.rebuildSafety.survivesReadModelRebuild) {
      console.error(
        `Refusing apply: ${verified.rebuildSafety.summary}`,
      );
      process.exit(1);
    }

    const result = await db.transaction(async (tx) =>
      applyLegacyPartialFinalizationRepair(tx, verified, {
        actorNote: process.env.REPAIR_ACTOR_NOTE ?? null,
      }),
    );

    printSection("APPLY RESULT", result);
    console.log("\nApply complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
