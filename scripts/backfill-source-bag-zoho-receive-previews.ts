// SOURCE-BAG-RECEIVE-PREVIEW-BACKFILL-v1.29.4 — dry-run by default.
//
// Modes:
//   (default — dry-run)          : describe what would happen, no DB writes,
//                                  no gateway calls
//   --apply-preview-only         : for each eligible source bag, seed a PENDING
//                                  zoho_raw_bag_receives row (idempotent) and
//                                  freeze the gateway payload. NEVER commits.
//                                  Requires --acknowledge-live-pipeline.
//   --acknowledge-live-pipeline  : required companion to --apply-preview-only.
//                                  Confirms the operator understands that the
//                                  Zoho pipeline is live and the auto-commit
//                                  sweep may pick up seeded rows once
//                                  auto_commit_eligible_at passes.
//   --stamp-eligible-now         : after seeding, set auto_commit_eligible_at =
//                                  now() on every row seeded THIS RUN (only),
//                                  bypassing the 24h buffer so the next sweep
//                                  can pick them up immediately. Writes one
//                                  audit row per stamped row (action:
//                                  zoho_raw_bag_receive.auto_commit_eligibility_stamped).
//                                  Off by default; only valid with --apply-preview-only.
//   --inventory-bag-id=<id>      : limit to one bag
//   --finished-lot-id=<id>       : limit to all source bags of one lot
//   --po=<po_number>             : limit to source bags whose receive PO matches
//                                  this PO number (repeatable, comma-separated,
//                                  or both: --po=PO-00206 --po=PO-00238)
//   --limit=<n>                  : cap how many bags we touch (applied after
//                                  all other filters)
//
// Hard rules (enforced unconditionally):
//   - We never commit a Zoho receive.
//   - We never call any production-output commit.
//   - We never flip env gates.
//   - We never operate on a bag without genealogy + Zoho mapping.
//   - We never write to the legacy SQLite.

import { parseArgs } from "node:util";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
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
import { seedPendingRawBagReceiveRows } from "@/lib/zoho/raw-bag-intake-receive";

type Candidate = {
  inventoryBagId: string;
  receiveId: string;
  internalReceiptNumber: string | null;
  poNumber: string | null;
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

/** Parse --po values: supports comma-separated and/or repeated flags. */
export function parsePoFilter(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.flatMap((v) => v.split(",").map((s) => s.trim())).filter(Boolean);
}

async function loadCandidates(opts: {
  bagId?: string;
  lotId?: string;
  poNumbers?: string[];
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
      poNumber: purchaseOrders.poNumber,
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

  const poFilter =
    opts.poNumbers && opts.poNumbers.length > 0
      ? new Set(opts.poNumbers)
      : null;

  const out: Candidate[] = [];
  for (const r of candidates) {
    if (!r.inventoryBagId || r.consumedQty == null) continue;
    const chain = chainByBag.get(r.inventoryBagId);
    if (!chain) continue;
    if (chain.bagStatus === "VOID") continue;
    if (!chain.zohoPoId || !chain.zohoLineItemId || !chain.tabletZohoItemId) {
      continue;
    }
    if (!chain.receiveId) continue;
    // --po filter: skip bags whose PO number is not in the allowed set
    if (poFilter && !poFilter.has(chain.poNumber ?? "")) continue;
    const lot = lotById.get(r.finishedLotId);
    out.push({
      inventoryBagId: r.inventoryBagId,
      receiveId: chain.receiveId,
      internalReceiptNumber: chain.internalReceiptNumber,
      poNumber: chain.poNumber ?? null,
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
      "acknowledge-live-pipeline": { type: "boolean", default: false },
      "stamp-eligible-now": { type: "boolean", default: false },
      "inventory-bag-id": { type: "string" },
      "finished-lot-id": { type: "string" },
      po: { type: "string", multiple: true },
      limit: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const applyPreviewOnly = values["apply-preview-only"] === true;
  const acknowledgeLivePipeline = values["acknowledge-live-pipeline"] === true;
  const stampEligibleNow = values["stamp-eligible-now"] === true;

  // Guard: --stamp-eligible-now is only valid alongside --apply-preview-only
  if (stampEligibleNow && !applyPreviewOnly) {
    console.error(
      "REFUSE: --stamp-eligible-now is only valid with --apply-preview-only.",
    );
    process.exit(2);
  }

  // Guard: --apply-preview-only requires explicit acknowledgment that the
  // Zoho pipeline is live. The old era-specific guard (refusing when
  // ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=true) is replaced by this flag
  // because the pipeline is now always live in prod and that guard would
  // unconditionally refuse. The operator must explicitly pass
  // --acknowledge-live-pipeline to proceed with real writes.
  if (applyPreviewOnly && !acknowledgeLivePipeline) {
    console.error(
      "REFUSE: --apply-preview-only requires --acknowledge-live-pipeline.\n" +
        "The Zoho raw-bag-receive pipeline is live. Seeding PENDING rows makes\n" +
        "them eligible for auto-commit by the sweep once auto_commit_eligible_at\n" +
        "passes (or immediately if --stamp-eligible-now is also passed).\n" +
        "Re-run with --acknowledge-live-pipeline to confirm and proceed.",
    );
    process.exit(2);
  }

  const poNumbers = parsePoFilter(values["po"]);

  const loadOpts: {
    bagId?: string;
    lotId?: string;
    poNumbers?: string[];
    limit?: number;
  } = {};
  if (values["inventory-bag-id"] !== undefined)
    loadOpts.bagId = values["inventory-bag-id"];
  if (values["finished-lot-id"] !== undefined)
    loadOpts.lotId = values["finished-lot-id"];
  if (poNumbers.length > 0) loadOpts.poNumbers = poNumbers;
  if (values.limit !== undefined) loadOpts.limit = Number(values.limit);

  const candidates = await loadCandidates(loadOpts);

  const stageable = candidates.filter((c) => !c.alreadyCommitted);
  const newPreviews = stageable.filter((c) => !c.alreadyHasZrbr);

  console.log("---PLAN---");
  console.log(
    JSON.stringify(
      {
        mode: applyPreviewOnly ? "apply-preview-only" : "dry-run",
        filter: {
          inventoryBagId: values["inventory-bag-id"] ?? null,
          finishedLotId: values["finished-lot-id"] ?? null,
          po: poNumbers.length > 0 ? poNumbers : null,
          limit: values.limit ? Number(values.limit) : null,
        },
        flags: {
          acknowledgeLivePipeline,
          stampEligibleNow,
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

  // Per-bag line output (dry-run: describe only)
  if (!applyPreviewOnly) {
    console.log("---CANDIDATES---");
    for (const c of candidates) {
      const idem = buildBagFinishReceiveIdempotencyKey(c.inventoryBagId);
      const action = c.alreadyCommitted
        ? "skip:already-committed"
        : c.alreadyHasZrbr
          ? "skip:already-staged"
          : "dry-run:would-seed-pending";
      console.log(
        JSON.stringify({
          receipt: c.internalReceiptNumber,
          po: c.poNumber,
          inventory_bag_id: c.inventoryBagId,
          finished_lot_number: c.finishedLotNumber,
          product_sku: c.productSku,
          consumed_qty: c.consumedQty,
          idempotency_key: idem,
          action,
        }),
      );
    }
    console.log("---DONE (dry-run)---");
    return;
  }

  // Apply mode: seed PENDING rows for eligible bags
  console.log("---APPLYING---");

  const seededBagIds: string[] = [];
  let countSeeded = 0;
  let countSkippedExisting = 0;
  let countSkippedCommitted = 0;

  for (const c of candidates) {
    if (c.alreadyCommitted) {
      countSkippedCommitted++;
      console.log(
        JSON.stringify({
          receipt: c.internalReceiptNumber,
          po: c.poNumber,
          inventory_bag_id: c.inventoryBagId,
          action: "skipped-committed",
        }),
      );
      continue;
    }
    if (c.alreadyHasZrbr) {
      countSkippedExisting++;
      console.log(
        JSON.stringify({
          receipt: c.internalReceiptNumber,
          po: c.poNumber,
          inventory_bag_id: c.inventoryBagId,
          action: "skipped-existing",
        }),
      );
      continue;
    }

    // Seed the PENDING row (idempotent: seedPendingRawBagReceiveRows skips
    // bags that already have a row, so a re-run after partial failure is safe).
    await seedPendingRawBagReceiveRows(
      [
        {
          inventoryBagId: c.inventoryBagId,
          receiveId: c.receiveId,
          declaredPillCount: c.consumedQty,
          zohoPoId: c.zohoPoId,
          zohoLineItemId: c.zohoLineItemId,
        },
      ],
      null, // null actor: backfill script; provenance captured in audit via action name
    );

    seededBagIds.push(c.inventoryBagId);
    countSeeded++;
    console.log(
      JSON.stringify({
        receipt: c.internalReceiptNumber,
        po: c.poNumber,
        inventory_bag_id: c.inventoryBagId,
        action: "seeded",
      }),
    );
  }

  // --stamp-eligible-now: advance auto_commit_eligible_at on rows seeded
  // THIS RUN only. Does not touch rows seeded by prior runs.
  if (stampEligibleNow && seededBagIds.length > 0) {
    console.log("---STAMPING-ELIGIBLE-NOW---");
    const now = new Date();

    // Load the zrbr row IDs for the bags we just seeded
    const zrbrRows = await db
      .select({
        id: zohoRawBagReceives.id,
        inventoryBagId: zohoRawBagReceives.inventoryBagId,
      })
      .from(zohoRawBagReceives)
      .where(inArray(zohoRawBagReceives.inventoryBagId, seededBagIds));

    for (const row of zrbrRows) {
      await db
        .update(zohoRawBagReceives)
        .set({ autoCommitEligibleAt: now, updatedAt: now })
        .where(eq(zohoRawBagReceives.id, row.id));

      await writeAudit({
        actorId: null,
        actorRole: null,
        action: "zoho_raw_bag_receive.auto_commit_eligibility_stamped",
        targetType: "ZohoRawBagReceive",
        targetId: row.id,
        after: {
          reason: "backfill run with --stamp-eligible-now",
          autoCommitEligibleAt: now.toISOString(),
          inventoryBagId: row.inventoryBagId,
        },
      });

      console.log(
        JSON.stringify({
          inventory_bag_id: row.inventoryBagId,
          zrbr_id: row.id,
          action: "stamped-eligible-now",
          auto_commit_eligible_at: now.toISOString(),
        }),
      );
    }
  }

  console.log("---SUMMARY---");
  console.log(
    JSON.stringify({
      seeded: countSeeded,
      "skipped-existing": countSkippedExisting,
      "skipped-committed": countSkippedCommitted,
      stamped_eligible_now: stampEligibleNow ? seededBagIds.length : 0,
    }),
  );
  console.log("---DONE---");
}

main()
  .catch((err) => {
    console.error("FATAL", err);
    process.exit(1);
  })
  .then(() => {
    void sql; // keep sql imported for future inline queries
    void envIsTrue; // referenced above
    process.exit(0);
  });
