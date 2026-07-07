// Admin-approved historical production backfill (bulk apply, 2026-07-07).
//
// Four bags with missing station submissions:
//   Row 1  receipt 352173 bag 4 — existing run at SEALED; missing Sealing
//          Station 3 segment (206 presses x 6) + packaging {3,13,1,0,2};
//          finalize. Dated 2026-06-08.
//   Row 2  receipt 352177 bag 4 — existing run at SEALED; sealing complete;
//          missing packaging {4,7,6,0,1}; finalize. Dated 2026-06-08.
//          NOTE: output (2,146 units = 8,584 tablets) exceeds declared pill
//          count 7,884 — physical counts are authoritative; the canonical
//          finished-lot auto-create is expected to be BLOCKED on allocation
//          math (prior session already DEPLETED at 0) and the floor path's
//          audit-and-continue behavior is replicated.
//   Row 3  receipt 352180 bag 2 — no run existed; create canonical run
//          (QR bag-card-192), product Apple Lift, handpack + sealing S3
//          (303 presses x 6) + packaging {3,15,0,0,0}; finalize.
//          Dated 2026-05-26.
//   Row 4  receipt 352188 bag 5 — no run existed; create canonical run
//          (QR bag-card-199), product Sun Drip, handpack + sealing S3
//          (308 presses x 6) + packaging {3,15,5,0,3}; finalize.
//          Dated 2026-05-27. ("3 cards remaining" = ripped_cards 3 per
//          admin clarification.)
//
// Write-path mirrors the floor actions exactly: projectEvent per event
// (read models updated in-transaction), count-based packaging consumption +
// payload summary patch, canonical finalize, then
// autoCreateAndReleaseFinishedLotForWorkflowBag (the canonical
// packaging-close service — it creates AND releases the lot and closes the
// allocation session from output math). Zoho post-commit enqueue effects are
// intentionally NOT run — no zoho op rows are created or queued.
//
// Each row runs in its own transaction with in-transaction preflight;
// stale state skips that row only. Re-running skips applied rows
// (preflight sees the packaging/finalize events and refuses).
//
// Dry-run (default):
//   npx tsx scripts/backfill-352173-352177-352180-352188-production.ts
// Apply:
//   ALLOW_PRODUCTION_REPAIR=true CONFIRM_BULK=352173,352177,352180,352188 \
//   npx tsx scripts/backfill-352173-352177-352180-352188-production.ts --apply

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  packagingLots,
  qrCards,
  workflowBags,
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
import { openAllocationSessionInTx } from "@/lib/production/raw-bag-allocation-lifecycle";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SCRIPT_VERSION = "bulk-backfill-352173-77-80-88-v1";

const STATIONS = {
  handpack: "6e69f0dc-3557-4105-8ebd-e5c113444481", // Blister Hand Pack Station
  sealing3: "f8f8db79-dfbd-4ba5-8c83-ae20064a3f6f", // Sealing Station 3 (machine 3, 6/press)
  packaging: "c174b1e0-4daf-4eb5-927b-622dd8038553", // Packaging Station
} as const;

const CARDS_PER_PRESS = 6;

type PackagingCounts = {
  masterCases: number;
  displaysMade: number;
  looseCards: number;
  damagedPackaging: number;
  rippedCards: number;
};

type RowConfig = {
  key: string;
  receipt: string;
  bagNumber: number;
  inventoryBagId: string;
  qrToken: string;
  qrCardId: string;
  productId: string;
  productSku: string;
  productName: string;
  /** Existing run to append to; null → create a canonical run. */
  existingWorkflowBagId: string | null;
  /** Exact ordered event fingerprint required at preflight (existing rows). */
  expectedEventFingerprint: string | null;
  expectedQrStatus: "ASSIGNED" | "IDLE";
  expectedQrAssignedTo: string | null;
  tabletTypeId: string | null; // rows creating a run
  createRun: boolean;
  handpack: boolean;
  sealing: { presses: number } | null;
  packaging: PackagingCounts;
  expectedUnits: number;
  expectedDisplays: number;
  times: {
    runStart?: string;
    handpackComplete?: string;
    handpackReleased?: string;
    sealPickup?: string;
    productMapped?: string;
    sealSegment: string | null;
    sealComplete?: string;
    sealReleased?: string;
    packPickup: string;
    packComplete: string;
    finalized: string;
  };
};

const ROWS: RowConfig[] = [
  {
    key: "row1-352173",
    receipt: "352173",
    bagNumber: 4,
    inventoryBagId: "5940e204-9ea3-4c20-9ffc-eef2ae7cac4d",
    qrToken: "bag-card-108",
    qrCardId: "e310fbc3-b579-4537-b2c4-077d698f72b8",
    productId: "2fc80d3c-3f7d-496a-bd1f-9ccc06881946",
    productSku: "LUMA-hyroxi-mit-b-sun-dri-Q0EGE",
    productName: "Hyroxi MIT B - Sun Drip",
    existingWorkflowBagId: "d9c90e41-5438-4716-ae02-cbfa8a9cf7ae",
    expectedEventFingerprint:
      "CARD_ASSIGNED,BLISTER_COMPLETE,BAG_RELEASED,BAG_PICKED_UP,BAG_PICKED_UP,PRODUCT_MAPPED,SEALING_SEGMENT_COMPLETE,SEALING_COMPLETE,BAG_RELEASED,BAG_RELEASED",
    expectedQrStatus: "ASSIGNED",
    expectedQrAssignedTo: "d9c90e41-5438-4716-ae02-cbfa8a9cf7ae",
    tabletTypeId: null,
    createRun: false,
    handpack: false,
    sealing: { presses: 206 },
    packaging: {
      masterCases: 3,
      displaysMade: 13,
      looseCards: 1,
      damagedPackaging: 0,
      rippedCards: 2,
    },
    expectedUnits: 1761,
    expectedDisplays: 88,
    times: {
      // Missing Station-3 segment slots in just before its historical
      // release at 2026-06-08 14:42 UTC.
      sealSegment: "2026-06-08T14:41:00Z",
      packPickup: "2026-06-08T15:00:00Z",
      packComplete: "2026-06-08T15:20:00Z",
      finalized: "2026-06-08T15:20:05Z",
    },
  },
  {
    key: "row2-352177",
    receipt: "352177",
    bagNumber: 4,
    inventoryBagId: "d7669723-f133-4747-8c36-ae55c5d9a673",
    qrToken: "bag-card-115",
    qrCardId: "", // resolved at preflight; card already IDLE
    productId: "", // resolved at preflight; product must stay Sweet Trip
    productSku: "LUMA-hyroxi-mit-b-sweet-t-XQ30Q",
    productName: "Hyroxi MIT B - Sweet Trip",
    existingWorkflowBagId: "8f902914-6267-499a-806a-c26a0a71a4d4",
    expectedEventFingerprint:
      "CARD_ASSIGNED,BLISTER_COMPLETE,BAG_RELEASED,BAG_PICKED_UP,BAG_PICKED_UP,PRODUCT_MAPPED,SEALING_SEGMENT_COMPLETE,SEALING_SEGMENT_COMPLETE,SEALING_COMPLETE,BAG_RELEASED,BAG_RELEASED",
    expectedQrStatus: "IDLE",
    expectedQrAssignedTo: null,
    tabletTypeId: null,
    createRun: false,
    handpack: false,
    sealing: null, // sealing already complete — nothing added
    packaging: {
      masterCases: 4,
      displaysMade: 7,
      looseCards: 6,
      damagedPackaging: 0,
      rippedCards: 1,
    },
    expectedUnits: 2146,
    expectedDisplays: 107,
    times: {
      sealSegment: null,
      packPickup: "2026-06-08T14:00:00Z",
      packComplete: "2026-06-08T14:20:00Z",
      finalized: "2026-06-08T14:20:05Z",
    },
  },
  {
    key: "row3-352180",
    receipt: "352180",
    bagNumber: 2,
    inventoryBagId: "a34ffc85-d060-4911-835c-d3d1a674ac97",
    qrToken: "bag-card-192",
    qrCardId: "7e49a289-8f3f-433a-a059-e2a9d7e44fb9",
    productId: "01d2ec29-fc81-411b-8c31-ed27fc4cce22",
    productSku: "LUMA-hyroxi-mit-b-apple-l-YVR76",
    productName: "Hyroxi MIT B - Apple Lift",
    existingWorkflowBagId: null,
    expectedEventFingerprint: null,
    expectedQrStatus: "ASSIGNED",
    expectedQrAssignedTo: null, // orphaned assignment — attach to new run
    tabletTypeId: "2304e8b3-2239-41b9-af7d-b5003a16dfd1", // MIT B Green Apple
    createRun: true,
    handpack: true,
    sealing: { presses: 303 },
    packaging: {
      masterCases: 3,
      displaysMade: 15,
      looseCards: 0,
      damagedPackaging: 0,
      rippedCards: 0,
    },
    expectedUnits: 1800,
    expectedDisplays: 90,
    times: {
      // 2026-05-26 daytime ET (13:00Z = 9:00am ET).
      runStart: "2026-05-26T13:00:00Z",
      handpackComplete: "2026-05-26T14:30:00Z",
      handpackReleased: "2026-05-26T14:30:05Z",
      sealPickup: "2026-05-26T15:00:00Z",
      productMapped: "2026-05-26T15:01:00Z",
      sealSegment: "2026-05-26T16:00:00Z",
      sealComplete: "2026-05-26T16:02:00Z",
      sealReleased: "2026-05-26T16:02:05Z",
      packPickup: "2026-05-26T16:15:00Z",
      packComplete: "2026-05-26T16:45:00Z",
      finalized: "2026-05-26T16:45:05Z",
    },
  },
  {
    key: "row4-352188",
    receipt: "352188",
    bagNumber: 5,
    inventoryBagId: "74b81de0-4cd3-47a8-bd75-c195e55e180c",
    qrToken: "bag-card-199",
    qrCardId: "0bcb06e9-540b-46b7-8241-66c18b25958b",
    productId: "2fc80d3c-3f7d-496a-bd1f-9ccc06881946",
    productSku: "LUMA-hyroxi-mit-b-sun-dri-Q0EGE",
    productName: "Hyroxi MIT B - Sun Drip",
    existingWorkflowBagId: null,
    expectedEventFingerprint: null,
    expectedQrStatus: "ASSIGNED",
    expectedQrAssignedTo: null, // orphaned assignment — attach to new run
    tabletTypeId: "3192b115-9b7b-42d0-af29-694c405bb679", // MIT B Orange Citrus
    createRun: true,
    handpack: true,
    sealing: { presses: 308 },
    packaging: {
      masterCases: 3,
      displaysMade: 15,
      looseCards: 5,
      damagedPackaging: 0,
      rippedCards: 3, // "3 cards remaining" = ripped per admin clarification
    },
    expectedUnits: 1805,
    expectedDisplays: 90,
    times: {
      runStart: "2026-05-27T13:00:00Z",
      handpackComplete: "2026-05-27T14:30:00Z",
      handpackReleased: "2026-05-27T14:30:05Z",
      sealPickup: "2026-05-27T15:00:00Z",
      productMapped: "2026-05-27T15:01:00Z",
      sealSegment: "2026-05-27T16:00:00Z",
      sealComplete: "2026-05-27T16:02:00Z",
      sealReleased: "2026-05-27T16:02:05Z",
      packPickup: "2026-05-27T16:15:00Z",
      packComplete: "2026-05-27T16:45:00Z",
      finalized: "2026-05-27T16:45:05Z",
    },
  },
];

const ACCOUNTABILITY = {
  enteredByUserId: null as string | null,
  accountableEmployeeId: null as string | null,
  accountabilitySource: "MANUAL_TEXT" as const,
  accountableEmployeeNameSnapshot: SCRIPT_VERSION,
};

function auditReason(row: RowConfig): string {
  return (
    `Admin-approved historical production backfill (bulk apply 2026-07-07): ` +
    `receipt ${row.receipt} bag ${row.bagNumber}. Station submissions were ` +
    `physically completed but never recorded on the floor PWA.`
  );
}

function markers(row: RowConfig): Record<string, unknown> {
  return { backfill_source: SCRIPT_VERSION, audit_reason: auditReason(row) };
}

function section(title: string, body: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

type PreflightResult =
  | { ok: true; workflowBagId: string | null; qrCardId: string; notes: string[] }
  | { ok: false; reason: string };

async function preflight(dbOrTx: Tx | typeof db, row: RowConfig): Promise<PreflightResult> {
  const notes: string[] = [];

  const inv = (await dbOrTx.execute(sql`
    SELECT ib.id::text, ib.internal_receipt_number AS receipt, ib.bag_number,
           ib.pill_count, ib.bag_qr_code, ib.status
    FROM inventory_bags ib WHERE ib.id = ${row.inventoryBagId}::uuid
  `)) as unknown as Array<{
    id: string;
    receipt: string;
    bag_number: number;
    pill_count: number;
    bag_qr_code: string | null;
    status: string;
  }>;
  const bag = inv[0];
  if (!bag || bag.receipt !== row.receipt || bag.bag_number !== row.bagNumber) {
    return {
      ok: false,
      reason: `Inventory bag mismatch (got receipt=${bag?.receipt} bag=${bag?.bag_number})`,
    };
  }
  if (bag.bag_qr_code !== row.qrToken) {
    return {
      ok: false,
      reason: `Inventory bag QR code is ${bag.bag_qr_code}, expected ${row.qrToken}`,
    };
  }

  const cards = (await dbOrTx.execute(sql`
    SELECT id::text, status::text, assigned_workflow_bag_id::text AS assigned, card_type::text
    FROM qr_cards WHERE scan_token = ${row.qrToken}
  `)) as unknown as Array<{
    id: string;
    status: string;
    assigned: string | null;
    card_type: string;
  }>;
  const card = cards[0];
  if (!card) return { ok: false, reason: `QR card ${row.qrToken} not found` };
  if (card.card_type !== "RAW_BAG") {
    return { ok: false, reason: `QR card ${row.qrToken} is ${card.card_type}, not RAW_BAG` };
  }
  if (card.status !== row.expectedQrStatus || card.assigned !== row.expectedQrAssignedTo) {
    return {
      ok: false,
      reason: `QR ${row.qrToken} state changed: status=${card.status} assigned=${card.assigned} (expected ${row.expectedQrStatus}/${row.expectedQrAssignedTo})`,
    };
  }

  const wbs = (await dbOrTx.execute(sql`
    SELECT wb.id::text, wb.product_id::text, wb.finalized_at, rbs.stage,
           rbs.is_finalized, rbs.recovery_status, rbs.excluded_from_output
    FROM workflow_bags wb
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    WHERE wb.inventory_bag_id = ${row.inventoryBagId}::uuid
    ORDER BY wb.started_at
  `)) as unknown as Array<{
    id: string;
    product_id: string | null;
    finalized_at: string | null;
    stage: string | null;
    is_finalized: boolean | null;
    recovery_status: string | null;
    excluded_from_output: boolean | null;
  }>;

  if (row.createRun) {
    if (wbs.length !== 0) {
      return {
        ok: false,
        reason: `Expected no workflow run, found ${wbs.length} (${wbs.map((w) => w.id).join(", ")})`,
      };
    }
    const sessions = (await dbOrTx.execute(sql`
      SELECT COUNT(*)::int AS n FROM raw_bag_allocation_sessions
      WHERE inventory_bag_id = ${row.inventoryBagId}::uuid
    `)) as unknown as Array<{ n: number }>;
    if ((sessions[0]?.n ?? 0) !== 0) {
      return { ok: false, reason: `Expected 0 allocation sessions, found ${sessions[0]?.n}` };
    }
    notes.push(`will create canonical run; QR ${row.qrToken} attaches (was orphaned ASSIGNED)`);
    return { ok: true, workflowBagId: null, qrCardId: card.id, notes };
  }

  if (wbs.length !== 1 || wbs[0]!.id !== row.existingWorkflowBagId) {
    return {
      ok: false,
      reason: `Workflow bag set changed (found ${wbs.map((w) => w.id).join(", ") || "none"})`,
    };
  }
  const wb = wbs[0]!;
  if (wb.stage !== "SEALED" || wb.is_finalized || wb.finalized_at) {
    return { ok: false, reason: `Stage changed: ${wb.stage} finalized=${wb.is_finalized}` };
  }
  if (wb.recovery_status || wb.excluded_from_output) {
    return {
      ok: false,
      reason: `Recovery/exclusion set: ${wb.recovery_status}/${wb.excluded_from_output}`,
    };
  }
  const prod = (await dbOrTx.execute(sql`
    SELECT p.id::text, p.sku FROM products p WHERE p.id = ${wb.product_id}::uuid
  `)) as unknown as Array<{ id: string; sku: string }>;
  if (prod[0]?.sku !== row.productSku) {
    return { ok: false, reason: `Product changed: ${prod[0]?.sku} != ${row.productSku}` };
  }

  const events = (await dbOrTx.execute(sql`
    SELECT event_type::text FROM workflow_events
    WHERE workflow_bag_id = ${wb.id}::uuid ORDER BY occurred_at, id
  `)) as unknown as Array<{ event_type: string }>;
  const fingerprint = events.map((e) => e.event_type).join(",");
  if (fingerprint !== row.expectedEventFingerprint) {
    return {
      ok: false,
      reason: `Event chain changed since dry run: [${fingerprint}]`,
    };
  }

  const guards = (await dbOrTx.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM finished_lots WHERE workflow_bag_id = ${wb.id}::uuid) AS lots,
      (SELECT COUNT(*)::int FROM zoho_production_output_ops WHERE workflow_bag_id = ${wb.id}::uuid) AS zoho
  `)) as unknown as Array<{ lots: number; zoho: number }>;
  if ((guards[0]?.lots ?? 0) !== 0) return { ok: false, reason: "Finished lot appeared since dry run" };
  if ((guards[0]?.zoho ?? 0) !== 0) return { ok: false, reason: "Zoho op appeared since dry run" };

  return { ok: true, workflowBagId: wb.id, qrCardId: card.id, notes };
}

async function applyRow(row: RowConfig): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    const pf = await preflight(tx, row);
    if (!pf.ok) throw new Error(`PREFLIGHT_SKIP: ${pf.reason}`);

    const reason = auditReason(row);
    const mk = markers(row);
    let workflowBagId = pf.workflowBagId;
    const T = row.times;

    // Snapshot floor-board rows for the stations we touch; restored at end.
    const stationLiveBefore = (await tx.execute(sql`
      SELECT station_id::text, current_workflow_bag_id::text, last_event_type::text,
             last_event_at, updated_at
      FROM read_station_live
      WHERE station_id IN (${STATIONS.handpack}::uuid, ${STATIONS.sealing3}::uuid, ${STATIONS.packaging}::uuid)
    `)) as unknown as Array<{
      station_id: string;
      current_workflow_bag_id: string | null;
      last_event_type: string | null;
      last_event_at: string | null;
      updated_at: string | null;
    }>;

    // ── Run creation (rows 3/4) — mirrors the floor scan-card start ──
    if (row.createRun) {
      const [created] = await tx
        .insert(workflowBags)
        .values({
          inventoryBagId: row.inventoryBagId,
          startedAt: new Date(T.runStart!),
        })
        .returning({ id: workflowBags.id });
      if (!created) throw new Error("Failed to create workflow bag");
      workflowBagId = created.id;

      await tx
        .update(qrCards)
        .set({ assignedWorkflowBagId: workflowBagId, status: "ASSIGNED" })
        .where(eq(qrCards.id, pf.qrCardId));

      const opened = await openAllocationSessionInTx(tx, {
        inventoryBagId: row.inventoryBagId,
        workflowBagId,
        notes: reason,
        actor: null,
      });
      if (!opened.ok) throw new Error(`Allocation open failed: ${opened.error}`);

      await projectEvent(tx, {
        workflowBagId,
        stationId: STATIONS.handpack,
        eventType: "CARD_ASSIGNED",
        occurredAt: new Date(T.runStart!),
        payload: {
          qr_card_id: pf.qrCardId,
          station_kind: "HANDPACK_BLISTER",
          tablet_type_id: row.tabletTypeId,
          inventory_bag_id: row.inventoryBagId,
          ...mk,
        },
        ...ACCOUNTABILITY,
      });
      await projectEvent(tx, {
        workflowBagId,
        stationId: STATIONS.handpack,
        eventType: "HANDPACK_BLISTER_COMPLETE",
        occurredAt: new Date(T.handpackComplete!),
        payload: {
          tablet_type_id: row.tabletTypeId,
          tablet_type_source: "inventory_bag",
          inventory_bag_id: row.inventoryBagId,
          ...mk,
        },
        ...ACCOUNTABILITY,
      });
      await projectEvent(tx, {
        workflowBagId,
        stationId: STATIONS.handpack,
        eventType: "BAG_RELEASED",
        occurredAt: new Date(T.handpackReleased!),
        payload: {
          station_kind: "HANDPACK_BLISTER",
          released_at_stage: "BLISTERED",
          ...mk,
        },
        ...ACCOUNTABILITY,
      });
    }
    if (!workflowBagId) throw new Error("No workflow bag id resolved");

    // ── Sealing (rows 1, 3, 4) ──
    let sealingMaterial: string = "not_applicable";
    if (row.sealing) {
      const countTotal = row.sealing.presses * CARDS_PER_PRESS;

      if (row.createRun) {
        await projectEvent(tx, {
          workflowBagId,
          stationId: STATIONS.sealing3,
          eventType: "BAG_PICKED_UP",
          occurredAt: new Date(T.sealPickup!),
          payload: {
            from_stage: "BLISTERED",
            qr_card_id: pf.qrCardId,
            station_kind: "SEALING",
            ...mk,
          },
          ...ACCOUNTABILITY,
        });
        await tx
          .update(workflowBags)
          .set({ productId: row.productId })
          .where(eq(workflowBags.id, workflowBagId));
        await projectEvent(tx, {
          workflowBagId,
          stationId: STATIONS.sealing3,
          eventType: "PRODUCT_MAPPED",
          occurredAt: new Date(T.productMapped!),
          payload: {
            source: "SEALING_SELECTION",
            product_id: row.productId,
            product_sku: row.productSku,
            product_kind: "CARD",
            product_name: row.productName,
            station_kind: "SEALING",
            ...mk,
          },
          ...ACCOUNTABILITY,
        });
      }

      // Hand-pack bags: mirror the floor's sealing-time blister-card
      // material logic (issue+decrement when a MATERIAL-category BOM card
      // lot resolves; otherwise record the skip flags on the segment).
      // Machine-blistered bags (row 1) never run this logic on the floor.
      let skipFlags: Record<string, unknown> = {};
      if (row.handpack) {
        const lookup = await lookupProductMatchedBlisterCardLot(workflowBagId, tx);
        if (lookup.status === "found") {
          sealingMaterial = `issued ${Math.min(countTotal, lookup.lot.qtyOnHand)} from lot ${lookup.lot.id}`;
        } else {
          skipFlags = {
            handpack_blister_material_skipped: true,
            handpack_blister_material_skip_reason: lookup.reason,
          };
          sealingMaterial = `skipped (${lookup.reason})`;
        }
        await projectEvent(tx, {
          workflowBagId,
          stationId: STATIONS.sealing3,
          eventType: "SEALING_SEGMENT_COMPLETE",
          occurredAt: new Date(T.sealSegment!),
          payload: {
            count_total: countTotal,
            counter_presses: row.sealing.presses,
            cards_per_press: CARDS_PER_PRESS,
            ...skipFlags,
            ...mk,
          },
          ...ACCOUNTABILITY,
        });
        if (lookup.status === "found") {
          const issueQty = Math.min(countTotal, lookup.lot.qtyOnHand);
          await projectEvent(tx, {
            workflowBagId,
            stationId: STATIONS.sealing3,
            eventType: "PACKAGING_MATERIAL_ISSUED",
            occurredAt: new Date(T.sealSegment!),
            payload: {
              packaging_lot_id: lookup.lot.id,
              qty_issued: issueQty,
              reason: "handpack_seal",
              ...mk,
            },
            ...ACCOUNTABILITY,
          });
          await tx
            .update(packagingLots)
            .set({ qtyOnHand: sql`qty_on_hand - ${issueQty}` })
            .where(eq(packagingLots.id, lookup.lot.id));
        }
      } else {
        sealingMaterial = "not_applicable (machine-blistered)";
        await projectEvent(tx, {
          workflowBagId,
          stationId: STATIONS.sealing3,
          eventType: "SEALING_SEGMENT_COMPLETE",
          occurredAt: new Date(T.sealSegment!),
          payload: {
            count_total: countTotal,
            counter_presses: row.sealing.presses,
            cards_per_press: CARDS_PER_PRESS,
            ...mk,
          },
          ...ACCOUNTABILITY,
        });
      }

      if (row.createRun) {
        await projectEvent(tx, {
          workflowBagId,
          stationId: STATIONS.sealing3,
          eventType: "SEALING_COMPLETE",
          occurredAt: new Date(T.sealComplete!),
          payload: { lane_close: true, ...mk },
          ...ACCOUNTABILITY,
        });
        await projectEvent(tx, {
          workflowBagId,
          stationId: STATIONS.sealing3,
          eventType: "BAG_RELEASED",
          occurredAt: new Date(T.sealReleased!),
          payload: {
            station_kind: "SEALING",
            released_at_stage: "SEALED",
            ...mk,
          },
          ...ACCOUNTABILITY,
        });
      }
      // Row 1: the bag is already SEALED (historical lane close at Station 1);
      // only the missing Station-3 segment is appended. No stage change.
    }

    // ── Packaging (all rows) ──
    await projectEvent(tx, {
      workflowBagId,
      stationId: STATIONS.packaging,
      eventType: "BAG_PICKED_UP",
      occurredAt: new Date(T.packPickup),
      payload: {
        from_stage: "SEALED",
        qr_card_id: pf.qrCardId,
        station_kind: "PACKAGING",
        ...mk,
      },
      ...ACCOUNTABILITY,
    });
    await projectEvent(tx, {
      workflowBagId,
      stationId: STATIONS.packaging,
      eventType: "PACKAGING_COMPLETE",
      occurredAt: new Date(T.packComplete),
      payload: {
        master_cases: row.packaging.masterCases,
        displays_made: row.packaging.displaysMade,
        loose_cards: row.packaging.looseCards,
        damaged_packaging: row.packaging.damagedPackaging,
        ripped_cards: row.packaging.rippedCards,
        ...mk,
      },
      ...ACCOUNTABILITY,
    });
    const consumption = await emitCountBasedPackagingConsumption(tx, {
      workflowBagId,
      stationId: STATIONS.packaging,
      payload: {
        master_cases: row.packaging.masterCases,
        displays_made: row.packaging.displaysMade,
        loose_cards: row.packaging.looseCards,
        damaged_packaging: row.packaging.damagedPackaging,
        ripped_cards: row.packaging.rippedCards,
      },
      occurredAt: new Date(T.packComplete),
    });
    if (consumption.bomStatus !== "COMPLETE") {
      throw new Error(`Packaging consumption not COMPLETE: ${JSON.stringify(consumption)}`);
    }
    if (
      consumption.totalUnits !== row.expectedUnits ||
      consumption.totalDisplays !== row.expectedDisplays
    ) {
      throw new Error(
        `Output math mismatch: got ${consumption.totalUnits}u/${consumption.totalDisplays}d, expected ${row.expectedUnits}u/${row.expectedDisplays}d`,
      );
    }
    await patchPackagingCompleteConsumptionSummary(tx, {
      workflowBagId,
      summary: buildPackagingConsumptionPayloadSummary(consumption),
    });
    await refreshMaterialReadModelsAfterConsumption(tx, {
      refreshRecommendations: true,
    });

    // ── Finalize (canonical) ──
    await projectEvent(tx, {
      workflowBagId,
      stationId: STATIONS.packaging,
      eventType: "BAG_FINALIZED",
      occurredAt: new Date(T.finalized),
      payload: { ...mk },
      ...ACCOUNTABILITY,
    });

    // Canonical packaging-close service: creates AND releases the finished
    // lot and closes the allocation session from output math. When it is
    // blocked (row 2: prior session already DEPLETED at 0), replicate the
    // floor's audit-and-continue behavior — finalize stands, no lot.
    const autoLot = await autoCreateAndReleaseFinishedLotForWorkflowBag(tx, {
      workflowBagId,
      packagedAt: new Date(T.packComplete),
      counts: {
        masterCases: row.packaging.masterCases,
        displaysMade: row.packaging.displaysMade,
        looseCards: row.packaging.looseCards,
      },
      actor: { id: null, role: null },
    });
    let lotResult: Record<string, unknown>;
    if (autoLot.ok) {
      lotResult = {
        created: true,
        finishedLotId: autoLot.finishedLotId,
        finishedLotNumber: autoLot.finishedLotNumber,
        status: "RELEASED (canonical auto-release; Zoho effects NOT run)",
      };
    } else {
      lotResult = { created: false, blockedReason: autoLot.reason, message: autoLot.message };
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "finished_lot.auto_create_blocked",
          targetType: "WorkflowBag",
          targetId: workflowBagId,
          after: {
            reason: autoLot.reason,
            message: autoLot.message,
            backfill_source: SCRIPT_VERSION,
          },
        },
        tx,
      );
    }

    // Restore floor-board rows so the live view is undisturbed.
    for (const rowLive of stationLiveBefore) {
      await tx.execute(sql`
        INSERT INTO read_station_live (station_id, current_workflow_bag_id, last_event_type, last_event_at, updated_at)
        VALUES (${rowLive.station_id}::uuid, ${rowLive.current_workflow_bag_id}::uuid,
                ${rowLive.last_event_type}, ${rowLive.last_event_at}::timestamptz, ${rowLive.updated_at}::timestamptz)
        ON CONFLICT (station_id) DO UPDATE SET
          current_workflow_bag_id = EXCLUDED.current_workflow_bag_id,
          last_event_type = EXCLUDED.last_event_type,
          last_event_at = EXCLUDED.last_event_at,
          updated_at = EXCLUDED.updated_at
      `);
    }
    const snapshotIds = new Set(stationLiveBefore.map((r) => r.station_id));
    for (const sid of [STATIONS.handpack, STATIONS.sealing3, STATIONS.packaging]) {
      if (!snapshotIds.has(sid)) {
        await tx.execute(sql`
          UPDATE read_station_live SET current_workflow_bag_id = NULL
          WHERE station_id = ${sid}::uuid AND current_workflow_bag_id = ${workflowBagId}::uuid
        `);
      }
    }

    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_backfill.bulk_production_entries",
        targetType: "WorkflowBag",
        targetId: workflowBagId,
        after: {
          script: SCRIPT_VERSION,
          receipt: row.receipt,
          bag_number: row.bagNumber,
          audit_reason: reason,
          created_run: row.createRun,
          sealing_presses: row.sealing?.presses ?? null,
          sealing_count_total: row.sealing ? row.sealing.presses * CARDS_PER_PRESS : null,
          packaging: row.packaging,
          finished_lot: lotResult,
          zoho_effects_skipped: true,
        },
      },
      tx,
    );

    return {
      workflowBagId,
      sealingMaterial,
      totalUnits: consumption.totalUnits,
      totalDisplays: consumption.totalDisplays,
      finishedLot: lotResult,
    };
  });
}

async function globalCounts(): Promise<Record<string, unknown>> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM finished_lots) AS finished_lots,
      (SELECT COUNT(*)::int FROM zoho_production_output_ops) AS zoho_output_ops,
      (SELECT COUNT(*)::int FROM raw_bag_allocation_sessions) AS allocation_sessions,
      (SELECT COUNT(*)::int FROM qr_cards WHERE status = 'ASSIGNED') AS qr_assigned,
      (SELECT COUNT(*)::int FROM qr_cards WHERE status = 'IDLE') AS qr_idle,
      (SELECT COUNT(*)::int FROM qr_cards WHERE status = 'IDLE' AND assigned_workflow_bag_id IS NOT NULL) AS qr_idle_with_assignment
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? {};
}

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");
  console.log(`[${SCRIPT_VERSION}] mode=${applyMode ? "APPLY" : "DRY-RUN"}`);

  if (applyMode) {
    if (process.env.ALLOW_PRODUCTION_REPAIR !== "true") {
      console.error("Refusing apply: set ALLOW_PRODUCTION_REPAIR=true");
      process.exit(1);
    }
    if (process.env.CONFIRM_BULK !== "352173,352177,352180,352188") {
      console.error("Refusing apply: CONFIRM_BULK must be 352173,352177,352180,352188");
      process.exit(1);
    }
  }

  section("GLOBAL COUNTS (before)", await globalCounts());

  const results: Record<string, unknown> = {};
  for (const row of ROWS) {
    if (!applyMode) {
      const pf = await preflight(db as unknown as Tx, row);
      results[row.key] = pf.ok
        ? {
            status: "SAFE_TO_APPLY",
            workflowBag: pf.workflowBagId ?? "(will create)",
            notes: pf.notes,
            plan: {
              sealing: row.sealing
                ? `Station 3 segment: ${row.sealing.presses} presses x ${CARDS_PER_PRESS} = ${row.sealing.presses * CARDS_PER_PRESS} cards`
                : "none (already complete)",
              packaging: row.packaging,
              expected: `${row.expectedUnits} units / ${row.expectedDisplays} displays`,
              finalize: true,
              dates: row.times,
            },
          }
        : { status: "SKIP", reason: pf.reason };
      continue;
    }
    try {
      results[row.key] = { status: "APPLIED", ...(await applyRow(row)) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[row.key] = msg.startsWith("PREFLIGHT_SKIP:")
        ? { status: "SKIPPED_STALE", reason: msg.replace("PREFLIGHT_SKIP: ", "") }
        : { status: "FAILED", error: msg };
    }
  }

  section("ROW RESULTS", results);
  section("GLOBAL COUNTS (after)", await globalCounts());

  if (!applyMode) {
    console.log("\nDry-run complete — no mutations written.");
  } else {
    console.log("\nApply pass complete. Rows are independent transactions.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
