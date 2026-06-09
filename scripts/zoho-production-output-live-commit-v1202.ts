/**
 * Diagnostic-only — v1.20.6 contract alignment.
 * Does NOT commit. May preview a persisted eligible operation only.
 */

import {
  assertPersistedOperationForScriptCommit,
  blockDirectScriptCommitInProduction,
} from "../lib/zoho/production-output-script-guard";
import { buildLumaOperationSnapshotFromPersistedOp } from "../lib/zoho/luma-operation-snapshot";

const IDEMPOTENCY_KEY = process.argv[2] ?? "luma-live-v1202-pink-lemonade-001";

async function main() {
  const prodBlock = blockDirectScriptCommitInProduction();
  if (prodBlock.blocked) {
    console.log(JSON.stringify({ error: prodBlock.reason, mode: "diagnostic" }, null, 2));
    process.exit(1);
  }

  const opGuard = await assertPersistedOperationForScriptCommit(IDEMPOTENCY_KEY);
  if (!opGuard.allowed) {
    console.log(
      JSON.stringify(
        {
          error: opGuard.reason,
          hint: "Create operation from finalized finished lot via admin UI — scripts cannot fabricate ops.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const snapshot = await buildLumaOperationSnapshotFromPersistedOp(opGuard.opId);
  if (!snapshot.ok) {
    console.log(JSON.stringify({ error: "snapshot_build_failed", blockers: snapshot.blockers }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        mode: "preview_only",
        op_id: opGuard.opId,
        luma_operation_id: IDEMPOTENCY_KEY,
        snapshot: snapshot.snapshot,
        note: "Commit intentionally disabled. Use /zoho-production-operations UI after writes_allowed=true preview.",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
