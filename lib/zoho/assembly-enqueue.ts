// ZOHO-ASSY-3 — Enqueue service: persist dry-run plan into zoho_assembly_ops.
//
// Entry point: enqueueZohoAssemblyOpsForFinishedLot(finishedLotId)
//   1. Calls planZohoAssemblyForFinishedLot (read-only)
//   2. Skips SKIPPED ops (no row created)
//   3. Upserts one zoho_assembly_ops row per non-skipped op
//   4. Returns { enqueued, existing, skipped } counts
//
// Status mapping (plan preview → queued row status):
//   READY         → PENDING       (worker can execute immediately)
//   NEEDS_MAPPING → NEEDS_MAPPING (blocked until Zoho IDs are filled in)
//   BLOCKED       → NEEDS_MAPPING (conservative; must be reviewed before execution)
//   SKIPPED       → never inserted
//
// Idempotent: calling twice for the same lot creates no duplicate rows.
// The DB unique index on idempotency_key is the final guard; this layer
// does a single bulk-key-fetch before inserting to report accurate counts.

import type { CreateZohoAssemblyOpInput, ZohoAssemblyOpStatus } from "@/lib/db/queries/zoho-assembly";
import {
  listZohoAssemblyOps,
  createZohoAssemblyOp,
} from "@/lib/db/queries/zoho-assembly";
import {
  planZohoAssemblyForFinishedLot,
  type PlanOp,
  type ZohoAssemblyPlanResult,
} from "./assembly-planner";

// ─── Status mapping ───────────────────────────────────────────────────────────

function planStatusToQueueStatus(
  statusPreview: PlanOp["statusPreview"],
): ZohoAssemblyOpStatus {
  return statusPreview === "READY" ? "PENDING" : "NEEDS_MAPPING";
}

// ─── Pure input builder (exported for tests) ─────────────────────────────────

/** Converts one non-SKIPPED plan op into a CreateZohoAssemblyOpInput.
 *  Pure function — no DB access.  SKIPPED ops must never be passed here. */
export function buildZohoAssemblyOpInput(
  finishedLotId: string,
  op: PlanOp,
): CreateZohoAssemblyOpInput {
  const status = planStatusToQueueStatus(op.statusPreview);

  if (op.opKind === "TABLET_RECEIVE") {
    return {
      finishedLotId,
      opKind:               "TABLET_RECEIVE",
      zohoItemId:           op.zohoTabletItemId      ?? null,
      quantity:             op.quantity,
      idempotencyKey:       op.idempotencyKey,
      opSequence:           op.opSequence,
      sourceInventoryBagId: op.sourceInventoryBagId  ?? null,
      sourcePoLineId:       op.sourcePoLineId        ?? null,
      sourceTabletTypeId:   op.sourceTabletTypeId    ?? null,
      componentRole:        op.componentRole         ?? null,
      status,
      requestPayload:       op.payloadPreview,
    };
  }

  return {
    finishedLotId,
    opKind:         op.opKind,
    zohoItemId:     op.zohoItemId ?? null,
    quantity:       op.quantity,
    idempotencyKey: op.idempotencyKey,
    opSequence:     op.opSequence,
    status,
    requestPayload: op.payloadPreview,
  };
}

// ─── Enqueue result ───────────────────────────────────────────────────────────

export type EnqueueResult = {
  finishedLotId: string;
  plan:          ZohoAssemblyPlanResult;
  enqueued:      number;  // rows newly created this call
  existing:      number;  // rows that already existed (idempotent)
  skipped:       number;  // plan ops with SKIPPED status — not inserted
};

// ─── Async enqueue ────────────────────────────────────────────────────────────

export async function enqueueZohoAssemblyOpsForFinishedLot(
  finishedLotId: string,
): Promise<EnqueueResult | null> {
  const plan = await planZohoAssemblyForFinishedLot(finishedLotId);
  if (!plan) return null;

  const nonSkipped = plan.ops.filter((op) => op.statusPreview !== "SKIPPED");
  const skipped    = plan.ops.length - nonSkipped.length;

  // Fetch all existing keys in one query to avoid N+1 per-op lookups.
  const existing = await listZohoAssemblyOps({ finishedLotId });
  const existingKeys = new Set(existing.map((r) => r.idempotencyKey));

  let enqueued  = 0;
  let existingCount = 0;

  for (const op of nonSkipped) {
    const input = buildZohoAssemblyOpInput(finishedLotId, op);
    if (existingKeys.has(input.idempotencyKey)) {
      existingCount++;
    } else {
      await createZohoAssemblyOp(input);
      enqueued++;
    }
  }

  return { finishedLotId, plan, enqueued, existing: existingCount, skipped };
}
