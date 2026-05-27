import { and, desc, eq, inArray } from "drizzle-orm";
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
