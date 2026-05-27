import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { receives } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

export type ReceiveEditSnapshot = {
  notes: string | null;
  closedAt: Date | null;
};

export type ReceiveEditInput = {
  notes?: string | null;
  /** Desired open/closed state. Closing sets closedAt (now if was open). Reopening clears it. */
  isClosed: boolean;
};

export function buildReceiveEditPatch(
  before: ReceiveEditSnapshot,
  input: ReceiveEditInput,
): ReceiveEditSnapshot | null {
  const notes =
    input.notes !== undefined
      ? input.notes === null
        ? null
        : input.notes.trim() || null
      : before.notes;

  const closedAt = input.isClosed ? (before.closedAt ?? new Date()) : null;

  const notesUnchanged =
    (before.notes ?? null) === (notes ?? null);
  const closedUnchanged =
    (before.closedAt?.getTime() ?? null) === (closedAt?.getTime() ?? null);

  if (notesUnchanged && closedUnchanged) return null;

  return { notes, closedAt };
}

export async function editReceive(
  receiveId: string,
  input: ReceiveEditInput,
  actor: CurrentUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select({
      id: receives.id,
      notes: receives.notes,
      closedAt: receives.closedAt,
    })
    .from(receives)
    .where(eq(receives.id, receiveId));
  if (!row) return { ok: false, error: "Receive not found." };

  const before: ReceiveEditSnapshot = {
    notes: row.notes ?? null,
    closedAt: row.closedAt ?? null,
  };

  const after = buildReceiveEditPatch(before, input);
  if (!after) return { ok: true };

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(receives)
        .set({
          notes: after.notes,
          closedAt: after.closedAt,
        })
        .where(eq(receives.id, receiveId));

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "receive.edit",
          targetType: "Receive",
          targetId: receiveId,
          before: {
            notes: before.notes,
            closedAt: before.closedAt?.toISOString() ?? null,
          },
          after: {
            notes: after.notes,
            closedAt: after.closedAt?.toISOString() ?? null,
          },
        },
        tx,
      );
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Save failed.",
    };
  }
}
