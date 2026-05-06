import { eq, asc, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { qrCards, workflowBags, products } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

export async function listQrCards() {
  return db
    .select({
      card: qrCards,
      bag: workflowBags,
      productName: products.name,
    })
    .from(qrCards)
    .leftJoin(workflowBags, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .orderBy(asc(qrCards.label));
}

export async function createQrCard(label: string, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    // Generate a token client-side via crypto if you want, but DB
    // gen_random_uuid casted to text is uniqueness-safe.
    const token = crypto.randomUUID();
    const [row] = await tx
      .insert(qrCards)
      .values({ label, scanToken: token, status: "IDLE" })
      .returning();
    if (!row) throw new Error("createQrCard: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "qr_card.create",
        targetType: "QrCard",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

export async function retireQrCard(id: string, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(qrCards).where(eq(qrCards.id, id));
    if (!before) throw new Error("retireQrCard: not found");
    if (before.status === "ASSIGNED") {
      throw new Error("Cannot retire a card that's mid-bag. Finalize the bag first.");
    }
    const [row] = await tx
      .update(qrCards)
      .set({ status: "RETIRED", retiredAt: new Date() })
      .where(eq(qrCards.id, id))
      .returning();
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "qr_card.retire",
        targetType: "QrCard",
        targetId: id,
        before,
        after: row,
      },
      tx,
    );
    return row;
  });
}
