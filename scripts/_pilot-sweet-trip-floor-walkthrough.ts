// Pilot #2 — Sweet Trip floor walkthrough via real floor server actions.
//
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/_pilot-sweet-trip-floor-walkthrough.ts
//
// No live Zoho writes. Does not enable commit gates.

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  employees,
  finishedLots,
  inventoryBags,
  qrCards,
  rawBagAllocationSessions,
  readBagMetrics,
  readBagState,
  stationOperatorSessions,
  workflowBags,
  zohoProductionOutputOps,
  zohoRawBagReceives,
} from "@/lib/db/schema";
import {
  scanCardAction,
  fireStageEventAction,
  packagingCompleteAction,
  saveSealingProductAction,
  releaseBagAction,
} from "@/app/(floor)/floor/[token]/actions";
import { openOperatorSessionAction } from "@/app/(floor)/floor/[token]/operator-session-actions";
import {
  previewBagFinishReceive,
  loadBagFinishReceiveContext,
} from "@/lib/zoho/bag-finish-receive";
import { loadRawBagZohoReceivePanel } from "@/lib/zoho/raw-bag-receive-panel";
import { upsertConsolidatedProductionOutputOpForLot } from "@/lib/db/queries/zoho-production-output-consolidated";
import {
  SWEET_TRIP_PRODUCT_ID,
  SWEET_TRIP_SOURCE_BAG_ID,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";

const BAG_ID = SWEET_TRIP_SOURCE_BAG_ID;
const PRODUCT_ID = SWEET_TRIP_PRODUCT_ID;
const BAG_QR = "bag-card-137";
const UNITS = 10;

const EXCLUDED = {
  chocoBag352176: "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
  bagA: "d7669723-f133-4747-8c36-ae55c5d9a673",
  bagB: "f9dac8a0-dfb6-4af2-9012-374a124e31ca",
  fixRelaxBag: "e7fac20d-6514-4d6f-b8a1-bc4d120c5c3c",
} as const;

const STATIONS = {
  handpack: {
    id: "6e69f0dc-3557-4105-8ebd-e5c113444481",
    token: "80d421f6-44c0-4846-9d7f-586a37412759",
  },
  sealing: {
    id: "0953a15c-9857-4629-8980-78b47a33b371",
    token: "82f1c8cf-9d71-4f60-9aef-42cd50300906",
  },
  packaging: {
    id: "c174b1e0-4daf-4eb5-927b-622dd8038553",
    token: "ba2d44e1-8953-405b-8230-96888a76b282",
  },
} as const;

function refuseUnlessStaging() {
  const allow =
    process.env.ALLOW_STAGING_QA_DATA === "true" ||
    process.env.ALLOW_STAGING_QA_DATA === "1";
  if (!allow) {
    console.error("[sweet-trip-walkthrough] Refusing: set ALLOW_STAGING_QA_DATA=true");
    process.exit(2);
  }
}

function fd(entries: Record<string, string | number | undefined>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) form.set(k, String(v));
  }
  return form;
}

async function resolveQrCard(): Promise<{ cardId: string; scanToken: string }> {
  const [existing] = await db
    .select({ id: qrCards.id, status: qrCards.status, scanToken: qrCards.scanToken })
    .from(qrCards)
    .where(eq(qrCards.scanToken, BAG_QR))
    .limit(1);
  if (!existing) {
    throw new Error(
      `Physical QR card ${BAG_QR} not found. Link a received RAW_BAG card at intake first.`,
    );
  }
  if (existing.status !== "ASSIGNED" && existing.status !== "IDLE") {
    throw new Error(`QR card ${BAG_QR} is ${existing.status} — cannot start.`);
  }
  return { cardId: existing.id, scanToken: existing.scanToken };
}

async function pickEmployeeId(): Promise<string> {
  const [row] = await db.select({ id: employees.id }).from(employees).limit(1);
  if (!row) throw new Error("No employees in DB.");
  return row.id;
}

async function openShift(stationId: string, token: string, employeeId: string) {
  await db
    .update(stationOperatorSessions)
    .set({ closedAt: new Date() })
    .where(
      and(
        eq(stationOperatorSessions.stationId, stationId),
        isNull(stationOperatorSessions.closedAt),
      ),
    );
  const result = await openOperatorSessionAction(
    fd({
      token,
      stationId,
      employeeId,
      notes: "PM Sweet Trip pilot #2 walkthrough",
    }),
  );
  if (result.error) throw new Error(`openOperatorSession: ${result.error}`);
}

async function snapshotBag(label: string) {
  const [bag] = await db
    .select({
      status: inventoryBags.status,
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, BAG_ID))
    .limit(1);
  const sessions = await db
    .select({
      id: rawBagAllocationSessions.id,
      status: rawBagAllocationSessions.allocationStatus,
      starting: rawBagAllocationSessions.startingBalanceQty,
      consumed: rawBagAllocationSessions.consumedQty,
      ending: rawBagAllocationSessions.endingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, BAG_ID))
    .orderBy(desc(rawBagAllocationSessions.openedAt));
  const [zohoRow] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, BAG_ID))
    .limit(1);
  console.log(
    JSON.stringify({ step: label, bag, sessions, zohoRow: zohoRow ?? null }, null, 2),
  );
}

async function regressionSnapshot() {
  const bagIds = Object.entries(EXCLUDED);
  for (const [label, id] of bagIds) {
    const [bag] = await db
      .select({
        status: inventoryBags.status,
        internalReceiptNumber: inventoryBags.internalReceiptNumber,
      })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, id))
      .limit(1);
    const [zr] = await db
      .select({
        zohoReceiveStatus: zohoRawBagReceives.zohoReceiveStatus,
        zohoReceiveNumber: zohoRawBagReceives.zohoReceiveNumber,
      })
      .from(zohoRawBagReceives)
      .where(eq(zohoRawBagReceives.inventoryBagId, id))
      .limit(1);
    console.log(
      JSON.stringify({ step: `regression_${label}`, bag, zohoReceive: zr ?? null }, null, 2),
    );
  }

  const [fixRelaxOp] = await db
    .select({
      status: zohoProductionOutputOps.status,
      zohoBundleItemId: zohoProductionOutputOps.zohoBundleItemId,
    })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, "f0256ebc-5f3c-4d54-aff8-3e76228a3847"))
    .limit(1);
  console.log(JSON.stringify({ step: "regression_fix_relax_op", fixRelaxOp }, null, 2));
}

async function main() {
  refuseUnlessStaging();
  const employeeId = await pickEmployeeId();
  const qr = await resolveQrCard();
  console.log(JSON.stringify({ step: "qr_card", qr }, null, 2));

  await snapshotBag("starting_state");

  let workflowBagId: string;
  const [existingWf] = await db
    .select({ id: workflowBags.id, productId: workflowBags.productId })
    .from(qrCards)
    .innerJoin(workflowBags, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .where(eq(qrCards.id, qr.cardId))
    .limit(1);

  if (existingWf) {
    workflowBagId = existingWf.id;
    console.log(JSON.stringify({ step: "resume_workflow", workflowBagId }, null, 2));
  } else {
    await openShift(STATIONS.handpack.id, STATIONS.handpack.token, employeeId);
    const scan = await scanCardAction(
      fd({
        token: STATIONS.handpack.token,
        stationId: STATIONS.handpack.id,
        cardId: qr.cardId,
        productId: PRODUCT_ID,
        clientEventId: randomUUID(),
      }),
    );
    if (scan?.error) throw new Error(`scanCard: ${scan.error}`);

    const [wf] = await db
      .select({ id: workflowBags.id })
      .from(qrCards)
      .innerJoin(workflowBags, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
      .where(eq(qrCards.id, qr.cardId))
      .limit(1);
    if (!wf) throw new Error("Workflow bag not created after scan.");
    workflowBagId = wf.id;

    const handpack = await fireStageEventAction(
      fd({
        token: STATIONS.handpack.token,
        stationId: STATIONS.handpack.id,
        workflowBagId,
        eventType: "HANDPACK_BLISTER_COMPLETE",
        countTotal: UNITS,
        clientEventId: randomUUID(),
      }),
    );
    if (handpack?.error) throw new Error(`handpack complete: ${handpack.error}`);

    const releaseToSealing = await releaseBagAction(
      fd({
        token: STATIONS.handpack.token,
        stationId: STATIONS.handpack.id,
        workflowBagId,
        clientEventId: randomUUID(),
      }),
    );
    if (releaseToSealing?.error) throw new Error(`release to sealing: ${releaseToSealing.error}`);
  }

  const [wfProduct] = await db
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, workflowBagId))
    .limit(1);
  if (!wfProduct?.productId) {
    await openShift(STATIONS.sealing.id, STATIONS.sealing.token, employeeId);
    const mapProduct = await saveSealingProductAction(
      fd({
        token: STATIONS.sealing.token,
        stationId: STATIONS.sealing.id,
        workflowBagId,
        productId: PRODUCT_ID,
        clientEventId: randomUUID(),
      }),
    );
    if (mapProduct?.error) throw new Error(`saveSealingProduct: ${mapProduct.error}`);
  }

  const [stageBeforePack] = await db
    .select({ stage: readBagState.stage })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, workflowBagId))
    .limit(1);
  const stage = stageBeforePack?.stage ?? null;

  if (stage === "BLISTERED" || stage === "STARTED") {
    await openShift(STATIONS.sealing.id, STATIONS.sealing.token, employeeId);
    const pickup = await scanCardAction(
      fd({
        token: STATIONS.sealing.token,
        stationId: STATIONS.sealing.id,
        cardId: qr.cardId,
        clientEventId: randomUUID(),
      }),
    );
    if (pickup?.error) throw new Error(`sealing pickup: ${pickup.error}`);

    const segment = await fireStageEventAction(
      fd({
        token: STATIONS.sealing.token,
        stationId: STATIONS.sealing.id,
        workflowBagId,
        eventType: "SEALING_SEGMENT_COMPLETE",
        counterPresses: 2,
        clientEventId: randomUUID(),
      }),
    );
    if (segment?.error) throw new Error(`sealing segment: ${segment.error}`);

    const sealingDone = await fireStageEventAction(
      fd({
        token: STATIONS.sealing.token,
        stationId: STATIONS.sealing.id,
        workflowBagId,
        eventType: "SEALING_COMPLETE",
        sealingCloseMode: "whole",
        clientEventId: randomUUID(),
      }),
    );
    if (sealingDone?.error) throw new Error(`sealing complete: ${sealingDone.error}`);

    const releaseToPack = await releaseBagAction(
      fd({
        token: STATIONS.sealing.token,
        stationId: STATIONS.sealing.id,
        workflowBagId,
        clientEventId: randomUUID(),
      }),
    );
    if (releaseToPack?.error) throw new Error(`release to packaging: ${releaseToPack.error}`);
  }

  await openShift(STATIONS.packaging.id, STATIONS.packaging.token, employeeId);
  const [prePack] = await db
    .select({ stage: readBagState.stage })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, workflowBagId))
    .limit(1);
  if (prePack?.stage === "SEALED" || prePack?.stage === "BLISTERED") {
    const packPickup = await scanCardAction(
      fd({
        token: STATIONS.packaging.token,
        stationId: STATIONS.packaging.id,
        cardId: qr.cardId,
        clientEventId: randomUUID(),
      }),
    );
    if (packPickup?.error) throw new Error(`packaging pickup: ${packPickup.error}`);
  }

  const packaging = await packagingCompleteAction(
    fd({
      token: STATIONS.packaging.token,
      stationId: STATIONS.packaging.id,
      workflowBagId,
      masterCases: 0,
      displaysMade: 0,
      looseCards: UNITS,
      damagedPackaging: 0,
      rippedCards: 0,
      clientEventId: randomUUID(),
    }),
  );
  if (packaging?.error) throw new Error(`packaging complete: ${packaging.error}`);

  const [state] = await db
    .select({
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      looseCards: readBagMetrics.looseCards,
      unitsYielded: readBagMetrics.unitsYielded,
    })
    .from(readBagState)
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, readBagState.workflowBagId))
    .where(eq(readBagState.workflowBagId, workflowBagId))
    .limit(1);

  const [lot] = await db
    .select({
      id: finishedLots.id,
      finishedLotNumber: finishedLots.finishedLotNumber,
      unitsProduced: finishedLots.unitsProduced,
      productId: finishedLots.productId,
      status: finishedLots.status,
    })
    .from(finishedLots)
    .where(eq(finishedLots.workflowBagId, workflowBagId))
    .limit(1);

  const [session] = await db
    .select({
      id: rawBagAllocationSessions.id,
      status: rawBagAllocationSessions.allocationStatus,
      starting: rawBagAllocationSessions.startingBalanceQty,
      consumed: rawBagAllocationSessions.consumedQty,
      ending: rawBagAllocationSessions.endingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, BAG_ID))
    .orderBy(desc(rawBagAllocationSessions.closedAt))
    .limit(1);

  console.log(
    JSON.stringify(
      {
        step: "floor_complete",
        workflowBagId,
        readBagState: state ?? null,
        finishedLot: lot ?? null,
        allocationSession: session ?? null,
      },
      null,
      2,
    ),
  );

  await snapshotBag("after_floor");

  const preview = await previewBagFinishReceive(BAG_ID, null);
  console.log(
    JSON.stringify(
      {
        step: "bag_finish_preview",
        ok: preview.ok,
        httpStatus: preview.ok ? preview.httpStatus : null,
        error: preview.ok ? null : preview.reason,
        body: preview.ok ? preview.body : null,
      },
      null,
      2,
    ),
  );

  const [receiveRow] = await db
    .select()
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, BAG_ID))
    .limit(1);

  const ctx = await loadBagFinishReceiveContext(BAG_ID);
  const panel = await loadRawBagZohoReceivePanel(BAG_ID);

  console.log(
    JSON.stringify(
      {
        step: "receive_row",
        receiveRow: receiveRow ?? null,
        ctxEligible: ctx.ok && ctx.eligibility.eligible,
        ctxReason: ctx.ok && !ctx.eligibility.eligible ? ctx.eligibility.reason : null,
        panel,
      },
      null,
      2,
    ),
  );

  if (lot) {
    const poUpsert = await upsertConsolidatedProductionOutputOpForLot(lot.id, null);
    const [opRow] = poUpsert.ok
      ? await db
          .select({
            id: zohoProductionOutputOps.id,
            status: zohoProductionOutputOps.status,
            previewHttpStatus: zohoProductionOutputOps.previewHttpStatus,
            previewStatus: zohoProductionOutputOps.previewStatus,
            previewResponse: zohoProductionOutputOps.previewResponse,
            mappingBlockers: zohoProductionOutputOps.mappingBlockers,
          })
          .from(zohoProductionOutputOps)
          .where(eq(zohoProductionOutputOps.id, poUpsert.opId))
          .limit(1)
      : [];
    console.log(
      JSON.stringify(
        {
          step: "production_output_preview",
          upsert: poUpsert,
          op: opRow ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      JSON.stringify({ step: "production_output_preview", skipped: "no_finished_lot" }, null, 2),
    );
  }

  await regressionSnapshot();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
