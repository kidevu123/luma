// Receipt 352183 bag 6 (MIT B Chocolate Brown, QR bag-card-198) — IN-PLACE
// route conversion of workflow f7ce73e2 from a mistaken CARD run to the
// real BOTTLE run (586 bottles, 2026-06-03).
//
// The bag was physically run as 12ct bottles but entered as a card run on
// 2026-06-03, then quarantined WRONG_ROUTE on 2026-07-02 (quarantine-only;
// Luma has no route-conversion service by design). The admin has explicitly
// authorized a raw rewrite of this one workflow instead of the default
// preserve-and-create-new path:
//
//   "i want in place conversion. i give you permission to rewrite the raw
//    sql this time." — admin, 2026-07-07
//
// What this script does (single transaction), deviating from the app's
// append-only convention ONLY where noted:
//   1. Snapshots all 12 existing workflow_events (11 card events + the
//      WORKFLOW_RECOVERY quarantine) and the 1 wrong MATERIAL_CONSUMED_ACTUAL
//      (586 blister cards) into audit_log, then DELETES them. [raw rewrite]
//   2. Clears recovery_status / excluded_from_output on read_bag_state
//      (rebuild-safe: the WORKFLOW_RECOVERY event is gone). [raw rewrite]
//   3. Re-points workflow_bags.product_id to the BOTTLE product and QR
//      bag-card-198 to this workflow, opens the canonical allocation
//      session, then seeds the canonical bottle chain via projectEvent:
//      CARD_ASSIGNED -> BOTTLE_HANDPACK_COMPLETE {586} -> cap-seal ->
//      sticker -> PACKAGING_COMPLETE {8 cases, 1 display, 4 loose} ->
//      BAG_FINALIZED, all dated 2026-06-03.
//   4. Canonical finalize service: finished lot 352183 auto-created +
//      released, allocation closed OUTPUT_DERIVED (7,223 - 7,032 = 191).
//      Zoho post-commit effects are NOT run — nothing queued or committed.
//   5. Rebuilds the derived read models (daily throughput, SKU daily,
//      station quality, material reconciliation v1/v2, consumption daily,
//      burn, lot state) so the deleted card events' stale contributions
//      disappear and the bottle run is counted exactly once.
//
// Dry-run (default):
//   npx tsx scripts/convert-352183-card-to-bottle.ts
// Apply:
//   ALLOW_PRODUCTION_REPAIR=true \
//   CONFIRM_WORKFLOW_BAG=f7ce73e2-ed8d-4a39-82a7-3ff5aa0cdb41 \
//   CONFIRM_BAG_CARD=bag-card-198 \
//   npx tsx scripts/convert-352183-card-to-bottle.ts --apply

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { qrCards, workflowBags } from "@/lib/db/schema";
import { autoCreateAndReleaseFinishedLotForWorkflowBag } from "@/lib/db/queries/finished-lots";
import { projectEvent } from "@/lib/projector";
import { emitCountBasedPackagingConsumption } from "@/lib/projector/packaging-consumption-hook";
import { refreshMaterialReadModelsAfterConsumption } from "@/lib/projector/material-read-model-refresh";
import {
  buildPackagingConsumptionPayloadSummary,
  patchPackagingCompleteConsumptionSummary,
} from "@/lib/production/packaging-consumption-summary";
import { openAllocationSessionInTx } from "@/lib/production/raw-bag-allocation-lifecycle";
import { rebuildDailyThroughput } from "@/lib/projector/daily-throughput";
import { rebuildSkuDaily } from "@/lib/projector/sku-daily";
import { rebuildStationQualityDaily } from "@/lib/projector/station-daily";
import { rebuildMaterialReconciliation } from "@/lib/projector/material-reconciliation";
import { rebuildMaterialReconciliationV2 } from "@/lib/projector/material-reconciliation-v2";
import { rebuildMaterialConsumptionDaily } from "@/lib/projector/material-consumption-daily";
import { rebuildMaterialBurn } from "@/lib/projector/material-burn";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SCRIPT_VERSION = "route-convert-352183-card-to-bottle-v1";

const TARGET = {
  workflowBagId: "f7ce73e2-ed8d-4a39-82a7-3ff5aa0cdb41",
  inventoryBagId: "4a6ccf9a-9b8d-4e03-ace1-f72473898ab7",
  receipt: "352183",
  bagNumber: 6,
  qrToken: "bag-card-198",
  cardProductId: "3e8feb72-09a0-4068-8231-c965715c33a9", // wrong CARD product
  bottleProductId: "67388d2d-97f7-4ac4-8c90-3da471a2cfd9",
  bottleProductSku: "LUMA-hyroxi-mit-b-choco-d-J1EMU",
  bottleProductName: "Hyroxi MIT B - Choco Drift",
  wrongMaterialEventId: 805, // MATERIAL_CONSUMED_ACTUAL 586 blister cards
  bottles: 586,
  packaging: { masterCases: 8, displaysMade: 1, looseCards: 4, damagedPackaging: 0, rippedCards: 0 },
  expectedUnits: 586, // (8*12+1)*6+4
  expectedDisplays: 97, // 8*12+1
  expectedConsumedTablets: 7032, // 586 * 12
} as const;

const EXPECTED_OLD_FINGERPRINT =
  "CARD_ASSIGNED,HANDPACK_BLISTER_COMPLETE,BAG_RELEASED,BAG_PICKED_UP,PRODUCT_MAPPED,SEALING_SEGMENT_COMPLETE,SEALING_COMPLETE,BAG_RELEASED,BAG_PICKED_UP,PACKAGING_COMPLETE,BAG_FINALIZED,WORKFLOW_RECOVERY";

const STATIONS = {
  bottleHandpack: "dccae47d-28e3-40b3-8192-9d737acafdcd", // Bottle Packing Station
  bottleCapSeal: "754eb778-4223-49ea-9854-2482160bb7a8", // Bottle Sealer
  bottleSticker: "094b130c-8b82-4c7a-bb61-cc36dd3f7b44", // Bottle Stickering
  packaging: "c174b1e0-4daf-4eb5-927b-622dd8038553", // Packaging Station
} as const;

// 2026-06-03, 10:34am–11:50am ET (run start matches the original entry).
const T = {
  assigned: new Date("2026-06-03T14:34:01Z"),
  handpackComplete: new Date("2026-06-03T15:00:00Z"),
  handpackReleased: new Date("2026-06-03T15:00:05Z"),
  capSealPickup: new Date("2026-06-03T15:05:00Z"),
  capSealComplete: new Date("2026-06-03T15:15:00Z"),
  capSealReleased: new Date("2026-06-03T15:15:05Z"),
  stickerPickup: new Date("2026-06-03T15:20:00Z"),
  stickerComplete: new Date("2026-06-03T15:30:00Z"),
  stickerReleased: new Date("2026-06-03T15:30:05Z"),
  packPickup: new Date("2026-06-03T15:35:00Z"),
  packComplete: new Date("2026-06-03T15:50:00Z"),
  finalized: new Date("2026-06-03T15:50:05Z"),
} as const;

const AUDIT_REASON =
  "Admin-approved wrong-route correction (in-place, explicitly authorized): " +
  "receipt 352183 bag 6 was physically run as Hyroxi MIT B - Choco Drift 12ct " +
  "bottles (586 bottles, 2026-06-03) but entered as a card run. Original card " +
  "events + WORKFLOW_RECOVERY quarantine snapshotted to audit_log and removed; " +
  "canonical bottle chain entered in place on the same workflow.";

const ACCOUNTABILITY = {
  enteredByUserId: null as string | null,
  accountableEmployeeId: null as string | null,
  accountabilitySource: "MANUAL_TEXT" as const,
  accountableEmployeeNameSnapshot: SCRIPT_VERSION,
};

const MARKERS = { backfill_source: SCRIPT_VERSION, audit_reason: AUDIT_REASON } as const;

function section(title: string, body: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

type Preflight =
  | {
      ok: true;
      qrCardId: string;
      tabletTypeId: string;
      oldEvents: Array<Record<string, unknown>>;
      oldMaterialEvent: Record<string, unknown>;
    }
  | { ok: false; reason: string };

async function preflight(dbx: Tx | typeof db): Promise<Preflight> {
  const inv = (await dbx.execute(sql`
    SELECT ib.internal_receipt_number AS receipt, ib.bag_number, ib.pill_count,
           ib.bag_qr_code, ib.tablet_type_id::text
    FROM inventory_bags ib WHERE ib.id = ${TARGET.inventoryBagId}::uuid
  `)) as unknown as Array<{
    receipt: string;
    bag_number: number;
    pill_count: number;
    bag_qr_code: string | null;
    tablet_type_id: string;
  }>;
  const bag = inv[0];
  if (!bag || bag.receipt !== TARGET.receipt || bag.bag_number !== TARGET.bagNumber) {
    return { ok: false, reason: `Inventory bag mismatch: ${JSON.stringify(bag)}` };
  }
  if (bag.bag_qr_code !== TARGET.qrToken) {
    return { ok: false, reason: `Bag QR is ${bag.bag_qr_code}, expected ${TARGET.qrToken}` };
  }
  if (bag.pill_count !== 7223) {
    return { ok: false, reason: `Pill count changed: ${bag.pill_count} != 7223` };
  }

  const wbs = (await dbx.execute(sql`
    SELECT wb.id::text, wb.product_id::text, rbs.stage, rbs.recovery_status,
           rbs.excluded_from_output
    FROM workflow_bags wb
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    WHERE wb.inventory_bag_id = ${TARGET.inventoryBagId}::uuid
  `)) as unknown as Array<{
    id: string;
    product_id: string | null;
    stage: string | null;
    recovery_status: string | null;
    excluded_from_output: boolean | null;
  }>;
  if (wbs.length !== 1 || wbs[0]!.id !== TARGET.workflowBagId) {
    return { ok: false, reason: `Workflow set changed: ${wbs.map((w) => w.id).join(", ")}` };
  }
  const wb = wbs[0]!;
  if (wb.product_id !== TARGET.cardProductId) {
    return { ok: false, reason: `Product changed: ${wb.product_id}` };
  }
  if (wb.recovery_status !== "WRONG_ROUTE_RECOVERED" || !wb.excluded_from_output) {
    return {
      ok: false,
      reason: `Recovery state changed: ${wb.recovery_status}/${wb.excluded_from_output}`,
    };
  }

  const oldEvents = (await dbx.execute(sql`
    SELECT id::text, event_type::text, occurred_at, station_id::text, payload,
           employee_id::text, user_id::text, client_event_id
    FROM workflow_events
    WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid
    ORDER BY occurred_at, id
  `)) as unknown as Array<Record<string, unknown>>;
  const fingerprint = oldEvents.map((e) => e.event_type).join(",");
  if (fingerprint !== EXPECTED_OLD_FINGERPRINT) {
    return { ok: false, reason: `Event chain changed: [${fingerprint}]` };
  }

  const matEvents = (await dbx.execute(sql`
    SELECT id, event_type::text, packaging_lot_id::text, quantity_units, payload, occurred_at
    FROM material_inventory_events
    WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  if (
    matEvents.length !== 1 ||
    Number(matEvents[0]!.id) !== TARGET.wrongMaterialEventId ||
    Number(matEvents[0]!.quantity_units) !== 586
  ) {
    return { ok: false, reason: `Material events changed: ${JSON.stringify(matEvents)}` };
  }

  const guards = (await dbx.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM finished_lots WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid) AS lots,
      (SELECT COUNT(*)::int FROM zoho_production_output_ops WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid) AS zoho,
      (SELECT COUNT(*)::int FROM raw_bag_allocation_sessions WHERE inventory_bag_id = ${TARGET.inventoryBagId}::uuid) AS sessions,
      (SELECT COUNT(*)::int FROM finished_lots WHERE finished_lot_number = ${TARGET.receipt}) AS lot_number_taken
  `)) as unknown as Array<{ lots: number; zoho: number; sessions: number; lot_number_taken: number }>;
  const g = guards[0]!;
  if (g.lots !== 0) return { ok: false, reason: "Finished lot exists for this workflow" };
  if (g.zoho !== 0) return { ok: false, reason: "Zoho op exists for this workflow" };
  if (g.sessions !== 0) return { ok: false, reason: `Allocation sessions exist (${g.sessions})` };
  if (g.lot_number_taken !== 0) return { ok: false, reason: "Lot number 352183 already taken" };

  const cards = (await dbx.execute(sql`
    SELECT id::text, status::text, assigned_workflow_bag_id::text AS assigned, card_type::text
    FROM qr_cards WHERE scan_token = ${TARGET.qrToken}
  `)) as unknown as Array<{ id: string; status: string; assigned: string | null; card_type: string }>;
  const card = cards[0];
  if (!card || card.card_type !== "RAW_BAG" || card.status !== "ASSIGNED" || card.assigned !== null) {
    return { ok: false, reason: `QR state changed: ${JSON.stringify(card)}` };
  }

  const prod = (await dbx.execute(sql`
    SELECT p.kind::text, p.tablets_per_unit, p.units_per_display, p.displays_per_case,
      EXISTS (SELECT 1 FROM product_allowed_tablets pat
              WHERE pat.product_id = p.id AND pat.tablet_type_id = ${bag.tablet_type_id}::uuid) AS allowed
    FROM products p WHERE p.id = ${TARGET.bottleProductId}::uuid
  `)) as unknown as Array<{
    kind: string;
    tablets_per_unit: number;
    units_per_display: number;
    displays_per_case: number;
    allowed: boolean;
  }>;
  const p = prod[0];
  if (
    !p ||
    p.kind !== "BOTTLE" ||
    p.tablets_per_unit !== 12 ||
    p.units_per_display !== 6 ||
    p.displays_per_case !== 12 ||
    !p.allowed
  ) {
    return { ok: false, reason: `Bottle product setup unexpected: ${JSON.stringify(p)}` };
  }

  return {
    ok: true,
    qrCardId: card.id,
    tabletTypeId: bag.tablet_type_id,
    oldEvents,
    oldMaterialEvent: matEvents[0]!,
  };
}

async function apply(pf: Extract<Preflight, { ok: true }>): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    // 1. Snapshot then delete the wrong history. [authorized raw rewrite]
    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_repair.route_conversion_history_snapshot",
        targetType: "WorkflowBag",
        targetId: TARGET.workflowBagId,
        before: {
          workflow_events: pf.oldEvents,
          material_inventory_events: [pf.oldMaterialEvent],
        },
        after: { deleted: true, audit_reason: AUDIT_REASON, script: SCRIPT_VERSION },
      },
      tx,
    );
    await tx.execute(sql`
      DELETE FROM workflow_events WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid
    `);
    await tx.execute(sql`
      DELETE FROM material_inventory_events WHERE id = ${TARGET.wrongMaterialEventId}
    `);

    // 2. Clear the quarantine flags (rebuild-safe: recovery event removed).
    await tx.execute(sql`
      UPDATE read_bag_state
      SET recovery_status = NULL, excluded_from_output = false, updated_at = now()
      WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid
    `);

    // 3. Re-point product + QR, open the canonical allocation session.
    await tx
      .update(workflowBags)
      .set({ productId: TARGET.bottleProductId })
      .where(eq(workflowBags.id, TARGET.workflowBagId));
    await tx
      .update(qrCards)
      .set({ assignedWorkflowBagId: TARGET.workflowBagId, status: "ASSIGNED" })
      .where(eq(qrCards.id, pf.qrCardId));
    const opened = await openAllocationSessionInTx(tx, {
      inventoryBagId: TARGET.inventoryBagId,
      workflowBagId: TARGET.workflowBagId,
      productId: TARGET.bottleProductId,
      notes: AUDIT_REASON,
      actor: null,
    });
    if (!opened.ok) throw new Error(`Allocation open failed: ${opened.error}`);

    // 4. Canonical bottle chain, dated 2026-06-03.
    const ev = (
      stationId: string,
      eventType: string,
      occurredAt: Date,
      payload: Record<string, unknown>,
    ) =>
      projectEvent(tx, {
        workflowBagId: TARGET.workflowBagId,
        stationId,
        eventType: eventType as Parameters<typeof projectEvent>[1]["eventType"],
        occurredAt,
        payload: { ...payload, ...MARKERS },
        ...ACCOUNTABILITY,
      });

    await ev(STATIONS.bottleHandpack, "CARD_ASSIGNED", T.assigned, {
      qr_card_id: pf.qrCardId,
      station_kind: "BOTTLE_HANDPACK",
      tablet_type_id: pf.tabletTypeId,
      inventory_bag_id: TARGET.inventoryBagId,
    });
    await ev(STATIONS.bottleHandpack, "PRODUCT_MAPPED", T.assigned, {
      source: "ADMIN_ROUTE_CONVERSION",
      product_id: TARGET.bottleProductId,
      product_sku: TARGET.bottleProductSku,
      product_kind: "BOTTLE",
      product_name: TARGET.bottleProductName,
      station_kind: "BOTTLE_HANDPACK",
    });
    await ev(STATIONS.bottleHandpack, "BOTTLE_HANDPACK_COMPLETE", T.handpackComplete, {
      count_total: TARGET.bottles,
    });
    await ev(STATIONS.bottleHandpack, "BAG_RELEASED", T.handpackReleased, {
      station_kind: "BOTTLE_HANDPACK",
      released_at_stage: "BLISTERED",
    });
    await ev(STATIONS.bottleCapSeal, "BAG_PICKED_UP", T.capSealPickup, {
      from_stage: "BLISTERED",
      qr_card_id: pf.qrCardId,
      station_kind: "BOTTLE_CAP_SEAL",
    });
    await ev(STATIONS.bottleCapSeal, "BOTTLE_CAP_SEAL_COMPLETE", T.capSealComplete, {});
    await ev(STATIONS.bottleCapSeal, "BAG_RELEASED", T.capSealReleased, {
      station_kind: "BOTTLE_CAP_SEAL",
      released_at_stage: "SEALED",
    });
    await ev(STATIONS.bottleSticker, "BAG_PICKED_UP", T.stickerPickup, {
      from_stage: "SEALED",
      qr_card_id: pf.qrCardId,
      station_kind: "BOTTLE_STICKER",
    });
    await ev(STATIONS.bottleSticker, "BOTTLE_STICKER_COMPLETE", T.stickerComplete, {});
    await ev(STATIONS.bottleSticker, "BAG_RELEASED", T.stickerReleased, {
      station_kind: "BOTTLE_STICKER",
      released_at_stage: "SEALED",
    });
    await ev(STATIONS.packaging, "BAG_PICKED_UP", T.packPickup, {
      from_stage: "SEALED",
      qr_card_id: pf.qrCardId,
      station_kind: "PACKAGING",
    });
    await ev(STATIONS.packaging, "PACKAGING_COMPLETE", T.packComplete, {
      master_cases: TARGET.packaging.masterCases,
      displays_made: TARGET.packaging.displaysMade,
      loose_cards: TARGET.packaging.looseCards,
      damaged_packaging: TARGET.packaging.damagedPackaging,
      ripped_cards: TARGET.packaging.rippedCards,
    });
    const consumption = await emitCountBasedPackagingConsumption(tx, {
      workflowBagId: TARGET.workflowBagId,
      stationId: STATIONS.packaging,
      payload: {
        master_cases: TARGET.packaging.masterCases,
        displays_made: TARGET.packaging.displaysMade,
        loose_cards: TARGET.packaging.looseCards,
        damaged_packaging: TARGET.packaging.damagedPackaging,
        ripped_cards: TARGET.packaging.rippedCards,
      },
      occurredAt: T.packComplete,
    });
    if (
      consumption.totalUnits !== TARGET.expectedUnits ||
      consumption.totalDisplays !== TARGET.expectedDisplays
    ) {
      throw new Error(
        `Output math mismatch: ${consumption.totalUnits}u/${consumption.totalDisplays}d`,
      );
    }
    await patchPackagingCompleteConsumptionSummary(tx, {
      workflowBagId: TARGET.workflowBagId,
      summary: buildPackagingConsumptionPayloadSummary(consumption),
    });
    await refreshMaterialReadModelsAfterConsumption(tx, { refreshRecommendations: true });

    await ev(STATIONS.packaging, "BAG_FINALIZED", T.finalized, {});

    // 5. Canonical finished-lot + allocation close.
    const autoLot = await autoCreateAndReleaseFinishedLotForWorkflowBag(tx, {
      workflowBagId: TARGET.workflowBagId,
      packagedAt: T.packComplete,
      counts: {
        masterCases: TARGET.packaging.masterCases,
        displaysMade: TARGET.packaging.displaysMade,
        looseCards: TARGET.packaging.looseCards,
      },
      actor: { id: null, role: null },
    });
    if (!autoLot.ok) {
      throw new Error(`Finished lot auto-create failed: ${autoLot.reason} — ${autoLot.message}`);
    }

    // 6. Rebuild derived read models so the deleted card events' stale
    //    contributions (June 3 card throughput/SKU rows, material rows)
    //    disappear and the bottle run counts exactly once.
    await rebuildDailyThroughput(tx);
    await rebuildSkuDaily(tx);
    await rebuildStationQualityDaily(tx);
    await rebuildMaterialReconciliation(tx);
    await rebuildMaterialReconciliationV2(tx);
    await rebuildMaterialConsumptionDaily(tx);
    await rebuildMaterialBurn(tx);
    await rebuildMaterialLotState(tx);

    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_repair.route_conversion_352183_card_to_bottle",
        targetType: "WorkflowBag",
        targetId: TARGET.workflowBagId,
        after: {
          script: SCRIPT_VERSION,
          audit_reason: AUDIT_REASON,
          bottles: TARGET.bottles,
          packaging: TARGET.packaging,
          consumed_tablets: TARGET.expectedConsumedTablets,
          finished_lot_id: autoLot.finishedLotId,
          finished_lot_number: autoLot.finishedLotNumber,
          old_events_deleted: 12,
          old_material_events_deleted: 1,
          zoho_effects_skipped: true,
        },
      },
      tx,
    );

    return {
      finishedLotId: autoLot.finishedLotId,
      finishedLotNumber: autoLot.finishedLotNumber,
      totalUnits: consumption.totalUnits,
      totalDisplays: consumption.totalDisplays,
      bomStatus: consumption.bomStatus,
    };
  });
}

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");
  console.log(`[${SCRIPT_VERSION}] mode=${applyMode ? "APPLY" : "DRY-RUN"}`);

  if (applyMode) {
    if (process.env.ALLOW_PRODUCTION_REPAIR !== "true") {
      console.error("Refusing apply: set ALLOW_PRODUCTION_REPAIR=true");
      process.exit(1);
    }
    if (process.env.CONFIRM_WORKFLOW_BAG !== TARGET.workflowBagId) {
      console.error(`Refusing apply: CONFIRM_WORKFLOW_BAG must be ${TARGET.workflowBagId}`);
      process.exit(1);
    }
    if (process.env.CONFIRM_BAG_CARD !== TARGET.qrToken) {
      console.error(`Refusing apply: CONFIRM_BAG_CARD must be ${TARGET.qrToken}`);
      process.exit(1);
    }
  }

  const pf = await preflight(db);
  if (!pf.ok) {
    section("ABORT", pf.reason);
    process.exit(1);
  }

  section("TARGET", {
    receipt: TARGET.receipt,
    bag: TARGET.bagNumber,
    workflowBag: TARGET.workflowBagId,
    qr: `${TARGET.qrToken} (${pf.qrCardId})`,
    convertTo: `${TARGET.bottleProductName} [BOTTLE ${TARGET.bottleProductSku}]`,
  });
  section("PROPOSED MUTATIONS", {
    delete_and_snapshot: {
      workflow_events: pf.oldEvents.map(
        (e) => `${String(e.occurred_at)} ${String(e.event_type)}`,
      ),
      material_inventory_events: [
        `id ${TARGET.wrongMaterialEventId}: MATERIAL_CONSUMED_ACTUAL 586 blister cards (wrong route)`,
      ],
      note: "full JSON snapshotted to audit_log before deletion",
    },
    clear_quarantine:
      "read_bag_state.recovery_status WRONG_ROUTE_RECOVERED -> NULL; excluded_from_output true -> false (WORKFLOW_RECOVERY event removed, so rebuild-safe)",
    product: "workflow_bags.product_id: card 3e8feb72 -> bottle 67388d2d",
    qr: `attach ${TARGET.qrToken} to workflow; canonical finalize releases it to IDLE`,
    allocation: "open canonical session (starting 7,223 PILL_COUNT); closed by finalize service: consumed 7,032 (586 x 12), ending 191",
    new_events: [
      `${T.assigned.toISOString()} CARD_ASSIGNED @ Bottle Packing Station`,
      `${T.assigned.toISOString()} PRODUCT_MAPPED {ADMIN_ROUTE_CONVERSION -> ${TARGET.bottleProductSku}}`,
      `${T.handpackComplete.toISOString()} BOTTLE_HANDPACK_COMPLETE {count_total: 586}`,
      `${T.handpackReleased.toISOString()} BAG_RELEASED (BLISTERED)`,
      `${T.capSealPickup.toISOString()} BAG_PICKED_UP @ Bottle Sealer`,
      `${T.capSealComplete.toISOString()} BOTTLE_CAP_SEAL_COMPLETE`,
      `${T.capSealReleased.toISOString()} BAG_RELEASED (SEALED)`,
      `${T.stickerPickup.toISOString()} BAG_PICKED_UP @ Bottle Stickering`,
      `${T.stickerComplete.toISOString()} BOTTLE_STICKER_COMPLETE`,
      `${T.stickerReleased.toISOString()} BAG_RELEASED (SEALED)`,
      `${T.packPickup.toISOString()} BAG_PICKED_UP @ Packaging Station`,
      `${T.packComplete.toISOString()} PACKAGING_COMPLETE {8 cases, 1 display, 4 loose, 0 damaged, 0 ripped}`,
      `${T.finalized.toISOString()} BAG_FINALIZED`,
    ],
    packaging_consumption:
      "label sticker 586/UNIT (lot on hand 4,320); display box 97/DISPLAY (on hand 1,440) — expected DEDUCTED/COMPLETE",
    finished_lot:
      "auto-create + RELEASE lot 352183: 586 units / 1 display / 8 cases; Zoho effects NOT run",
    read_model_rebuild:
      "daily throughput, SKU daily, station quality, material reconciliation v1/v2, consumption daily, burn, lot state — removes stale June 3 card contributions",
  });

  if (!applyMode) {
    console.log(
      "\nDry-run complete — no mutations written. Apply requires --apply plus " +
        "ALLOW_PRODUCTION_REPAIR, CONFIRM_WORKFLOW_BAG, CONFIRM_BAG_CARD.",
    );
    process.exit(0);
  }

  const result = await apply(pf);
  section("APPLY RESULT", result);

  const post = (await db.execute(sql`
    SELECT rbs.stage, rbs.is_finalized, rbs.product_name, rbs.recovery_status,
           rbs.excluded_from_output,
           (SELECT status::text FROM qr_cards WHERE scan_token = ${TARGET.qrToken}) AS qr_status,
           (SELECT COUNT(*)::int FROM workflow_events WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid) AS events,
           (SELECT COUNT(*)::int FROM zoho_production_output_ops WHERE workflow_bag_id = ${TARGET.workflowBagId}::uuid) AS zoho_ops
    FROM read_bag_state rbs WHERE rbs.workflow_bag_id = ${TARGET.workflowBagId}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  section("POST-STATE", post);
  console.log("\nApply complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
