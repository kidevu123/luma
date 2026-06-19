// SOURCE-BAG-ZOHO-RECEIVE-COVERAGE-AUDIT-v1.4.18 — read-only.
//
// For every source bag referenced by any finished_lot_raw_bags row,
// report whether the bag has a non-voided zoho_raw_bag_receives row
// and whether it has reached COMMITTED state with a zoho_purchase_receive_id.
//
// Output is a TSV-ish table on stdout — one row per source bag.
// Columns:
//   finished_lot_number  finished_lot_id  inventory_bag_id
//   internal_receipt_number  product_sku  consumed_qty
//   allocation_status  zrbr_status  zrbr_reconciliation
//   zoho_purchase_receive_id  eligible_for_receive_preview
//   blocker_if_not_eligible
//
// Eligibility heuristic for receive preview:
//   - inventory_bag exists, status != VOIDED
//   - small_box / receive / po_line resolved
//   - product is a tablet (raw bag intake path)
//   - po_lines.zoho_line_item_id is populated (Zoho mapping known)
//   - tablet_types.zoho_item_id is populated (raw item mapping known)
//
// NO mutations. NO Zoho calls. NO env writes.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLotRawBags,
  finishedLots,
  inventoryBags,
  poLines,
  products,
  purchaseOrders,
  rawBagAllocationSessions,
  receives,
  smallBoxes,
  tabletTypes,
  zohoRawBagReceives,
} from "@/lib/db/schema";

type Row = {
  finishedLotNumber: string | null;
  finishedLotId: string;
  inventoryBagId: string;
  internalReceiptNumber: string | null;
  productSku: string | null;
  productName: string | null;
  consumedQty: number | null;
  allocationStatus: string | null;
  zrbrStatus: string | null;
  zrbrReconciliation: string | null;
  zohoPurchaseReceiveId: string | null;
  eligible: boolean;
  blocker: string | null;
};

async function main(): Promise<void> {
  // 1. distinct source bags across all finished lots
  const sourceBags = await db
    .selectDistinct({
      inventoryBagId: finishedLotRawBags.inventoryBagId,
      finishedLotId: finishedLotRawBags.finishedLotId,
      consumedQty: finishedLotRawBags.quantityConsumedPills,
    })
    .from(finishedLotRawBags);

  const bagIds = sourceBags.map((r) => r.inventoryBagId);
  if (bagIds.length === 0) {
    console.log("No source bags found.");
    return;
  }

  // 2. join inventory_bag → small_box → receive → po_line → po → tablet_type
  const bagChain = await db
    .select({
      bagId: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      bagStatus: inventoryBags.status,
      tabletTypeId: inventoryBags.tabletTypeId,
      smallBoxId: smallBoxes.id,
      receiveId: receives.id,
      poId: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      zohoPoId: purchaseOrders.zohoPoId,
      poLineId: poLines.id,
      zohoLineItemId: poLines.zohoLineItemId,
      tabletZohoItemId: tabletTypes.zohoItemId,
    })
    .from(inventoryBags)
    .leftJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .leftJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .leftJoin(poLines, eq(receives.poLineId, poLines.id))
    .leftJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .where(inArray(inventoryBags.id, bagIds));
  const bagChainById = new Map(bagChain.map((b) => [b.bagId, b]));

  // 3. finished_lots metadata for the finished_lot_ids we touch
  const lotIds = Array.from(new Set(sourceBags.map((r) => r.finishedLotId)));
  const lotMeta = await db
    .select({
      id: finishedLots.id,
      finishedLotNumber: finishedLots.finishedLotNumber,
      productId: finishedLots.productId,
      productSku: products.sku,
      productName: products.name,
    })
    .from(finishedLots)
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .where(inArray(finishedLots.id, lotIds));
  const lotById = new Map(lotMeta.map((l) => [l.id, l]));

  // 4. zoho_raw_bag_receives by inventory_bag_id (non-voided), most recent
  const zrbr = await db
    .select({
      inventoryBagId: zohoRawBagReceives.inventoryBagId,
      zohoReceiveStatus: zohoRawBagReceives.zohoReceiveStatus,
      reconciliationStatus: zohoRawBagReceives.reconciliationStatus,
      zohoPurchaseReceiveId: zohoRawBagReceives.zohoPurchaseReceiveId,
      voidedAt: zohoRawBagReceives.voidedAt,
      createdAt: zohoRawBagReceives.createdAt,
    })
    .from(zohoRawBagReceives)
    .where(
      inArray(
        zohoRawBagReceives.inventoryBagId,
        bagIds.filter((id): id is string => id != null),
      ),
    );
  const zrbrByBag = new Map<string, (typeof zrbr)[number]>();
  for (const row of zrbr) {
    if (row.voidedAt != null || row.inventoryBagId == null) continue;
    const existing = zrbrByBag.get(row.inventoryBagId);
    if (
      !existing ||
      (row.createdAt && existing.createdAt && row.createdAt > existing.createdAt)
    ) {
      zrbrByBag.set(row.inventoryBagId, row);
    }
  }

  // 5. allocation_status from raw_bag_allocation_sessions (latest per bag/lot)
  const allocStatuses = await db
    .select({
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      finishedLotId: rawBagAllocationSessions.finishedLotId,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
    })
    .from(rawBagAllocationSessions)
    .where(inArray(rawBagAllocationSessions.inventoryBagId, bagIds));
  const allocByBagLot = new Map<string, string>();
  for (const row of allocStatuses) {
    if (!row.inventoryBagId || !row.finishedLotId) continue;
    allocByBagLot.set(
      `${row.inventoryBagId}::${row.finishedLotId}`,
      row.allocationStatus,
    );
  }

  // 6. build rows + eligibility verdict
  const rows: Row[] = [];
  for (const sb of sourceBags) {
    if (!sb.inventoryBagId) continue;
    const chain = bagChainById.get(sb.inventoryBagId);
    const lot = lotById.get(sb.finishedLotId);
    const zrbrRow = zrbrByBag.get(sb.inventoryBagId);
    const alloc = allocByBagLot.get(`${sb.inventoryBagId}::${sb.finishedLotId}`);

    let eligible = true;
    let blocker: string | null = null;
    if (!chain) {
      eligible = false;
      blocker = "INVENTORY_BAG_CHAIN_INCOMPLETE";
    } else if (chain.bagStatus === "VOIDED") {
      eligible = false;
      blocker = "BAG_VOIDED";
    } else if (!chain.receiveId) {
      eligible = false;
      blocker = "RECEIVE_MISSING";
    } else if (!chain.zohoPoId) {
      eligible = false;
      blocker = "PO_NOT_MAPPED_TO_ZOHO";
    } else if (!chain.zohoLineItemId) {
      eligible = false;
      blocker = "PO_LINE_NOT_MAPPED_TO_ZOHO";
    } else if (!chain.tabletZohoItemId) {
      eligible = false;
      blocker = "TABLET_TYPE_NOT_MAPPED_TO_ZOHO";
    } else if (zrbrRow?.zohoReceiveStatus === "COMMITTED") {
      eligible = false;
      blocker = "ALREADY_COMMITTED";
    }

    rows.push({
      finishedLotNumber: lot?.finishedLotNumber ?? null,
      finishedLotId: sb.finishedLotId,
      inventoryBagId: sb.inventoryBagId,
      internalReceiptNumber: chain?.internalReceiptNumber ?? null,
      productSku: lot?.productSku ?? null,
      productName: lot?.productName ?? null,
      consumedQty: sb.consumedQty,
      allocationStatus: alloc ?? null,
      zrbrStatus: zrbrRow?.zohoReceiveStatus ?? null,
      zrbrReconciliation: zrbrRow?.reconciliationStatus ?? null,
      zohoPurchaseReceiveId: zrbrRow?.zohoPurchaseReceiveId ?? null,
      eligible,
      blocker,
    });
  }

  // 7. print
  console.log(
    [
      "finished_lot_number",
      "finished_lot_id",
      "inventory_bag_id",
      "internal_receipt_number",
      "product_sku",
      "consumed_qty",
      "allocation_status",
      "zrbr_status",
      "zrbr_reconciliation",
      "zoho_purchase_receive_id",
      "eligible_for_receive_preview",
      "blocker_if_not_eligible",
    ].join("\t"),
  );
  for (const r of rows) {
    console.log(
      [
        r.finishedLotNumber ?? "",
        r.finishedLotId,
        r.inventoryBagId,
        r.internalReceiptNumber ?? "",
        r.productSku ?? "",
        r.consumedQty ?? "",
        r.allocationStatus ?? "",
        r.zrbrStatus ?? "",
        r.zrbrReconciliation ?? "",
        r.zohoPurchaseReceiveId ?? "",
        r.eligible ? "yes" : "no",
        r.blocker ?? "",
      ].join("\t"),
    );
  }

  // 8. summary
  const total = rows.length;
  const eligible = rows.filter((r) => r.eligible).length;
  const alreadyCommitted = rows.filter(
    (r) => r.zrbrStatus === "COMMITTED",
  ).length;
  const noZrbr = rows.filter((r) => r.zrbrStatus == null).length;
  const blocked = rows.filter((r) => !r.eligible).length;
  console.error("---SUMMARY---");
  console.error(JSON.stringify({
    total_source_bags: total,
    eligible_for_preview: eligible,
    already_committed: alreadyCommitted,
    no_zoho_raw_bag_receives_row: noZrbr,
    blocked: blocked,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("FATAL", err);
    process.exit(1);
  })
  .then(() => process.exit(0));
