import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabletTypes } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";

export async function listTabletTypes() {
  return db.select().from(tabletTypes).orderBy(asc(tabletTypes.name));
}

export async function getTabletType(id: string) {
  const [row] = await db.select().from(tabletTypes).where(eq(tabletTypes.id, id));
  return row ?? null;
}

export type TabletTypeInput = {
  sku?: string | null | undefined;
  name: string;
  defaultMgPerTablet?: number | null | undefined;
  zohoItemId?: string | null | undefined;
  isActive?: boolean | undefined;
};

export async function createTabletType(input: TabletTypeInput, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(tabletTypes).values(compact(input)).returning();
    if (!row) throw new Error("createTabletType: insert returned no row");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "tablet_type.create",
        targetType: "TabletType",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

export async function updateTabletType(
  id: string,
  patch: Partial<TabletTypeInput>,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tabletTypes).where(eq(tabletTypes.id, id));
    if (!before) throw new Error("updateTabletType: not found");
    const [row] = await tx
      .update(tabletTypes)
      .set(compact(patch))
      .where(eq(tabletTypes.id, id))
      .returning();
    if (!row) throw new Error("updateTabletType: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "tablet_type.update",
        targetType: "TabletType",
        targetId: id,
        before,
        after: row,
      },
      tx,
    );
    return row;
  });
}
