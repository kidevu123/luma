// HANDPACK-TABLET-TYPE-LINKAGE-1 — resolve tablet type for a workflow bag.
//
// Authoritative order:
//   1. workflow_bags.inventory_bag_id → inventory_bags.tablet_type_id
//   2. CARD_ASSIGNED qr_card_id → qr_cards.scan_token → inventory_bags.bag_qr_code
//
// Floor scanCardAction should set inventory_bag_id at first-op start when the
// received inventory bag is linked to the bag QR (same join admin start uses).

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

  return fromCard?.tabletTypeId ?? null;
}

/** UI copy when sealing product list cannot be narrowed by tablet type. */
export function getSealingProductFilterHint(tabletTypeId: string | null): string | null {
  if (tabletTypeId) return null;
  return "Tablet type is unknown — showing all active card products. Link this bag QR to a received inventory bag to narrow the list.";
}
