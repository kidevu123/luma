// SOURCE-BAG-RECEIVE-PREVIEW-BACKFILL-v1.4.18 — dry-run by default.
//
// Modes:
//   (default — dry-run)        : describe what would happen, no DB writes,
//                                no gateway calls
//   --apply-preview-only       : run the gateway PREVIEW for each eligible
//                                source bag, which may stage a PENDING
//                                zoho_raw_bag_receives row via the
//                                existing preview action. NEVER commits.
//   --inventory-bag-id=<id>    : limit to one bag
//   --finished-lot-id=<id>     : limit to all source bags of one lot
//   --limit=<n>                : cap how many bags we touch
//
// Hard rules (enforced unconditionally):
//   - We never commit a Zoho receive.
//   - We never call any production-output commit.
//   - We never flip env gates.
//   - We never operate on a bag without genealogy + Zoho mapping.
//   - We refuse to run if ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=true
//     AND --apply-preview-only — the operator should not pair a backfill
//     sweep with live writes enabled. (Preview-only mode does not need
//     live writes enabled; this is a paranoia check.)
//
// This script does NOT call the gateway directly. The "--apply-preview-only"
// path is reserved for the eventual integration: it currently logs
// what it WOULD do (the bag id + idempotency key) and exits without
// writing. Wiring it to the staging-actions module is a follow-up
// patch — kept out of this dry-run to keep the safety surface minimal.

import { parseArgs } from "node:util";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLotRawBags,
  finishedLots,
  inventoryBags,
  poLines,
  products,
  purchaseOrders,
  receives,
  smallBoxes,
  tabletTypes,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import { buildBagFinishReceiveIdempotencyKey } from "@/lib/zoho/source-receipt-evidence";

type Candidate = {
  inventoryBagId: string;
  internalReceiptNumber: string | null;
  finishedLotId: string;
  finishedLotNumber: string | null;
  productSku: string | null;
  zohoPoId: string;
  zohoLineItemId: string;
  tabletZohoItemId: string;
  consumedQty: number;
  alreadyHasZrbr: boolean;
  alreadyCommitted: boolean;
};

function envIsTrue(name: string): boolean {
  return (process.env[name] ?? "").toLowerCase() === "true";
}

async function loadCandidates(opts: {
  bagId?: string;
  lotId?: string;
  limit?: number;
}): Promise<Candidate[]> {
  // base: distinct (bag, lot, qty) from finished_lot_raw_bags
  const rows = await db
    .selectDistinct({
      inventoryBagId: finishedLotRawBags.inventoryBagId,
      finishedLotId: finishedLotRawBags.finishedLotId,
      consumedQty: finishedLotRawBags.quantityConsumedPills,
    })
    .from(finishedLotRawBags);

  let candidates = rows;
  if (opts.bagId) {
    candidates = candidates.filter((r) => r.inventoryBagId === opts.bagId);
  }
  if (opts.lotId) {
    candidates = candidates.filter((r) => r.finishedLotId === opts.lotId);
  }

  if (candidates.length === 0) return [];

  const bagIds = candidates
    .map((r) => r.inventoryBagId)
    .filter((id): id is string => id != null);

  const chains = await db
    .select({
      bagId: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      bagStatus: inventoryBags.status,
      receiveId: receives.id,
      zohoPoId: purchaseOrders.zohoPoId,
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
  const chainByBag = new Map(chains.map((c) => [c.bagId, c]));

  const lotIds = Array.from(new Set(candidates.map((r) => r.finishedLotId)));
  const lots = await db
    .select({
      id: finishedLots.id,
      number: finishedLots.finishedLotNumber,
      sku: products.sku,
    })
    .from(finishedLots)
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .where(inArray(finishedLots.id, lotIds));
  const lotById = new Map(lots.map((l) => [l.id, l]));

  const zrbrRows = await db
    .select({
      inventoryBagId: zohoRawBagReceives.inventoryBagId,
      zohoReceiveStatus: zohoRawBagReceives.zohoReceiveStatus,
      voidedAt: zohoRawBagReceives.voidedAt,
    })
    .from(zohoRawBagReceives)
    .where(inArray(zohoRawBagReceives.inventoryBagId, bagIds));
  const activeZrbr = zrbrRows.filter((r) => r.voidedAt == null);
  const committedBags = new Set(
    activeZrbr
      .filter((r) => r.zohoReceiveStatus === "COMMITTED")
      .map((r) => r.inventoryBagId),
  );
  const anyZrbrBags = new Set(activeZrbr.map((r) => r.inventoryBagId));

  const out: Candidate[] = [];
  for (const r of candidates) {
    if (!r.inventoryBagId || r.consumedQty == null) continue;
    const chain = chainByBag.get(r.inventoryBagId);
    if (!chain) continue;
    if (chain.bagStatus === "VOIDED") continue;
    if (!chain.zohoPoId || !chain.zohoLineItemId || !chain.tabletZohoItemId) {
      continue;
    }
    const lot = lotById.get(r.finishedLotId);
    out.push({
      inventoryBagId: r.inventoryBagId,
      internalReceiptNumber: chain.internalReceiptNumber,
      finishedLotId: r.finishedLotId,
      finishedLotNumber: lot?.number ?? null,
      productSku: lot?.sku ?? null,
      zohoPoId: chain.zohoPoId,
      zohoLineItemId: chain.zohoLineItemId,
      tabletZohoItemId: chain.tabletZohoItemId,
      consumedQty: r.consumedQty,
      alreadyHasZrbr: anyZrbrBags.has(r.inventoryBagId),
      alreadyCommitted: committedBags.has(r.inventoryBagId),
    });
  }

  const limited =
    opts.limit != null && opts.limit > 0 ? out.slice(0, opts.limit) : out;
  return limited;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "apply-preview-only": { type: "boolean", default: false },
      "inventory-bag-id": { type: "string" },
      "finished-lot-id": { type: "string" },
      limit: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const applyPreviewOnly = values["apply-preview-only"] === true;

  if (
    applyPreviewOnly &&
    envIsTrue("ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED")
  ) {
    console.error(
      "REFUSE: --apply-preview-only requires ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=false. Disable live-receive commits before staging previews.",
    );
    process.exit(2);
  }

  const candidates = await loadCandidates({
    bagId: values["inventory-bag-id"],
    lotId: values["finished-lot-id"],
    limit: values.limit ? Number(values.limit) : undefined,
  });

  const stageable = candidates.filter(
    (c) => !c.alreadyCommitted,
  );
  const newPreviews = stageable.filter((c) => !c.alreadyHasZrbr);

  console.log("---PLAN---");
  console.log(
    JSON.stringify(
      {
        mode: applyPreviewOnly ? "apply-preview-only" : "dry-run",
        filter: {
          inventoryBagId: values["inventory-bag-id"] ?? null,
          finishedLotId: values["finished-lot-id"] ?? null,
          limit: values.limit ? Number(values.limit) : null,
        },
        env_safety: {
          ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED:
            process.env.ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED ?? null,
          ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED:
            process.env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED ?? null,
          ZOHO_DRY_RUN_WRITES_ENABLED:
            process.env.ZOHO_DRY_RUN_WRITES_ENABLED ?? null,
        },
        candidates_total: candidates.length,
        already_committed: candidates.length - stageable.length,
        already_staged_pending: stageable.length - newPreviews.length,
        new_previews_to_stage: newPreviews.length,
      },
      null,
      2,
    ),
  );

  console.log("---CANDIDATES---");
  for (const c of candidates) {
    const idem = buildBagFinishReceiveIdempotencyKey(c.inventoryBagId);
    console.log(
      JSON.stringify({
        inventory_bag_id: c.inventoryBagId,
        internal_receipt_number: c.internalReceiptNumber,
        finished_lot_number: c.finishedLotNumber,
        finished_lot_id: c.finishedLotId,
        product_sku: c.productSku,
        consumed_qty: c.consumedQty,
        zoho_po_id: c.zohoPoId,
        zoho_po_line_id: c.zohoLineItemId,
        tablet_zoho_item_id: c.tabletZohoItemId,
        idempotency_key: idem,
        already_committed: c.alreadyCommitted,
        already_has_zrbr: c.alreadyHasZrbr,
        action: c.alreadyCommitted
          ? "skip:already-committed"
          : c.alreadyHasZrbr
            ? "skip:already-staged"
            : applyPreviewOnly
              ? "would-stage-pending-preview (NOT IMPLEMENTED — see comment at top of script)"
              : "dry-run:would-stage-pending-preview",
      }),
    );
  }

  if (applyPreviewOnly) {
    console.log("---NOTE---");
    console.log(
      "apply-preview-only mode is currently a NO-OP at the action layer. " +
        "Wiring it to the staging-actions module requires explicit owner approval; " +
        "the dry-run output above is exactly the work that would be performed.",
    );
  }

  console.log("---DONE---");
}

main()
  .catch((err) => {
    console.error("FATAL", err);
    process.exit(1);
  })
  .then(() => {
    void sql; // keep sql imported for future inline queries
    process.exit(0);
  });
