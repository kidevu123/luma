// Receipt 352171 bag 2 (MIT B Orange Citrus, QR bag-card-104) — the bag was
// split across two physical production runs. Run 1 (Hyroxi MIT B - Sun Drip)
// is recorded. Run 2 (FIX Beyond - Citrus Drift: hand-packed blisters, sealed
// on Sealing Machine 3, counter 1159, packed 7 master cases with nothing
// remaining) was physically completed but never recorded on the floor PWA.
// A third restart run was created on 2026-07-07 while attempting to enter the
// data; it carries no production output and must be removed.
//
// This script, in one transaction:
//   1. Deletes the erroneous third run (workflow bag + its OPEN allocation
//      session; workflow_events / read models cascade).
//   2. Re-points QR card bag-card-104 at run 2.
//   3. Seeds run 2 with the missing SEALING + PACKAGING event chain via
//      projectEvent (read models stay consistent), replicating the floor
//      action write-path with back-dated timestamps (2026-06-03 evening ET).
//   4. Emits count-based packaging consumption exactly like the floor path
//      (FIX Beyond BOM: display + card). Sealing-time blister-card issuance
//      is SKIPPED with reason no_bom_blister_card — the product's card
//      material is category PACKAGING, not MATERIAL, so the floor path
//      records the skip flags on SEALING_SEGMENT_COMPLETE (same as run 1).
//   5. Auto-creates and releases the finished lot, closing a repair-opened
//      allocation session from output math (840 units x 4 tablets = 3360).
//   6. Releases the QR card to the pool — supervisor attests the bag is
//      physically empty after this run.
//
// Zoho note: finished-lot post-commit enqueue effects are intentionally NOT
// run — no zoho_* op rows are created (matching run 1). PO closeout handles
// Zoho output separately.
//
// Dry-run (default):
//   npx tsx scripts/repair-receipt-352171-run2-seal-pack-backfill.ts
// Apply:
//   ALLOW_PRODUCTION_REPAIR=true \
//   CONFIRM_SEED_BAG=4cb0ed2f-6f4c-460a-81fa-e191fceb4a70 \
//   CONFIRM_DELETE_BAG=48c936ea-df3f-4e88-b016-06ae85fd87a6 \
//   CONFIRM_BAG_CARD=bag-card-104 \
//   npx tsx scripts/repair-receipt-352171-run2-seal-pack-backfill.ts --apply

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  packagingLots,
  products,
  qrCards,
  rawBagAllocationSessions,
  readBagState,
  readStationLive,
  stations,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { autoCreateAndReleaseFinishedLotForWorkflowBag } from "@/lib/db/queries/finished-lots";
import { projectEvent } from "@/lib/projector";
import { emitCountBasedPackagingConsumption } from "@/lib/projector/packaging-consumption-hook";
import { refreshMaterialReadModelsAfterConsumption } from "@/lib/projector/material-read-model-refresh";
import {
  buildPackagingConsumptionPayloadSummary,
  patchPackagingCompleteConsumptionSummary,
} from "@/lib/production/packaging-consumption-summary";
import { lookupProductMatchedBlisterCardLot } from "@/lib/production/handpack-seal-material";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const REPAIR_SCRIPT_VERSION =
  "receipt-352171-run2-seal-pack-backfill-v1";

const TARGET = {
  inventoryBagId: "a23bec0d-36e8-4b65-a172-a605eb22c559",
  receiptNumber: "352171",
  bagNumber: 2,
  bagCardToken: "bag-card-104",
  qrCardId: "7e739186-416c-4586-adbd-9dffeb62c193",
  run1BagId: "3d026c01-4521-4825-9c08-3e8e9bd87196", // untouched
  seedBagId: "4cb0ed2f-6f4c-460a-81fa-e191fceb4a70", // run 2 — seed here
  deleteBagId: "48c936ea-df3f-4e88-b016-06ae85fd87a6", // run 3 — delete
  deleteAllocationSessionId: "f58d863b-d818-4649-8042-3a007a4507c5",
  run2ClosedAllocationSessionId: "64eedae5-b695-4659-91c0-981085e9f257",
  productId: "1bf16bff-4909-406b-8607-10261749712d", // FIX Beyond - Citrus Drift
  sealingStationId: "f8f8db79-dfbd-4ba5-8c83-ae20064a3f6f", // Sealing Station 3
  packagingStationId: "c174b1e0-4daf-4eb5-927b-622dd8038553", // Packaging Station
  sealedCountTotal: 1159, // operator-reported machine counter, recorded verbatim
  masterCases: 7,
  displaysMade: 0,
  looseCards: 0,
  damagedPackaging: 0,
  rippedCards: 0,
} as const;

// 2026-06-03 evening America/New_York (6:35pm–7:50pm ET).
const T = {
  pickupSealing: new Date("2026-06-03T22:35:00Z"),
  productMapped: new Date("2026-06-03T22:36:00Z"),
  sealingSegment: new Date("2026-06-03T23:20:00Z"),
  sealingComplete: new Date("2026-06-03T23:22:00Z"),
  sealingReleased: new Date("2026-06-03T23:22:05Z"),
  pickupPackaging: new Date("2026-06-03T23:30:00Z"),
  packagingComplete: new Date("2026-06-03T23:50:00Z"),
  finalized: new Date("2026-06-03T23:50:05Z"),
} as const;

const AUDIT_REASON =
  "Split-bag receipt 352171 run 2 (FIX Beyond - Citrus Drift) was physically " +
  "completed on 2026-06-03 but never recorded on the floor PWA. Backfilled by " +
  "admin request; erroneous 2026-07-07 restart run removed. Sealed count 1159 " +
  "is the operator-reported machine counter, recorded verbatim.";

const ACCOUNTABILITY = {
  enteredByUserId: null as string | null,
  accountableEmployeeId: null as string | null,
  accountabilitySource: "MANUAL_TEXT" as const,
  accountableEmployeeNameSnapshot: REPAIR_SCRIPT_VERSION,
};

const BACKFILL_MARKERS = {
  backfill_source: REPAIR_SCRIPT_VERSION,
  audit_reason: AUDIT_REASON,
} as const;

function section(title: string, body: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

type EventRow = { eventType: string; occurredAt: Date | string };

async function loadEvents(bagId: string): Promise<EventRow[]> {
  return db
    .select({
      eventType: workflowEvents.eventType,
      occurredAt: workflowEvents.occurredAt,
    })
    .from(workflowEvents)
    .where(eq(workflowEvents.workflowBagId, bagId))
    .orderBy(workflowEvents.occurredAt);
}

type Abort = { ok: false; reason: string };
type Verified = {
  ok: true;
  productSku: string | null;
  productName: string;
  cardLotId: string;
  cardLotOnHand: number;
  displayLotId: string;
  displayLotOnHand: number;
  cardQtyToConsumeAtPackaging: number;
  displayQtyToConsume: number;
  /** True only when the floor path would issue blister cards at sealing
   *  (BOM card material with category MATERIAL). FIX Beyond's card material
   *  is category PACKAGING, so the floor skips with no_bom_blister_card. */
  sealIssuesBlisterCards: boolean;
};

async function verify(): Promise<Verified | Abort> {
  const [inv] = await db
    .select({
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      bagNumber: inventoryBags.bagNumber,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, TARGET.inventoryBagId));
  if (
    inv?.internalReceiptNumber !== TARGET.receiptNumber ||
    inv.bagNumber !== TARGET.bagNumber
  ) {
    return {
      ok: false,
      reason: `Inventory bag mismatch: got receipt=${inv?.internalReceiptNumber} bag=${inv?.bagNumber}`,
    };
  }

  const [card] = await db
    .select({
      id: qrCards.id,
      status: qrCards.status,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
    })
    .from(qrCards)
    .where(eq(qrCards.scanToken, TARGET.bagCardToken));
  if (card?.id !== TARGET.qrCardId) {
    return { ok: false, reason: `QR card not found for ${TARGET.bagCardToken}` };
  }
  if (card.assignedWorkflowBagId !== TARGET.deleteBagId) {
    return {
      ok: false,
      reason: `QR card is assigned to ${card.assignedWorkflowBagId}, expected the delete-target run 3`,
    };
  }

  const seedEvents = await loadEvents(TARGET.seedBagId);
  const seedTypes = seedEvents.map((e) => e.eventType).join(",");
  if (seedTypes !== "CARD_ASSIGNED,HANDPACK_BLISTER_COMPLETE,BAG_RELEASED") {
    return {
      ok: false,
      reason: `Run 2 event chain changed, refusing: [${seedTypes}]`,
    };
  }
  const deleteEvents = await loadEvents(TARGET.deleteBagId);
  const deleteTypes = deleteEvents.map((e) => e.eventType).join(",");
  if (deleteTypes !== "CARD_ASSIGNED,HANDPACK_BLISTER_COMPLETE,BAG_RELEASED") {
    return {
      ok: false,
      reason: `Run 3 event chain changed, refusing: [${deleteTypes}]`,
    };
  }

  for (const bagId of [TARGET.seedBagId, TARGET.deleteBagId]) {
    const [state] = await db
      .select({ stage: readBagState.stage, isFinalized: readBagState.isFinalized })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, bagId));
    if (state?.stage !== "BLISTERED" || state.isFinalized) {
      return {
        ok: false,
        reason: `Bag ${bagId} not at BLISTERED/unfinalized (stage=${state?.stage})`,
      };
    }
  }

  const guards = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM material_inventory_events
        WHERE workflow_bag_id = ${TARGET.deleteBagId}::uuid) AS run3_material_events,
      (SELECT COUNT(*)::int FROM finished_lots
        WHERE workflow_bag_id IN (${TARGET.seedBagId}::uuid, ${TARGET.deleteBagId}::uuid)) AS finished_lots,
      (SELECT COUNT(*)::int FROM zoho_production_output_ops
        WHERE workflow_bag_id IN (${TARGET.seedBagId}::uuid, ${TARGET.deleteBagId}::uuid)) AS zoho_ops,
      (SELECT COUNT(*)::int FROM finished_lot_raw_bags
        WHERE workflow_bag_id = ${TARGET.deleteBagId}::uuid) AS run3_lot_links,
      (SELECT allocation_status FROM raw_bag_allocation_sessions
        WHERE id = ${TARGET.deleteAllocationSessionId}::uuid
          AND workflow_bag_id = ${TARGET.deleteBagId}::uuid) AS run3_session_status,
      (SELECT allocation_status FROM raw_bag_allocation_sessions
        WHERE id = ${TARGET.run2ClosedAllocationSessionId}::uuid
          AND workflow_bag_id = ${TARGET.seedBagId}::uuid) AS run2_session_status
  `)) as unknown as Array<{
    run3_material_events: number;
    finished_lots: number;
    zoho_ops: number;
    run3_lot_links: number;
    run3_session_status: string | null;
    run2_session_status: string | null;
  }>;
  const g = guards[0];
  if (!g) return { ok: false, reason: "Guard query returned no row" };
  if (g.run3_material_events !== 0)
    return { ok: false, reason: "Run 3 has material events — refusing delete" };
  if (g.finished_lots !== 0)
    return { ok: false, reason: "A finished lot already references run 2 or 3" };
  if (g.zoho_ops !== 0)
    return { ok: false, reason: "Zoho output ops reference run 2 or 3" };
  if (g.run3_lot_links !== 0)
    return { ok: false, reason: "finished_lot_raw_bags references run 3" };
  if (g.run3_session_status !== "OPEN")
    return {
      ok: false,
      reason: `Run 3 allocation session not OPEN (${g.run3_session_status})`,
    };
  if (g.run2_session_status !== "CLOSED")
    return {
      ok: false,
      reason: `Run 2 allocation session not CLOSED (${g.run2_session_status})`,
    };

  const [product] = await db
    .select({
      name: products.name,
      sku: products.sku,
      kind: products.kind,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
      tabletsPerUnit: products.tabletsPerUnit,
    })
    .from(products)
    .where(eq(products.id, TARGET.productId));
  if (!product || product.kind !== "CARD") {
    return { ok: false, reason: "Product missing or not a CARD product" };
  }
  if (
    product.unitsPerDisplay !== 10 ||
    product.displaysPerCase !== 12 ||
    product.tabletsPerUnit !== 4
  ) {
    return {
      ok: false,
      reason: `Product structure changed (upd=${product.unitsPerDisplay} dpc=${product.displaysPerCase} tpu=${product.tabletsPerUnit}), expected 10/12/4`,
    };
  }

  const totalDisplays = TARGET.masterCases * product.displaysPerCase; // 84
  const totalUnits = totalDisplays * product.unitsPerDisplay; // 840

  const lots = (await db.execute(sql`
    SELECT pl.id::text AS id, pm.kind::text AS kind, pl.qty_on_hand::int AS on_hand,
           pl.status::text AS status
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    JOIN product_packaging_specs pps ON pps.packaging_material_id = pm.id
    WHERE pps.product_id = ${TARGET.productId}::uuid
      AND pl.status IN ('AVAILABLE', 'IN_USE')
    ORDER BY pl.received_at ASC
  `)) as unknown as Array<{
    id: string;
    kind: string;
    on_hand: number;
    status: string;
  }>;
  const cardLot = lots.find((l) => l.kind === "BLISTER_CARD");
  const displayLot = lots.find((l) => l.kind === "DISPLAY");
  if (!cardLot || !displayLot) {
    return {
      ok: false,
      reason: `Missing packaging lots (card=${cardLot?.id}, display=${displayLot?.id})`,
    };
  }
  if (cardLot.on_hand < totalUnits) {
    return {
      ok: false,
      reason: `Blister-card lot on-hand ${cardLot.on_hand} < ${totalUnits} needed`,
    };
  }
  if (displayLot.on_hand < totalDisplays) {
    return {
      ok: false,
      reason: `Display lot on-hand ${displayLot.on_hand} < ${totalDisplays} needed`,
    };
  }

  // Predict the sealing-time issuance branch the floor path would take:
  // lookupProductMatchedBlisterCardLot requires kind BLISTER_CARD AND
  // category MATERIAL on the BOM.
  const materialCategoryCards = (await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM product_packaging_specs pps
    JOIN packaging_materials pm ON pm.id = pps.packaging_material_id
    WHERE pps.product_id = ${TARGET.productId}::uuid
      AND pm.kind = 'BLISTER_CARD'
      AND pm.category = 'MATERIAL'
  `)) as unknown as Array<{ n: number }>;
  const sealIssuesBlisterCards = (materialCategoryCards[0]?.n ?? 0) > 0;

  return {
    ok: true,
    productSku: product.sku,
    productName: product.name,
    cardLotId: cardLot.id,
    cardLotOnHand: cardLot.on_hand,
    displayLotId: displayLot.id,
    displayLotOnHand: displayLot.on_hand,
    cardQtyToConsumeAtPackaging: totalUnits,
    displayQtyToConsume: totalDisplays,
    sealIssuesBlisterCards,
  };
}

function buildProposal(v: Verified) {
  return {
    delete: {
      workflowBag: TARGET.deleteBagId,
      cascades: [
        "3 workflow_events (CARD_ASSIGNED, HANDPACK_BLISTER_COMPLETE, BAG_RELEASED)",
        "read_bag_state row",
      ],
      allocationSession: TARGET.deleteAllocationSessionId,
      allocationSessionCascades: ["1 raw_bag_allocation_events row (RAW_BAG_OPENED)"],
    },
    qrCard: {
      id: TARGET.qrCardId,
      step1: `reassign from run 3 to run 2 (${TARGET.seedBagId})`,
      step2:
        "after finalize + allocation close: release to IDLE / unassigned (supervisor attests bag physically empty)",
    },
    seedRun2: {
      workflowBag: TARGET.seedBagId,
      setProductId: `${TARGET.productId} (${v.productName})`,
      events: [
        `${T.pickupSealing.toISOString()} BAG_PICKED_UP @ Sealing Station 3 {from_stage: BLISTERED}`,
        `${T.productMapped.toISOString()} PRODUCT_MAPPED {source: SEALING_SELECTION, ${v.productSku}}`,
        v.sealIssuesBlisterCards
          ? `${T.sealingSegment.toISOString()} SEALING_SEGMENT_COMPLETE {count_total: ${TARGET.sealedCountTotal}, count_source: OPERATOR_REPORTED_MACHINE_COUNTER}`
          : `${T.sealingSegment.toISOString()} SEALING_SEGMENT_COMPLETE {count_total: ${TARGET.sealedCountTotal}, count_source: OPERATOR_REPORTED_MACHINE_COUNTER, handpack_blister_material_skipped: true, handpack_blister_material_skip_reason: no_bom_blister_card}`,
        ...(v.sealIssuesBlisterCards
          ? [
              `${T.sealingSegment.toISOString()} PACKAGING_MATERIAL_ISSUED {handpack_seal: ${TARGET.sealedCountTotal} blister cards from lot ${v.cardLotId}}`,
            ]
          : []),
        `${T.sealingComplete.toISOString()} SEALING_COMPLETE {lane_close: true}`,
        `${T.sealingReleased.toISOString()} BAG_RELEASED {released_at_stage: SEALED}`,
        `${T.pickupPackaging.toISOString()} BAG_PICKED_UP @ Packaging Station {from_stage: SEALED}`,
        `${T.packagingComplete.toISOString()} PACKAGING_COMPLETE {master_cases: 7, displays_made: 0, loose_cards: 0, damaged_packaging: 0, ripped_cards: 0}`,
        `${T.finalized.toISOString()} BAG_FINALIZED`,
      ],
    },
    materialConsumption: {
      atSealing: v.sealIssuesBlisterCards
        ? `qty_on_hand decrement: blister-card lot ${v.cardLotId} -${TARGET.sealedCountTotal} (${v.cardLotOnHand} -> ${v.cardLotOnHand - TARGET.sealedCountTotal})`
        : "none — floor path skips sealing-time card issuance (no_bom_blister_card: card material is category PACKAGING). Same as run 1.",
      atPackaging: [
        `MATERIAL_CONSUMED_ACTUAL display lot ${v.displayLotId}: ${v.displayQtyToConsume} (event only; on-hand ${v.displayLotOnHand} unchanged — matches floor path)`,
        `MATERIAL_CONSUMED_ACTUAL blister-card lot ${v.cardLotId}: ${v.cardQtyToConsumeAtPackaging} (event only — matches floor path)`,
      ],
    },
    finishedLot: {
      action:
        "auto-create + RELEASE (units 840, displays 84, cases 7); allocation session repair-opened then closed OUTPUT_DERIVED (start 3598, consumed 3360, ending 238)",
      zoho: "post-commit enqueue effects intentionally skipped — no zoho op rows",
    },
    readModels:
      "read_bag_state -> FINALIZED; read_bag_metrics snapshot; read_daily_throughput 2026-06-03 (bags_sealed @ machine 3, bags_packaged, bags_finalized +840 units); SKU daily + material reconciliation refreshed; read_station_live snapshotted and restored",
    untouched: `run 1 ${TARGET.run1BagId}; run 2 CLOSED allocation session ${TARGET.run2ClosedAllocationSessionId} (kept as history)`,
  };
}

async function apply(v: Verified): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    const stationLiveBefore = await tx
      .select()
      .from(readStationLive)
      .where(
        sql`${readStationLive.stationId} IN (${TARGET.sealingStationId}::uuid, ${TARGET.packagingStationId}::uuid)`,
      );

    // 1. Remove the erroneous third run.
    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_backfill.receipt_352171_run3_deleted",
        targetType: "WorkflowBag",
        targetId: TARGET.deleteBagId,
        before: {
          workflow_bag_id: TARGET.deleteBagId,
          allocation_session_id: TARGET.deleteAllocationSessionId,
          events: ["CARD_ASSIGNED", "HANDPACK_BLISTER_COMPLETE", "BAG_RELEASED"],
        },
        after: { deleted: true, audit_reason: AUDIT_REASON },
      },
      tx,
    );
    await tx
      .delete(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.id, TARGET.deleteAllocationSessionId));
    await tx.delete(workflowBags).where(eq(workflowBags.id, TARGET.deleteBagId));

    // 2. Re-point the QR card at run 2.
    await tx
      .update(qrCards)
      .set({ assignedWorkflowBagId: TARGET.seedBagId, status: "ASSIGNED" })
      .where(eq(qrCards.id, TARGET.qrCardId));

    // 3. Seed the sealing chain (mirrors fireStageEventAction /
    //    saveSealingProductAction with back-dated timestamps).
    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.sealingStationId,
      eventType: "BAG_PICKED_UP",
      occurredAt: T.pickupSealing,
      payload: {
        from_stage: "BLISTERED",
        qr_card_id: TARGET.qrCardId,
        station_kind: "SEALING",
        ...BACKFILL_MARKERS,
      },
      ...ACCOUNTABILITY,
    });

    await tx
      .update(workflowBags)
      .set({ productId: TARGET.productId })
      .where(eq(workflowBags.id, TARGET.seedBagId));
    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.sealingStationId,
      eventType: "PRODUCT_MAPPED",
      occurredAt: T.productMapped,
      payload: {
        source: "SEALING_SELECTION",
        product_id: TARGET.productId,
        product_sku: v.productSku,
        product_kind: "CARD",
        product_name: v.productName,
        station_kind: "SEALING",
        ...BACKFILL_MARKERS,
      },
      ...ACCOUNTABILITY,
    });

    // Resolve the sealing-time blister-card issuance branch exactly like the
    // floor path does (lookup requires BOM card with category MATERIAL), and
    // refuse if it disagrees with what the dry-run predicted.
    const lotLookup = await lookupProductMatchedBlisterCardLot(
      TARGET.seedBagId,
      tx,
    );
    const lookupIssues = lotLookup.status === "found";
    if (lookupIssues !== v.sealIssuesBlisterCards) {
      throw new Error(
        `Blister-card lot resolution changed mid-apply (${JSON.stringify(lotLookup)})`,
      );
    }

    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.sealingStationId,
      eventType: "SEALING_SEGMENT_COMPLETE",
      occurredAt: T.sealingSegment,
      payload: {
        count_total: TARGET.sealedCountTotal,
        count_source: "OPERATOR_REPORTED_MACHINE_COUNTER",
        ...(lotLookup.status === "skipped"
          ? {
              handpack_blister_material_skipped: true,
              handpack_blister_material_skip_reason: lotLookup.reason,
            }
          : {}),
        ...BACKFILL_MARKERS,
      },
      ...ACCOUNTABILITY,
    });

    // Hand-pack blister-card issue (inline replica of
    // issueHandpackBlisterCardMaterial so occurred_at can be back-dated).
    // Skipped for FIX Beyond: its card material is category PACKAGING, so
    // the floor path records the skip flags above instead (same as run 1).
    let issueQty = 0;
    if (lotLookup.status === "found") {
      if (lotLookup.lot.id !== v.cardLotId) {
        throw new Error(
          `Blister-card lot changed mid-apply (${lotLookup.lot.id} != ${v.cardLotId})`,
        );
      }
      issueQty = Math.min(TARGET.sealedCountTotal, lotLookup.lot.qtyOnHand);
      await projectEvent(tx, {
        workflowBagId: TARGET.seedBagId,
        stationId: TARGET.sealingStationId,
        eventType: "PACKAGING_MATERIAL_ISSUED",
        occurredAt: T.sealingSegment,
        payload: {
          packaging_lot_id: lotLookup.lot.id,
          qty_issued: issueQty,
          reason: "handpack_seal",
          ...BACKFILL_MARKERS,
        },
        ...ACCOUNTABILITY,
      });
      await tx
        .update(packagingLots)
        .set({ qtyOnHand: sql`qty_on_hand - ${issueQty}` })
        .where(eq(packagingLots.id, lotLookup.lot.id));
    }

    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.sealingStationId,
      eventType: "SEALING_COMPLETE",
      occurredAt: T.sealingComplete,
      payload: { lane_close: true, ...BACKFILL_MARKERS },
      ...ACCOUNTABILITY,
    });
    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.sealingStationId,
      eventType: "BAG_RELEASED",
      occurredAt: T.sealingReleased,
      payload: {
        station_kind: "SEALING",
        released_at_stage: "SEALED",
        ...BACKFILL_MARKERS,
      },
      ...ACCOUNTABILITY,
    });

    // 4. Packaging chain (mirrors packagingCompleteAction).
    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.packagingStationId,
      eventType: "BAG_PICKED_UP",
      occurredAt: T.pickupPackaging,
      payload: {
        from_stage: "SEALED",
        qr_card_id: TARGET.qrCardId,
        station_kind: "PACKAGING",
        ...BACKFILL_MARKERS,
      },
      ...ACCOUNTABILITY,
    });
    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.packagingStationId,
      eventType: "PACKAGING_COMPLETE",
      occurredAt: T.packagingComplete,
      payload: {
        master_cases: TARGET.masterCases,
        displays_made: TARGET.displaysMade,
        loose_cards: TARGET.looseCards,
        damaged_packaging: TARGET.damagedPackaging,
        ripped_cards: TARGET.rippedCards,
        ...BACKFILL_MARKERS,
      },
      ...ACCOUNTABILITY,
    });
    const consumption = await emitCountBasedPackagingConsumption(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.packagingStationId,
      payload: {
        master_cases: TARGET.masterCases,
        displays_made: TARGET.displaysMade,
        loose_cards: TARGET.looseCards,
        damaged_packaging: TARGET.damagedPackaging,
        ripped_cards: TARGET.rippedCards,
      },
      occurredAt: T.packagingComplete,
    });
    if (consumption.bomStatus !== "COMPLETE") {
      throw new Error(
        `Packaging consumption not COMPLETE: ${JSON.stringify(consumption)}`,
      );
    }
    await patchPackagingCompleteConsumptionSummary(tx, {
      workflowBagId: TARGET.seedBagId,
      summary: buildPackagingConsumptionPayloadSummary(consumption),
    });
    await refreshMaterialReadModelsAfterConsumption(tx, {
      refreshRecommendations: true,
    });

    // 5. Finalize (mirrors maybeAutoFinalizeAfterPackagingComplete).
    await projectEvent(tx, {
      workflowBagId: TARGET.seedBagId,
      stationId: TARGET.packagingStationId,
      eventType: "BAG_FINALIZED",
      occurredAt: T.finalized,
      payload: { ...BACKFILL_MARKERS },
      ...ACCOUNTABILITY,
    });

    // 6. Finished lot + allocation close (repair-opens a session and closes
    //    it OUTPUT_DERIVED). Post-commit Zoho enqueue intentionally skipped.
    const autoLot = await autoCreateAndReleaseFinishedLotForWorkflowBag(tx, {
      workflowBagId: TARGET.seedBagId,
      packagedAt: T.packagingComplete,
      counts: {
        masterCases: TARGET.masterCases,
        displaysMade: TARGET.displaysMade,
        looseCards: TARGET.looseCards,
      },
      actor: { id: null, role: null },
    });
    if (!autoLot.ok) {
      throw new Error(
        `Finished lot auto-create failed: ${autoLot.reason} — ${autoLot.message}`,
      );
    }

    // 7. Release the QR card — supervisor attests the physical bag is empty
    //    after this run (ending-balance 238 is estimate remainder).
    await tx
      .update(qrCards)
      .set({ status: "IDLE", assignedWorkflowBagId: null })
      .where(eq(qrCards.id, TARGET.qrCardId));
    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_backfill.receipt_352171_qr_released_empty",
        targetType: "WorkflowBag",
        targetId: TARGET.seedBagId,
        after: {
          qr_card: TARGET.bagCardToken,
          released_to_idle: true,
          reason: "supervisor_attested_bag_empty",
          ledger_ending_balance_estimate: 238,
        },
      },
      tx,
    );

    // 8. Restore floor-board station rows so live view is undisturbed.
    for (const row of stationLiveBefore) {
      await tx
        .insert(readStationLive)
        .values(row)
        .onConflictDoUpdate({
          target: readStationLive.stationId,
          set: {
            currentWorkflowBagId: row.currentWorkflowBagId,
            lastEventType: row.lastEventType,
            lastEventAt: row.lastEventAt,
            updatedAt: row.updatedAt,
          },
        });
    }
    if (stationLiveBefore.length === 0) {
      await tx
        .update(readStationLive)
        .set({ currentWorkflowBagId: null })
        .where(
          and(
            eq(readStationLive.currentWorkflowBagId, TARGET.seedBagId),
            sql`${readStationLive.stationId} IN (${TARGET.sealingStationId}::uuid, ${TARGET.packagingStationId}::uuid)`,
          ),
        );
    }

    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_backfill.receipt_352171_run2_seal_pack",
        targetType: "WorkflowBag",
        targetId: TARGET.seedBagId,
        after: {
          script: REPAIR_SCRIPT_VERSION,
          audit_reason: AUDIT_REASON,
          sealed_count_total: TARGET.sealedCountTotal,
          master_cases: TARGET.masterCases,
          finished_lot_id: autoLot.finishedLotId,
          finished_lot_number: autoLot.finishedLotNumber,
          deleted_run3: TARGET.deleteBagId,
          zoho_effects_skipped: true,
        },
      },
      tx,
    );

    return {
      finishedLotId: autoLot.finishedLotId,
      finishedLotNumber: autoLot.finishedLotNumber,
      blisterCardsIssuedAtSealing: issueQty,
      consumption,
    };
  });
}

async function printPostState(): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT wb.id::text, rbs.stage, rbs.product_name, rbs.is_finalized,
           wb.finalized_at
    FROM workflow_bags wb
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    WHERE wb.inventory_bag_id = ${TARGET.inventoryBagId}::uuid
    ORDER BY wb.started_at
  `)) as unknown as Array<Record<string, unknown>>;
  section("POST-STATE: runs on inventory bag", rows);

  const card = (await db.execute(sql`
    SELECT status, assigned_workflow_bag_id::text
    FROM qr_cards WHERE id = ${TARGET.qrCardId}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  section("POST-STATE: QR card", card);

  const sessions = (await db.execute(sql`
    SELECT id::text, workflow_bag_id::text, allocation_status,
           starting_balance_qty, consumed_qty, ending_balance_qty,
           finished_lot_id::text
    FROM raw_bag_allocation_sessions
    WHERE inventory_bag_id = ${TARGET.inventoryBagId}::uuid
    ORDER BY opened_at
  `)) as unknown as Array<Record<string, unknown>>;
  section("POST-STATE: allocation sessions", sessions);

  const lots = (await db.execute(sql`
    SELECT fl.id::text, fl.finished_lot_number, fl.status, fl.units_produced,
           fl.displays_produced, fl.cases_produced
    FROM finished_lots fl
    WHERE fl.workflow_bag_id = ${TARGET.seedBagId}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  section("POST-STATE: finished lot", lots);
}

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");
  console.log(
    `[${REPAIR_SCRIPT_VERSION}] mode=${applyMode ? "APPLY" : "DRY-RUN"}`,
  );

  if (applyMode) {
    if (process.env.ALLOW_PRODUCTION_REPAIR !== "true") {
      console.error("Refusing apply: set ALLOW_PRODUCTION_REPAIR=true");
      process.exit(1);
    }
    if (process.env.CONFIRM_SEED_BAG !== TARGET.seedBagId) {
      console.error(`Refusing apply: CONFIRM_SEED_BAG must be ${TARGET.seedBagId}`);
      process.exit(1);
    }
    if (process.env.CONFIRM_DELETE_BAG !== TARGET.deleteBagId) {
      console.error(
        `Refusing apply: CONFIRM_DELETE_BAG must be ${TARGET.deleteBagId}`,
      );
      process.exit(1);
    }
    if (process.env.CONFIRM_BAG_CARD !== TARGET.bagCardToken) {
      console.error(`Refusing apply: CONFIRM_BAG_CARD must be ${TARGET.bagCardToken}`);
      process.exit(1);
    }
  }

  const verified = await verify();
  if (!verified.ok) {
    section("ABORT", verified.reason);
    process.exit(1);
  }

  section("TARGET", {
    receipt: TARGET.receiptNumber,
    bag: TARGET.bagNumber,
    card: TARGET.bagCardToken,
    seedRun2: TARGET.seedBagId,
    deleteRun3: TARGET.deleteBagId,
    product: `${verified.productName} (${verified.productSku})`,
  });
  section("PROPOSED MUTATIONS", buildProposal(verified));

  if (!applyMode) {
    console.log(
      "\nDry-run complete — no mutations written. Apply requires --apply plus " +
        "ALLOW_PRODUCTION_REPAIR, CONFIRM_SEED_BAG, CONFIRM_DELETE_BAG, CONFIRM_BAG_CARD.",
    );
    process.exit(0);
  }

  const result = await apply(verified);
  section("APPLY RESULT", result);
  await printPostState();
  console.log("\nApply complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
