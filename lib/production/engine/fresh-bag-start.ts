// SCAN-FIRST-1 — what the operator screen needs to start a bag that
// does not exist yet.
//
// WHY THIS EXISTS. claimQueuedBag takes a workflowBagId: it claims a bag
// the queue already knows about. An intake-reserved RAW_BAG card has no
// workflow_bags row at all — the bag is CREATED by the first scan
// (scanCardAction's INSERT). So the cutover's one scan gesture has two
// possible meanings, and only a lookup can tell them apart:
//
//   card -> assigned workflow bag   => claim it (claimQueuedBag)
//   card -> no workflow bag yet     => start it (scanCardAction)
//
// Before the cutover the screen could only do the first, which would
// have left every first-operation station unable to start work.
//
// WHAT THIS MODULE DOES NOT DO. It writes nothing. scanCardAction still
// owns the start transaction (bag INSERT + CARD_ASSIGNED + PRODUCT_MAPPED
// + the raw-bag allocation session + audit), including the partial-reuse
// confirmation gate and the LOW-confidence supervisor rule. This module
// answers the two questions the SCREEN must resolve before calling it:
// which card was scanned, and whether this station kind has to ask for a
// product first.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { inventoryBags, qrCards } from "@/lib/db/schema";
import {
  FIRST_OP_STATION_KINDS,
  PRODUCT_AT_START_STATION_KINDS,
} from "@/lib/production/first-op-product";
import { loadCompatibleProductsForStation } from "./station-view";
import type { ProductOption } from "./types";

export type FreshBagStart = {
  /** qr_cards.id — what scanCardAction takes. */
  cardId: string;
  /** True when this station kind must record the finished product at
   *  start (BOTTLE_HANDPACK only — the card route defers product
   *  identity to sealing, PRODUCT-SELECTION-AT-SEALING-1). */
  needsProduct: boolean;
  /** The products the operator may choose from when needsProduct.
   *  Empty otherwise, and empty-with-needsProduct means master data has
   *  no compatible product — scanCardAction's own refusal says so
   *  properly, so this module does not invent a message. */
  options: ProductOption[];
};

/** Resolve a scanned/typed QR string to a startable RAW_BAG card.
 *
 *  Null when the token matches no card, matches a card that already
 *  carries a workflow bag (that is a CLAIM, not a start), or is scanned
 *  at a station kind that does not start fresh bags. Read-only. */
export async function resolveFreshBagStart(args: {
  scanToken: string;
  stationKind: string;
}): Promise<FreshBagStart | null> {
  if (!FIRST_OP_STATION_KINDS.has(args.stationKind)) return null;
  const token = args.scanToken.trim();
  if (!token) return null;

  const [card] = await db
    .select({
      id: qrCards.id,
      tabletTypeId: inventoryBags.tabletTypeId,
    })
    .from(qrCards)
    // The intake link is by scan token, the same join receiving writes
    // (inventory_bags.bag_qr_code). A card with no linked bag still
    // resolves here: scanCardAction refuses it with the operator-facing
    // "receive the bag first" message, which is better than this
    // function silently answering "not recognized".
    .leftJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    .where(
      and(
        eq(qrCards.scanToken, token),
        eq(qrCards.cardType, "RAW_BAG"),
        isNull(qrCards.assignedWorkflowBagId),
      ),
    )
    .limit(1);
  if (!card) return null;

  const needsProduct = PRODUCT_AT_START_STATION_KINDS.has(args.stationKind);
  const options =
    needsProduct && card.tabletTypeId
      ? await loadCompatibleProductsForStation({
          tabletTypeId: card.tabletTypeId,
          stationKind: args.stationKind,
        })
      : [];
  return { cardId: card.id, needsProduct, options };
}
