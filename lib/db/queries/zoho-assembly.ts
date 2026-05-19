// ZOHO-ASSY-1 — Query helpers for zoho_assembly_ops.
// Phase 1: CRUD only.  No workers, no Zoho calls wired here.
// Future phases will add enqueue logic, status polling, and retry
// orchestration on top of these primitives.

import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoAssemblyOps } from "@/lib/db/schema";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ZohoAssemblyOpKind = ZohoAssemblyOp["opKind"];
export type ZohoAssemblyOpStatus = ZohoAssemblyOp["status"];

export type CreateZohoAssemblyOpInput = {
  finishedLotId: string;
  opKind: ZohoAssemblyOpKind;
  zohoItemId?: string | null;
  quantity: number;
  idempotencyKey: string;
};

export type SetZohoAssemblyOpStatusInput = {
  status: ZohoAssemblyOpStatus;
  zohoReferenceId?: string | null;
  requestPayload?: unknown;
  responsePayload?: unknown;
  lastError?: string | null;
  startedAt?: Date | null;
  succeededAt?: Date | null;
  failedAt?: Date | null;
};

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listZohoAssemblyOps(opts?: {
  finishedLotId?: string;
  status?: ZohoAssemblyOpStatus;
  limit?: number;
}): Promise<ZohoAssemblyOp[]> {
  let query = db.select().from(zohoAssemblyOps).$dynamic();
  if (opts?.finishedLotId) {
    query = query.where(eq(zohoAssemblyOps.finishedLotId, opts.finishedLotId));
  }
  if (opts?.status) {
    query = query.where(eq(zohoAssemblyOps.status, opts.status));
  }
  query = query.orderBy(desc(zohoAssemblyOps.enqueuedAt));
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

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function createZohoAssemblyOp(
  input: CreateZohoAssemblyOpInput,
): Promise<ZohoAssemblyOp> {
  const [row] = await db
    .insert(zohoAssemblyOps)
    .values({
      finishedLotId:  input.finishedLotId,
      opKind:         input.opKind,
      zohoItemId:     input.zohoItemId ?? null,
      quantity:       input.quantity,
      idempotencyKey: input.idempotencyKey,
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
  if (update.lastError !== undefined) patch.lastError = update.lastError;
  if (update.requestPayload !== undefined)
    patch.requestPayload = update.requestPayload as ZohoAssemblyOp["requestPayload"];
  if (update.responsePayload !== undefined)
    patch.responsePayload = update.responsePayload as ZohoAssemblyOp["responsePayload"];

  if (update.status === "IN_PROGRESS")  patch.startedAt  = update.startedAt  ?? now;
  if (update.status === "SUCCEEDED")    patch.succeededAt = update.succeededAt ?? now;
  if (update.status === "FAILED")       patch.failedAt    = update.failedAt    ?? now;
  if (update.status === "NEEDS_MAPPING") patch.failedAt   = update.failedAt    ?? now;

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
