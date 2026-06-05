import { eq, and, desc, sql, inArray, isNull } from "drizzle-orm";
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
import {
  DEFAULT_INTAKE_BATCH_STATUS,
  noteIndicatesQaBlock,
  type IntakeBatchInitialStatus,
} from "@/lib/production/batch-production-guard";

type Status = typeof batches.$inferSelect.status;

export type BatchListFilter = {
  status?: Status;
  kind?: "TABLET" | "PACKAGING";
};

export async function listBatches(filter?: BatchListFilter) {
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
  initialStatus?: IntakeBatchInitialStatus | undefined;
};

export async function createBatch(input: CreateBatchInput, actor: CurrentUser) {
  const { initialStatus: requestedStatus, ...rest } = input;
  const initialStatus = requestedStatus ?? DEFAULT_INTAKE_BATCH_STATUS;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(batches)
      .values(compact({
        ...rest,
        status: initialStatus,
        qtyReceived: rest.qtyReceived ?? 0,
        qtyOnHand: rest.qtyReceived ?? 0,
        statusChangedById: actor.id,
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

export type BulkReleaseSkipReason =
  | "NOT_QUARANTINE"
  | "ZERO_ON_HAND"
  | "EXPIRED_DATE"
  | "OPEN_HOLD"
  | "QA_BLOCK_NOTE"
  | "NOT_FOUND";

export type BulkReleaseAssessment = {
  eligible: Array<{ id: string; batchNumber: string }>;
  skipped: Array<{
    id: string;
    batchNumber: string;
    reason: BulkReleaseSkipReason;
  }>;
};

function isPastExpiry(expiryDate: string | null): boolean {
  if (!expiryDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return expiryDate < today;
}

export function assessBulkReleaseEligibility(
  batch: {
    id: string;
    batchNumber: string;
    status: Status;
    qtyOnHand: number;
    expiryDate: string | null;
    notes: string | null;
  },
  openHoldBatchIds: ReadonlySet<string>,
): BulkReleaseSkipReason | null {
  if (batch.status !== "QUARANTINE") return "NOT_QUARANTINE";
  if (batch.qtyOnHand <= 0) return "ZERO_ON_HAND";
  if (isPastExpiry(batch.expiryDate)) return "EXPIRED_DATE";
  if (openHoldBatchIds.has(batch.id)) return "OPEN_HOLD";
  if (noteIndicatesQaBlock(batch.notes)) return "QA_BLOCK_NOTE";
  return null;
}

export async function assessBulkReleaseCandidates(
  batchIds?: string[],
): Promise<BulkReleaseAssessment> {
  const conds = [eq(batches.status, "QUARANTINE")];
  if (batchIds && batchIds.length > 0) {
    conds.push(inArray(batches.id, batchIds));
  }
  const rows = await db
    .select({
      id: batches.id,
      batchNumber: batches.batchNumber,
      status: batches.status,
      qtyOnHand: batches.qtyOnHand,
      expiryDate: batches.expiryDate,
      notes: batches.notes,
    })
    .from(batches)
    .where(and(...conds));

  const holdRows =
    rows.length > 0
      ? await db
          .select({ batchId: batchHolds.batchId })
          .from(batchHolds)
          .where(
            and(
              inArray(
                batchHolds.batchId,
                rows.map((r) => r.id),
              ),
              isNull(batchHolds.closedAt),
            ),
          )
      : [];
  const openHoldBatchIds = new Set(holdRows.map((h) => h.batchId));

  const eligible: BulkReleaseAssessment["eligible"] = [];
  const skipped: BulkReleaseAssessment["skipped"] = [];

  for (const row of rows) {
    const skip = assessBulkReleaseEligibility(row, openHoldBatchIds);
    if (skip) {
      skipped.push({ id: row.id, batchNumber: row.batchNumber, reason: skip });
    } else {
      eligible.push({ id: row.id, batchNumber: row.batchNumber });
    }
  }

  if (batchIds) {
    const found = new Set(rows.map((r) => r.id));
    for (const id of batchIds) {
      if (!found.has(id)) {
        skipped.push({ id, batchNumber: id, reason: "NOT_FOUND" });
      }
    }
  }

  return { eligible, skipped };
}

export async function bulkReleaseQuarantinedBatches(
  actor: CurrentUser,
  batchIds?: string[],
): Promise<BulkReleaseAssessment & { releasedCount: number }> {
  const assessment = await assessBulkReleaseCandidates(batchIds);
  if (assessment.eligible.length === 0) {
    return { ...assessment, releasedCount: 0 };
  }

  await db.transaction(async (tx) => {
    for (const row of assessment.eligible) {
      const [before] = await tx
        .select()
        .from(batches)
        .where(eq(batches.id, row.id));
      if (!before || before.status !== "QUARANTINE") continue;
      const [updated] = await tx
        .update(batches)
        .set({
          status: "RELEASED",
          statusChangedAt: new Date(),
          statusChangedById: actor.id,
        })
        .where(eq(batches.id, row.id))
        .returning();
      if (!updated) continue;
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "batch.status_released",
          targetType: "Batch",
          targetId: row.id,
          before: { status: before.status },
          after: {
            status: updated.status,
            note: "Bulk release — eligible quarantined lot",
          },
        },
        tx,
      );
    }
  });

  return { ...assessment, releasedCount: assessment.eligible.length };
}

