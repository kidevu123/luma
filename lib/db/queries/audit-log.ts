import { and, desc, eq, ilike, inArray, SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, qrCards, users } from "@/lib/db/schema";

export type AuditLogRow = {
  id: number;
  createdAt: Date;
  action: string;
  targetType: string;
  targetId: string | null;
  before: unknown;
  after: unknown;
  actorRole: string | null;
  actorEmail: string | null;
};

const auditSelect = {
  id: auditLog.id,
  createdAt: auditLog.createdAt,
  action: auditLog.action,
  targetType: auditLog.targetType,
  targetId: auditLog.targetId,
  before: auditLog.before,
  after: auditLog.after,
  actorRole: auditLog.actorRole,
  actorEmail: users.email,
};

/** Newest-first audit rows for a single target. */
export async function listAuditLogsByTarget(params: {
  targetType: string;
  targetId: string;
  limit?: number;
}): Promise<AuditLogRow[]> {
  const limit = params.limit ?? 50;
  return db
    .select(auditSelect)
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(
        eq(auditLog.targetType, params.targetType),
        eq(auditLog.targetId, params.targetId),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/** All inventory_bag.edit (and other) audits for many bags — newest first globally. */
export async function listAuditLogsForInventoryBags(
  bagIds: string[],
  limit = 500,
): Promise<AuditLogRow[]> {
  if (bagIds.length === 0) return [];
  return db
    .select(auditSelect)
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(
        eq(auditLog.targetType, "InventoryBag"),
        inArray(auditLog.targetId, bagIds),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

const QR_BAG_EDIT_ACTIONS = [
  "qr_card.released_at_bag_edit",
  "qr_card.reserved_at_bag_edit",
] as const;

/** QR card audit rows tied to scan tokens used on bags (reassignment context). */
export async function listQrCardBagEditAudits(
  scanTokens: string[],
  limit = 200,
): Promise<AuditLogRow[]> {
  const tokens = [...new Set(scanTokens.map((t) => t.trim()).filter(Boolean))];
  if (tokens.length === 0) return [];

  const cards = await db
    .select({ id: qrCards.id })
    .from(qrCards)
    .where(inArray(qrCards.scanToken, tokens));
  const cardIds = cards.map((c) => c.id);
  if (cardIds.length === 0) return [];

  return db
    .select(auditSelect)
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(
        eq(auditLog.targetType, "QrCard"),
        inArray(auditLog.targetId, cardIds),
        inArray(auditLog.action, [...QR_BAG_EDIT_ACTIONS]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

const MAX_RECENT_AUDIT_LIMIT = 100;

export type ListRecentAuditLogsParams = {
  limit?: number;
  /** Case-insensitive substring match on action. */
  actionContains?: string;
  targetType?: string;
  /** Case-insensitive substring match on actor email. */
  actorEmailContains?: string;
};

/** Newest-first audit rows across the system (read-only admin viewer). */
export async function listRecentAuditLogs(
  params: ListRecentAuditLogsParams = {},
): Promise<AuditLogRow[]> {
  const limit = Math.min(
    params.limit ?? MAX_RECENT_AUDIT_LIMIT,
    MAX_RECENT_AUDIT_LIMIT,
  );

  const conditions: SQL[] = [];
  const actionQ = params.actionContains?.trim();
  if (actionQ) {
    conditions.push(ilike(auditLog.action, `%${actionQ}%`));
  }
  const targetType = params.targetType?.trim();
  if (targetType) {
    conditions.push(eq(auditLog.targetType, targetType));
  }
  const actorQ = params.actorEmailContains?.trim();
  if (actorQ) {
    conditions.push(ilike(users.email, `%${actorQ}%`));
  }

  const whereClause =
    conditions.length === 0 ? undefined : and(...conditions);

  return db
    .select(auditSelect)
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(whereClause)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

// SIMPLIFY-B — latest audit row per target, pure half. The packaging engine
// records WHY auto-issue was blocked only in audit_log
// (finished_lot.auto_create_blocked); closeout surfaces the newest reason
// per workflow bag instead of leaving operators guessing.
export function pickLatestPerTarget<T extends { targetId: string | null; createdAt: Date }>(
  rows: T[],
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    if (row.targetId == null) continue;
    const prev = out.get(row.targetId);
    if (!prev || row.createdAt > prev.createdAt) out.set(row.targetId, row);
  }
  return out;
}

export async function mapLatestAutoCreateBlockedByWorkflowBag(
  workflowBagIds: string[],
): Promise<Map<string, { reason: string; message: string }>> {
  if (workflowBagIds.length === 0) return new Map();
  const rows = await db
    .select({
      targetId: auditLog.targetId,
      createdAt: auditLog.createdAt,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "WorkflowBag"),
        eq(auditLog.action, "finished_lot.auto_create_blocked"),
        inArray(auditLog.targetId, workflowBagIds),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(500);
  const latest = pickLatestPerTarget(rows);
  const out = new Map<string, { reason: string; message: string }>();
  for (const [id, row] of latest) {
    const after = (row.after ?? {}) as { reason?: unknown; message?: unknown };
    out.set(id, {
      reason: typeof after.reason === "string" ? after.reason : "UNKNOWN",
      message: typeof after.message === "string" ? after.message : "Auto-issue was blocked at packaging close-out.",
    });
  }
  return out;
}
