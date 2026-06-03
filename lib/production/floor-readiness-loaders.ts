/** Server loaders for floor-readiness evaluation (read-only SELECTs). */

import { eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  receives,
  smallBoxes,
} from "@/lib/db/schema";
import {
  evaluateInventoryBagReadiness,
  evaluateQrCardReadiness,
  type FloorReadinessEvaluation,
  type InventoryBagReadinessInput,
  type QrCardReadinessInput,
} from "@/lib/production/floor-readiness";

type DbOrTx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export async function loadInventoryBagReadinessInput(
  dbOrTx: DbOrTx,
  inventoryBagId: string,
): Promise<InventoryBagReadinessInput | null> {
  const [row] = await dbOrTx
    .select({
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      tabletTypeId: inventoryBags.tabletTypeId,
      bagQrCode: inventoryBags.bagQrCode,
      receiveId: receives.id,
      receivePoId: receives.poId,
      qrCardType: qrCards.cardType,
      qrCardStatus: qrCards.status,
      qrAssignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      qrScanToken: qrCards.scanToken,
    })
    .from(inventoryBags)
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(qrCards, eq(qrCards.scanToken, inventoryBags.bagQrCode))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  if (!row) return null;

  let qrCard: QrCardReadinessInput | null = null;
  if (row.qrScanToken) {
    qrCard = {
      cardType: row.qrCardType ?? "UNKNOWN",
      status: row.qrCardStatus ?? "IDLE",
      assignedWorkflowBagId: row.qrAssignedWorkflowBagId,
      scanToken: row.qrScanToken,
    };
  }

  return {
    internalReceiptNumber: row.internalReceiptNumber,
    tabletTypeId: row.tabletTypeId,
    bagQrCode: row.bagQrCode,
    hasReceiveContext: row.receiveId != null,
    receivePoId: row.receivePoId,
    qrCard,
  };
}

export async function evaluateInventoryBagReadinessById(
  dbOrTx: DbOrTx,
  inventoryBagId: string,
): Promise<FloorReadinessEvaluation | null> {
  const input = await loadInventoryBagReadinessInput(dbOrTx, inventoryBagId);
  if (!input) return null;
  return evaluateInventoryBagReadiness(input);
}

export async function loadQrCardReadinessInput(
  dbOrTx: DbOrTx,
  cardId: string,
): Promise<{
  card: QrCardReadinessInput;
  inventoryBag: InventoryBagReadinessInput | null;
} | null> {
  const [row] = await dbOrTx
    .select({
      scanToken: qrCards.scanToken,
      cardType: qrCards.cardType,
      status: qrCards.status,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      inventoryBagId: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      tabletTypeId: inventoryBags.tabletTypeId,
      bagQrCode: inventoryBags.bagQrCode,
      receiveId: receives.id,
      receivePoId: receives.poId,
    })
    .from(qrCards)
    .leftJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .where(eq(qrCards.id, cardId))
    .limit(1);

  if (!row) return null;

  const card: QrCardReadinessInput = {
    scanToken: row.scanToken,
    cardType: row.cardType,
    status: row.status,
    assignedWorkflowBagId: row.assignedWorkflowBagId,
  };

  let inventoryBag: InventoryBagReadinessInput | null = null;
  if (row.inventoryBagId) {
    inventoryBag = {
      internalReceiptNumber: row.internalReceiptNumber,
      tabletTypeId: row.tabletTypeId,
      bagQrCode: row.bagQrCode,
      hasReceiveContext: row.receiveId != null,
      receivePoId: row.receivePoId,
      qrCard: card,
    };
  }

  return { card, inventoryBag };
}

export async function evaluateQrCardReadinessById(
  dbOrTx: DbOrTx,
  cardId: string,
  options?: { allowPartialBagRestart?: boolean },
): Promise<FloorReadinessEvaluation | null> {
  const loaded = await loadQrCardReadinessInput(dbOrTx, cardId);
  if (!loaded) return null;
  return evaluateQrCardReadiness({
    ...loaded.card,
    inventoryBag: loaded.inventoryBag,
    ...(options?.allowPartialBagRestart
      ? { allowPartialBagRestart: true }
      : {}),
  });
}

/** Load readiness for all bags on a receive (inbound detail). */
export async function loadReceiveBagReadinessEvaluations(
  dbOrTx: DbOrTx,
  bagIds: readonly string[],
): Promise<Map<string, FloorReadinessEvaluation>> {
  const out = new Map<string, FloorReadinessEvaluation>();
  for (const id of bagIds) {
    const evaluation = await evaluateInventoryBagReadinessById(dbOrTx, id);
    if (evaluation) out.set(id, evaluation);
  }
  return out;
}
