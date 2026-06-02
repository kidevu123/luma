// HANDPACK-TABLET-CONTEXT-1 — resolve tablet type for a workflow bag.
//
// Authoritative order:
//   1. workflow_bags.inventory_bag_id → inventory_bags.tablet_type_id
//   2. CARD_ASSIGNED payload qr_card_id → qr_cards.scan_token → inventory_bags.bag_qr_code
//   3. HANDPACK_BLISTER_COMPLETE payload tablet_type_id (legacy completed-bag fallback)
//
// HANDPACK_BLISTER completion must use paths 1/2 only. Path 3 remains for
// historical sealing/product-filter compatibility with already-completed bags.

import { asc, eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  tabletTypes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";

type DbOrTx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export type InventoryBagLink = {
  inventoryBagId: string;
  tabletTypeId: string | null;
};

export type WorkflowBagTabletContext = {
  tabletTypeId: string;
  tabletTypeName: string;
  source: "inventory_bag" | "card_assigned";
  inventoryBagId: string | null;
  receiptNumber: string | null;
  bagNumber: number | null;
};

/** Lookup received inventory bag linked to a bag QR scan token. */
export async function lookupInventoryBagByQrScanToken(
  dbOrTx: DbOrTx,
  scanToken: string,
): Promise<InventoryBagLink | null> {
  const [row] = await dbOrTx
    .select({
      inventoryBagId: inventoryBags.id,
      tabletTypeId: inventoryBags.tabletTypeId,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.bagQrCode, scanToken))
    .limit(1);
  if (!row) return null;
  return {
    inventoryBagId: row.inventoryBagId,
    tabletTypeId: row.tabletTypeId ?? null,
  };
}

/** Resolve tablet type for sealing product filter + validation. */
export async function resolveWorkflowBagTabletTypeId(
  dbOrTx: DbOrTx,
  workflowBagId: string,
): Promise<string | null> {
  const receivedContext = await resolveWorkflowBagReceivedTabletContext(
    dbOrTx,
    workflowBagId,
  );
  if (receivedContext) return receivedContext.tabletTypeId;

  // Path 3: legacy HANDPACK_BLISTER_COMPLETE event payload.tablet_type_id.
  // This fallback is only for already-completed legacy bags at sealing time.
  // New HANDPACK_BLISTER completion uses resolveWorkflowBagReceivedTabletContext
  // and blocks when received lineage is missing.
  const [fromHandpack] = await dbOrTx
    .select({
      tabletTypeId: sql<string | null>`(${workflowEvents.payload}->>'tablet_type_id')`,
    })
    .from(workflowEvents)
    .where(
      sql`${workflowEvents.workflowBagId} = ${workflowBagId}::uuid
          AND ${workflowEvents.eventType} = 'HANDPACK_BLISTER_COMPLETE'
          AND ${workflowEvents.payload}->>'tablet_type_id' IS NOT NULL`,
    )
    .limit(1);

  return fromHandpack?.tabletTypeId ?? null;
}

/** Resolve received-bag tablet lineage for active hand-pack completion. */
export async function resolveWorkflowBagReceivedTabletContext(
  dbOrTx: DbOrTx,
  workflowBagId: string,
): Promise<WorkflowBagTabletContext | null> {
  const [direct] = await dbOrTx
    .select({
      tabletTypeId: inventoryBags.tabletTypeId,
      tabletTypeName: tabletTypes.name,
      inventoryBagId: inventoryBags.id,
      receiptNumber: inventoryBags.internalReceiptNumber,
      bagNumber: inventoryBags.bagNumber,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .where(eq(workflowBags.id, workflowBagId))
    .limit(1);
  if (direct?.tabletTypeId && direct.tabletTypeName) {
    return {
      tabletTypeId: direct.tabletTypeId,
      tabletTypeName: direct.tabletTypeName,
      source: "inventory_bag",
      inventoryBagId: direct.inventoryBagId ?? null,
      receiptNumber: direct.receiptNumber ?? null,
      bagNumber: direct.bagNumber ?? null,
    };
  }

  const [fromCard] = await dbOrTx
    .select({
      tabletTypeId: inventoryBags.tabletTypeId,
      tabletTypeName: tabletTypes.name,
      inventoryBagId: inventoryBags.id,
      receiptNumber: inventoryBags.internalReceiptNumber,
      bagNumber: inventoryBags.bagNumber,
    })
    .from(workflowEvents)
    .innerJoin(
      qrCards,
      eq(qrCards.id, sql`((${workflowEvents.payload}->>'qr_card_id')::uuid)`),
    )
    .innerJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .where(
      sql`${workflowEvents.workflowBagId} = ${workflowBagId}::uuid
          AND ${workflowEvents.eventType} = 'CARD_ASSIGNED'`,
    )
    .orderBy(asc(workflowEvents.occurredAt), asc(workflowEvents.id))
    .limit(1);

  if (fromCard?.tabletTypeId && fromCard.tabletTypeName) {
    return {
      tabletTypeId: fromCard.tabletTypeId,
      tabletTypeName: fromCard.tabletTypeName,
      source: "card_assigned",
      inventoryBagId: fromCard.inventoryBagId ?? null,
      receiptNumber: fromCard.receiptNumber ?? null,
      bagNumber: fromCard.bagNumber ?? null,
    };
  }

  return null;
}

/** UI copy when sealing product list cannot be narrowed by tablet type. */
export function getSealingProductFilterHint(tabletTypeId: string | null): string | null {
  if (tabletTypeId) return null;
  return "Tablet type is unknown — showing all active card products. Ask a supervisor to fix received-bag lineage if this bag should have tablet context.";
}
