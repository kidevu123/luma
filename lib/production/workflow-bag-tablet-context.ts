// HANDPACK-TABLET-TYPE-SOURCE-1 — resolve tablet type for a workflow bag.
//
// Authoritative order:
//   1. workflow_bags.inventory_bag_id → inventory_bags.tablet_type_id
//   2. CARD_ASSIGNED payload qr_card_id → qr_cards.scan_token → inventory_bags.bag_qr_code
//   3. HANDPACK_BLISTER_COMPLETE payload tablet_type_id  (operator-selected at completion)
//
// Path 3 is the primary mechanism for HANDPACK_BLISTER bags, which never link
// to a single received inventory bag (hand-packing pulls from multiple sources).
// The operator selects tablet type before submitting HANDPACK_BLISTER_COMPLETE;
// it lands in the event payload and is read here at sealing product-filter time.

import { asc, eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";

type DbOrTx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export type InventoryBagLink = {
  inventoryBagId: string;
  tabletTypeId: string | null;
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
  const [direct] = await dbOrTx
    .select({ tabletTypeId: inventoryBags.tabletTypeId })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .where(eq(workflowBags.id, workflowBagId))
    .limit(1);
  if (direct?.tabletTypeId) return direct.tabletTypeId;

  const [fromCard] = await dbOrTx
    .select({ tabletTypeId: inventoryBags.tabletTypeId })
    .from(workflowEvents)
    .innerJoin(
      qrCards,
      eq(qrCards.id, sql`((${workflowEvents.payload}->>'qr_card_id')::uuid)`),
    )
    .innerJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    .where(
      sql`${workflowEvents.workflowBagId} = ${workflowBagId}::uuid
          AND ${workflowEvents.eventType} = 'CARD_ASSIGNED'`,
    )
    .orderBy(asc(workflowEvents.occurredAt), asc(workflowEvents.id))
    .limit(1);

  if (fromCard?.tabletTypeId) return fromCard.tabletTypeId;

  // Path 3: HANDPACK_BLISTER_COMPLETE event payload.tablet_type_id
  // Operator selects tablet type at hand-pack completion; stored in the payload.
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

/** UI copy when sealing product list cannot be narrowed by tablet type. */
export function getSealingProductFilterHint(tabletTypeId: string | null): string | null {
  if (tabletTypeId) return null;
  return "Tablet type is unknown — showing all active card products. Select tablet type at hand-pack completion to narrow this list.";
}
