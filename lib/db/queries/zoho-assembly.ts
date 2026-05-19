// ZOHO-ASSY-1 / ZOHO-ASSY-1b — Query helpers for zoho_assembly_ops.
// Phase 1+1b: CRUD only.  No workers, no Zoho calls, no enqueue logic.
// Future phases add the planner (Phase 2) and worker/retry (Phase 3).
//
// ─── Idempotency key formats (enforced by callers, not DB) ───────────────────
//
//   TABLET_RECEIVE:
//     luma:tablet_receive:{finishedLotId}:{inventoryBagId}
//     One op per source bag per lot.  Variety packs yield N ops.
//
//   UNIT_ASSEMBLE:
//     luma:unit_assemble:{finishedLotId}
//
//   DISPLAY_ASSEMBLE:
//     luma:display_assemble:{finishedLotId}
//
//   CASE_ASSEMBLE:
//     luma:case_assemble:{finishedLotId}
//
// ─────────────────────────────────────────────────────────────────────────────

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { finishedLots, products, zohoAssemblyOps } from "@/lib/db/schema";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ZohoAssemblyOpKind = ZohoAssemblyOp["opKind"];
export type ZohoAssemblyOpStatus = ZohoAssemblyOp["status"];

export type CreateZohoAssemblyOpInput = {
  finishedLotId:        string;
  opKind:               ZohoAssemblyOpKind;
  zohoItemId?:          string | null;
  quantity:             number;
  idempotencyKey:       string;
  opSequence?:          number | null;
  // Source fields — required for TABLET_RECEIVE; null for assembly ops.
  sourceInventoryBagId?: string | null;
  sourcePoLineId?:       string | null;
  sourceTabletTypeId?:   string | null;
  componentRole?:        string | null;
  // Optional overrides — if omitted, defaults apply (PENDING / null).
  status?:              ZohoAssemblyOpStatus;
  requestPayload?:      unknown;
};

export type SetZohoAssemblyOpStatusInput = {
  status:           ZohoAssemblyOpStatus;
  zohoReferenceId?: string | null;
  requestPayload?:  unknown;
  responsePayload?: unknown;
  lastError?:       string | null;
  startedAt?:       Date | null;
  succeededAt?:     Date | null;
  failedAt?:        Date | null;
};

export type ZohoAssemblyOpWithLot = {
  op:                ZohoAssemblyOp;
  finishedLotNumber: string;
  productName:       string | null;
  productSku:        string | null;
};

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listZohoAssemblyOps(opts?: {
  finishedLotId?: string;
  status?: ZohoAssemblyOpStatus;
  opKind?: ZohoAssemblyOpKind;
  limit?: number;
}): Promise<ZohoAssemblyOp[]> {
  let query = db.select().from(zohoAssemblyOps).$dynamic();
  if (opts?.finishedLotId) {
    query = query.where(eq(zohoAssemblyOps.finishedLotId, opts.finishedLotId));
  }
  if (opts?.status) {
    query = query.where(eq(zohoAssemblyOps.status, opts.status));
  }
  if (opts?.opKind) {
    query = query.where(eq(zohoAssemblyOps.opKind, opts.opKind));
  }
  query = query.orderBy(
    asc(zohoAssemblyOps.opSequence),
    asc(zohoAssemblyOps.enqueuedAt),
  );
  if (opts?.limit) {
    query = query.limit(opts.limit);
  }
  return query;
}

export async function getZohoAssemblyOp(id: string): Promise<ZohoAssemblyOp | null> {
  const [row] = await db
    .select()
    .from(zohoAssemblyOps)
    .where(eq(zohoAssemblyOps.id, id))
    .limit(1);
  return row ?? null;
}

export async function getZohoAssemblyOpByIdempotencyKey(
  key: string,
): Promise<ZohoAssemblyOp | null> {
  const [row] = await db
    .select()
    .from(zohoAssemblyOps)
    .where(eq(zohoAssemblyOps.idempotencyKey, key))
    .limit(1);
  return row ?? null;
}

/** Returns all TABLET_RECEIVE ops for a lot, ordered by op_sequence then
 *  enqueued_at.  Used by the planner dependency check:
 *  all TABLET_RECEIVE must be SUCCEEDED/SKIPPED before UNIT_ASSEMBLE starts. */
export async function listTabletReceiveOpsForLot(
  finishedLotId: string,
): Promise<ZohoAssemblyOp[]> {
  return db
    .select()
    .from(zohoAssemblyOps)
    .where(
      and(
        eq(zohoAssemblyOps.finishedLotId, finishedLotId),
        eq(zohoAssemblyOps.opKind, "TABLET_RECEIVE"),
      ),
    )
    .orderBy(asc(zohoAssemblyOps.opSequence), asc(zohoAssemblyOps.enqueuedAt));
}

/** Returns ops for a lot whose status blocks progression (PENDING, IN_PROGRESS,
 *  FAILED, NEEDS_MAPPING) at a given op_sequence level. */
export async function listBlockingOpsForLot(
  finishedLotId: string,
  beforeSequence: number,
): Promise<ZohoAssemblyOp[]> {
  return db
    .select()
    .from(zohoAssemblyOps)
    .where(
      and(
        eq(zohoAssemblyOps.finishedLotId, finishedLotId),
        inArray(zohoAssemblyOps.status, ["PENDING", "IN_PROGRESS", "FAILED", "NEEDS_MAPPING"]),
        sql`${zohoAssemblyOps.opSequence} < ${beforeSequence}`,
      ),
    );
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function createZohoAssemblyOp(
  input: CreateZohoAssemblyOpInput,
): Promise<ZohoAssemblyOp> {
  const [row] = await db
    .insert(zohoAssemblyOps)
    .values({
      finishedLotId:        input.finishedLotId,
      opKind:               input.opKind,
      zohoItemId:           input.zohoItemId          ?? null,
      quantity:             input.quantity,
      idempotencyKey:       input.idempotencyKey,
      opSequence:           input.opSequence          ?? null,
      sourceInventoryBagId: input.sourceInventoryBagId ?? null,
      sourcePoLineId:       input.sourcePoLineId       ?? null,
      sourceTabletTypeId:   input.sourceTabletTypeId   ?? null,
      componentRole:        input.componentRole        ?? null,
      status:               input.status              ?? "PENDING",
      requestPayload:       input.requestPayload !== undefined
                              ? (input.requestPayload as ZohoAssemblyOp["requestPayload"])
                              : null,
    })
    .returning();
  if (!row) throw new Error("createZohoAssemblyOp: insert returned no row");
  return row;
}

/** Insert if idempotency key is new; return existing row if already present.
 *  Safe to call multiple times — never creates duplicates. */
export async function upsertZohoAssemblyOpByIdempotencyKey(
  input: CreateZohoAssemblyOpInput,
): Promise<ZohoAssemblyOp> {
  const existing = await getZohoAssemblyOpByIdempotencyKey(input.idempotencyKey);
  if (existing) return existing;
  return createZohoAssemblyOp(input);
}

export async function setZohoAssemblyOpStatus(
  id: string,
  update: SetZohoAssemblyOpStatusInput,
): Promise<ZohoAssemblyOp> {
  const now = new Date();
  const patch: Partial<ZohoAssemblyOp> = {
    status: update.status,
  };
  if (update.zohoReferenceId !== undefined) patch.zohoReferenceId = update.zohoReferenceId;
  if (update.lastError       !== undefined) patch.lastError       = update.lastError;
  if (update.requestPayload  !== undefined)
    patch.requestPayload  = update.requestPayload  as ZohoAssemblyOp["requestPayload"];
  if (update.responsePayload !== undefined)
    patch.responsePayload = update.responsePayload as ZohoAssemblyOp["responsePayload"];

  if (update.status === "IN_PROGRESS")   patch.startedAt   = update.startedAt   ?? now;
  if (update.status === "SUCCEEDED")     patch.succeededAt = update.succeededAt ?? now;
  if (update.status === "FAILED")        patch.failedAt    = update.failedAt    ?? now;
  if (update.status === "NEEDS_MAPPING") patch.failedAt    = update.failedAt    ?? now;

  const [row] = await db
    .update(zohoAssemblyOps)
    .set(patch)
    .where(eq(zohoAssemblyOps.id, id))
    .returning();
  if (!row) throw new Error(`setZohoAssemblyOpStatus: row ${id} not found`);
  return row;
}

/** Increment retry_count by 1 atomically — call after each failed attempt. */
export async function incrementZohoAssemblyOpRetryCount(id: string): Promise<void> {
  await db
    .update(zohoAssemblyOps)
    .set({ retryCount: sql`${zohoAssemblyOps.retryCount} + 1` })
    .where(eq(zohoAssemblyOps.id, id));
}

/** Mark an op as manually resolved by an admin (escape hatch for stuck jobs). */
export async function resolveZohoAssemblyOpManually(
  id: string,
  opts: { note: string; resolvedByUserId: string },
): Promise<ZohoAssemblyOp> {
  const [row] = await db
    .update(zohoAssemblyOps)
    .set({
      resolvedManually:  true,
      resolvedNote:      opts.note,
      resolvedByUserId:  opts.resolvedByUserId,
    })
    .where(eq(zohoAssemblyOps.id, id))
    .returning();
  if (!row) throw new Error(`resolveZohoAssemblyOpManually: row ${id} not found`);
  return row;
}

/** Lists ops joined to their finished lot and product for the admin UI.
 *  opKind filter is intentionally omitted — the admin list page filters by status,
 *  not kind; use listZohoAssemblyOps for kind-specific lookups. */
export async function listZohoAssemblyOpsWithLot(opts?: {
  finishedLotId?: string;
  status?: ZohoAssemblyOpStatus;
  limit?: number;
}): Promise<ZohoAssemblyOpWithLot[]> {
  let query = db
    .select({
      op:                zohoAssemblyOps,
      finishedLotNumber: finishedLots.finishedLotNumber,
      productName:       products.name,
      productSku:        products.sku,
    })
    .from(zohoAssemblyOps)
    .innerJoin(finishedLots, eq(zohoAssemblyOps.finishedLotId, finishedLots.id))
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .$dynamic();

  if (opts?.finishedLotId && opts.status) {
    query = query.where(
      and(
        eq(zohoAssemblyOps.finishedLotId, opts.finishedLotId),
        eq(zohoAssemblyOps.status, opts.status),
      ),
    );
  } else if (opts?.finishedLotId) {
    query = query.where(eq(zohoAssemblyOps.finishedLotId, opts.finishedLotId));
  } else if (opts?.status) {
    query = query.where(eq(zohoAssemblyOps.status, opts.status));
  }

  // Newest-enqueued lots first (UI view); within each enqueuedAt, preserve op_sequence order.
  query = query.orderBy(
    desc(zohoAssemblyOps.enqueuedAt),
    asc(zohoAssemblyOps.opSequence),
  );

  if (opts?.limit) {
    query = query.limit(opts.limit);
  }

  const rows = await query;
  return rows.map((r) => ({
    op:                r.op,
    finishedLotNumber: r.finishedLotNumber,
    productName:       r.productName,
    productSku:        r.productSku,
  }));
}

/** Reset a FAILED or NEEDS_MAPPING op back to PENDING so the worker retries it.
 *  Preserves retryCount (historical record of prior attempts).
 *  Throws a descriptive error if the op is in any other status. */
export async function resetZohoAssemblyOpToPending(
  id: string,
): Promise<ZohoAssemblyOp> {
  const [row] = await db
    .update(zohoAssemblyOps)
    .set({ status: "PENDING", lastError: null, failedAt: null })
    .where(
      and(
        eq(zohoAssemblyOps.id, id),
        inArray(zohoAssemblyOps.status, ["FAILED", "NEEDS_MAPPING"]),
      ),
    )
    .returning();
  if (!row) {
    // Either op not found, or status was not FAILED/NEEDS_MAPPING at update time.
    const current = await getZohoAssemblyOp(id);
    if (!current) throw new Error(`resetZohoAssemblyOpToPending: op ${id} not found`);
    throw new Error(
      `resetZohoAssemblyOpToPending: cannot reset op in status ${current.status} — only FAILED and NEEDS_MAPPING ops can be reset to PENDING`,
    );
  }
  // Note: resolvedManually / resolvedNote / resolvedByUserId are intentionally
  // preserved as a historical record of prior manual intervention.
  return row;
}
