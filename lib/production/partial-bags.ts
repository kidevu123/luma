// PARTIAL-1 — Available partial raw-bag helpers + query.
//
// "Available partial bag" = inventory_bags.status=AVAILABLE AND has ≥1
// closed/returned allocation session. No new DB status needed — derived
// from existing rawBagAllocationSessions ledger.

import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  inventoryBags,
  products,
  rawBagAllocationSessions,
  smallBoxes,
  tabletTypes,
} from "@/lib/db/schema";

// ─── Types ──────────────────────────────────────────────────────────

export interface PartialBagSession {
  allocationStatus: string;
  endingBalanceQty: number | null;
  closedAt: Date | null;
}

export interface AvailablePartialBagRow {
  bagId: string;
  bagNumber: number;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  tabletTypeName: string | null;
  supplierLot: string | null;
  receiveId: string | null;
  declaredPillCount: number | null;
  pillCount: number | null;
  remainingEstimate: number | null;
  lastConsumedQty: number | null;
  lastUsedProductName: string | null;
  lastUsedAt: Date | null;
  lastSessionStatus: string | null;
}

// ─── Pure helpers ───────────────────────────────────────────────────

/** True if sessions contain ≥1 CLOSED or RETURNED_TO_STOCK record.
 *  A fresh bag (no sessions) returns false. */
export function isAvailablePartialBag(sessions: readonly PartialBagSession[]): boolean {
  return sessions.some(
    (s) =>
      s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK",
  );
}

/** True if any session is currently OPEN (belt-and-suspenders guard). */
export function hasOpenAllocationSession(
  sessions: readonly { allocationStatus: string }[],
): boolean {
  return sessions.some((s) => s.allocationStatus === "OPEN");
}

/** Remaining qty from the most-recent CLOSED/RETURNED_TO_STOCK session
 *  that recorded an endingBalanceQty. Falls back to null. */
export function deriveRemainingEstimate(sessions: readonly PartialBagSession[]): number | null {
  const relevant = sessions
    .filter(
      (s) =>
        (s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK") &&
        s.endingBalanceQty != null,
    )
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  return relevant[0]?.endingBalanceQty ?? null;
}

// ─── DB query ───────────────────────────────────────────────────────

/** Load all AVAILABLE raw bags that have been through ≥1 production run.
 *  Returns rows sorted by last-used date desc (most recently used first). */
export async function loadAvailablePartialBags(): Promise<AvailablePartialBagRow[]> {
  // Step 1: All AVAILABLE bags with context
  const bagRows = await db
    .select({
      id: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      smallBoxId: inventoryBags.smallBoxId,
      tabletTypeName: tabletTypes.name,
      batchNumber: batches.batchNumber,
      receiveId: smallBoxes.receiveId,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .where(eq(inventoryBags.status, "AVAILABLE"))
    .orderBy(asc(inventoryBags.bagNumber));

  if (bagRows.length === 0) return [];

  const bagIds = bagRows.map((b) => b.id);

  // Step 2: All sessions for these bags (ordered oldest-first so JS picks last)
  const sessionRows = await db
    .select({
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      consumedQty: rawBagAllocationSessions.consumedQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      openedAt: rawBagAllocationSessions.openedAt,
      closedAt: rawBagAllocationSessions.closedAt,
      productName: products.name,
    })
    .from(rawBagAllocationSessions)
    .leftJoin(products, eq(products.id, rawBagAllocationSessions.productId))
    .where(inArray(rawBagAllocationSessions.inventoryBagId, bagIds))
    .orderBy(asc(rawBagAllocationSessions.openedAt));

  // Step 3: Group sessions by bag, filter to partial bags, build output
  const sessionsByBag = new Map<string, typeof sessionRows>();
  for (const s of sessionRows) {
    const bagId = s.inventoryBagId;
    if (!bagId) continue;
    const list = sessionsByBag.get(bagId) ?? [];
    list.push(s);
    sessionsByBag.set(bagId, list);
  }

  const result: AvailablePartialBagRow[] = [];

  for (const bag of bagRows) {
    const sessions = sessionsByBag.get(bag.id) ?? [];
    if (!isAvailablePartialBag(sessions)) continue; // fresh bag, not partial

    // Last closed/returned session (sessions are oldest-first, so last = most recent)
    const lastClosed = [...sessions]
      .reverse()
      .find(
        (s) =>
          s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK",
      );

    const remainingEstimate = deriveRemainingEstimate(sessions);

    result.push({
      bagId: bag.id,
      bagNumber: bag.bagNumber,
      bagQrCode: bag.bagQrCode,
      internalReceiptNumber: bag.internalReceiptNumber,
      tabletTypeName: bag.tabletTypeName ?? null,
      supplierLot: bag.batchNumber ?? null,
      receiveId: bag.receiveId ?? null,
      declaredPillCount: bag.declaredPillCount,
      pillCount: bag.pillCount,
      remainingEstimate,
      lastConsumedQty: lastClosed?.consumedQty ?? null,
      lastUsedProductName: lastClosed?.productName ?? null,
      lastUsedAt: lastClosed?.closedAt ?? null,
      lastSessionStatus: lastClosed?.allocationStatus ?? null,
    });
  }

  // Sort: most recently used first
  result.sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));

  return result;
}
