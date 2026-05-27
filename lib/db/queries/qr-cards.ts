import { eq, and, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { qrCards, workflowBags, products, inventoryBags, batches, smallBoxes, receives, tabletTypes } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { isQrCardMidProduction } from "@/lib/production/qr-card-retire";

export type QrCardRow = typeof qrCards.$inferSelect;

export async function listQrCards() {
  return db
    .select({
      card: qrCards,
      bag: workflowBags,
      productName: products.name,
      intakeBag: {
        id: inventoryBags.id,
        internalReceiptNumber: inventoryBags.internalReceiptNumber,
        batchId: inventoryBags.batchId,
        bagNumber: inventoryBags.bagNumber,
        receiveName: receives.receiveName,
        tabletTypeName: tabletTypes.name,
      },
      intakeBatchNumber: batches.batchNumber,
    })
    .from(qrCards)
    .leftJoin(workflowBags, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(inventoryBags, eq(qrCards.scanToken, inventoryBags.bagQrCode))
    .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
    .leftJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .leftJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .leftJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
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
    // Block retirement only when the card is genuinely mid-production
    // (ASSIGNED with a live workflow bag). Intake-reserved cards
    // (ASSIGNED+null workflowBagId) have not entered production and
    // may be retired freely.
    if (isQrCardMidProduction(before)) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Availability helpers
// ─────────────────────────────────────────────────────────────────────────────

// Returns only IDLE cards; intake-reserved (ASSIGNED+null workflowBagId) cards are not included.
/** Returns all RAW_BAG cards with status IDLE, ordered by label. */
export async function listAvailableRawBagQrCards(): Promise<QrCardRow[]> {
  return db
    .select()
    .from(qrCards)
    .where(and(eq(qrCards.cardType, "RAW_BAG"), eq(qrCards.status, "IDLE")))
    .orderBy(asc(qrCards.label));
}

/** Returns all VARIETY_PACK cards with status IDLE, ordered by label. */
export async function listAvailableVarietyPackQrCards(): Promise<QrCardRow[]> {
  return db
    .select()
    .from(qrCards)
    .where(and(eq(qrCards.cardType, "VARIETY_PACK"), eq(qrCards.status, "IDLE")))
    .orderBy(asc(qrCards.label));
}

// Returns only IDLE cards; intake-reserved (ASSIGNED+null workflowBagId) cards are not included.
/** Returns the first available RAW_BAG IDLE card (lowest label), or null. */
export async function getNextAvailableRawBagQrCard(): Promise<QrCardRow | null> {
  const rows = await db
    .select()
    .from(qrCards)
    .where(and(eq(qrCards.cardType, "RAW_BAG"), eq(qrCards.status, "IDLE")))
    .orderBy(asc(qrCards.label))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a QR card by scanToken for raw-bag use.
 * Type is checked before status.
 */
export async function validateQrCardUsableForRawBag(
  scanToken: string,
): Promise<{ valid: true; card: QrCardRow } | { valid: false; reason: string }> {
  const rows = await db
    .select()
    .from(qrCards)
    .where(eq(qrCards.scanToken, scanToken));
  const card = rows[0];
  if (!card) return { valid: false, reason: "QR card not found" };

  // Check type first
  if (card.cardType === "VARIETY_PACK") {
    return { valid: false, reason: "Card is designated for variety packs, not raw bags" };
  }
  if (card.cardType === "WORKFLOW_TRAVELER") {
    return { valid: false, reason: "Card is a workflow traveler, not a raw bag card" };
  }
  if (card.cardType === "UNKNOWN") {
    return { valid: false, reason: "Card type is not configured — contact admin" };
  }

  // Then check status
  if (card.status === "ASSIGNED") {
    return { valid: false, reason: "Card is already assigned to an active bag" };
  }
  if (card.status === "RETIRED") {
    return { valid: false, reason: "Card has been retired" };
  }

  return { valid: true, card };
}

/**
 * Validates a QR card by scanToken for variety-pack use.
 * Type is checked before status.
 */
export async function validateQrCardUsableForVarietyPack(
  scanToken: string,
): Promise<{ valid: true; card: QrCardRow } | { valid: false; reason: string }> {
  const rows = await db
    .select()
    .from(qrCards)
    .where(eq(qrCards.scanToken, scanToken));
  const card = rows[0];
  if (!card) return { valid: false, reason: "QR card not found" };

  // Check type first
  if (card.cardType === "RAW_BAG") {
    return { valid: false, reason: "Card is designated for raw bags, not variety packs" };
  }
  if (card.cardType === "WORKFLOW_TRAVELER") {
    return { valid: false, reason: "Card is a workflow traveler, not a variety pack card" };
  }
  if (card.cardType === "UNKNOWN") {
    return { valid: false, reason: "Card type is not configured — contact admin" };
  }

  // Then check status
  if (card.status === "ASSIGNED") {
    return { valid: false, reason: "Card is already assigned to an active bag" };
  }
  if (card.status === "RETIRED") {
    return { valid: false, reason: "Card has been retired" };
  }

  return { valid: true, card };
}
