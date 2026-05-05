// Audit-log helper. Every mutation calls writeAudit() inside the same
// transaction as the write.

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

type Role = "OWNER" | "ADMIN" | "MANAGER" | "LEAD" | "STAFF";

export type AuditEntry = {
  actorId: string | null;
  actorRole: Role | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function writeAudit(
  entry: AuditEntry,
  tx?: Tx,
): Promise<void> {
  const payload = {
    actorId: entry.actorId,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    before: (entry.before as object | undefined) ?? null,
    after: (entry.after as object | undefined) ?? null,
  };
  if (tx) {
    await tx.insert(auditLog).values(payload);
  } else {
    await db.insert(auditLog).values(payload);
  }
}
