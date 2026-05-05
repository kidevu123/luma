import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  batchHolds,
  tabletTypes,
  packagingMaterials,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";

type Status = typeof batches.$inferSelect.status;

export async function listBatches(filter?: { status?: Status; kind?: "TABLET" | "PACKAGING" }) {
  const conds = [];
  if (filter?.status) conds.push(eq(batches.status, filter.status));
  if (filter?.kind) conds.push(eq(batches.kind, filter.kind));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const rows = await db
    .select({
      batch: batches,
      tabletName: tabletTypes.name,
      packagingName: packagingMaterials.name,
    })
    .from(batches)
    .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
    .leftJoin(packagingMaterials, eq(batches.packagingMaterialId, packagingMaterials.id))
    .where(where ?? sql`true`)
    .orderBy(desc(batches.createdAt));
  return rows.map((r) => ({
    ...r.batch,
    materialName: r.tabletName ?? r.packagingName ?? null,
  }));
}

export async function batchStatusCounts() {
  const rows = await db
    .select({ status: batches.status, n: sql<number>`count(*)::int` })
    .from(batches)
    .groupBy(batches.status);
  const out: Partial<Record<Status, number>> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function getBatchWithHolds(id: string) {
  const [b] = await db.select().from(batches).where(eq(batches.id, id));
  if (!b) return null;
  const holds = await db
    .select()
    .from(batchHolds)
    .where(eq(batchHolds.batchId, id));
  return { ...b, holds };
}

export async function setBatchStatus(
  id: string,
  next: Status,
  actor: CurrentUser,
  note?: string,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(batches).where(eq(batches.id, id));
    if (!before) throw new Error("setBatchStatus: not found");
    if (before.status === next) return before;
    const [row] = await tx
      .update(batches)
      .set({
        status: next,
        statusChangedAt: new Date(),
        statusChangedById: actor.id,
        ...(note ? { notes: note } : {}),
      })
      .where(eq(batches.id, id))
      .returning();
    if (!row) throw new Error("setBatchStatus: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: `batch.status_${next.toLowerCase()}`,
        targetType: "Batch",
        targetId: id,
        before: { status: before.status },
        after: { status: row.status, note },
      },
      tx,
    );
    return row;
  });
}

export async function openHold(
  batchId: string,
  reason: string,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [hold] = await tx
      .insert(batchHolds)
      .values({ batchId, reason, openedById: actor.id })
      .returning();
    await tx
      .update(batches)
      .set({ status: "ON_HOLD", statusChangedAt: new Date(), statusChangedById: actor.id })
      .where(eq(batches.id, batchId));
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "batch.hold_open",
        targetType: "Batch",
        targetId: batchId,
        after: { hold_id: hold?.id, reason },
      },
      tx,
    );
    return hold;
  });
}

export async function closeHold(
  holdId: string,
  resolution: string,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [hold] = await tx
      .update(batchHolds)
      .set({
        closedAt: new Date(),
        closedById: actor.id,
        closedReason: resolution,
      })
      .where(eq(batchHolds.id, holdId))
      .returning();
    if (!hold) throw new Error("closeHold: not found");
    // If no other open holds remain, the batch can be released back.
    const [remaining] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(batchHolds)
      .where(and(eq(batchHolds.batchId, hold.batchId), sql`${batchHolds.closedAt} IS NULL`));
    if ((remaining?.n ?? 0) === 0) {
      await tx
        .update(batches)
        .set({
          status: "RELEASED",
          statusChangedAt: new Date(),
          statusChangedById: actor.id,
        })
        .where(eq(batches.id, hold.batchId));
    }
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "batch.hold_close",
        targetType: "BatchHold",
        targetId: holdId,
        after: { resolution },
      },
      tx,
    );
    return hold;
  });
}

export type CreateBatchInput = {
  kind: "TABLET" | "PACKAGING";
  batchNumber: string;
  tabletTypeId?: string | null | undefined;
  packagingMaterialId?: string | null | undefined;
  vendorName?: string | null | undefined;
  vendorLotNumber?: string | null | undefined;
  manufacturedAt?: string | null | undefined;
  expiryDate?: string | null | undefined;
  qtyReceived?: number | undefined;
  notes?: string | null | undefined;
};

export async function createBatch(input: CreateBatchInput, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(batches)
      .values(compact({
        ...input,
        status: "QUARANTINE",
        qtyReceived: input.qtyReceived ?? 0,
        qtyOnHand: input.qtyReceived ?? 0,
      }))
      .returning();
    if (!row) throw new Error("createBatch: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "batch.create",
        targetType: "Batch",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

void inArray; // re-exported helper kept in scope for queries that need it
