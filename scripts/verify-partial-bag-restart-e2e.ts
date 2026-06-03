// PARTIAL-BAG-RESTART-PRODUCT-SELECTION-1 — staging DB E2E.
//
//   ALLOW_STAGING_QA_DATA=true \
//   VERIFY_PARTIAL_BAG_RESTART_STAGING_ONLY=true \
//   npx tsx scripts/verify-partial-bag-restart-e2e.ts
//
// On LXC:
//   docker compose exec -T -e ALLOW_STAGING_QA_DATA=true \
//     -e VERIFY_PARTIAL_BAG_RESTART_STAGING_ONLY=true \
//     app node_modules/.bin/tsx scripts/verify-partial-bag-restart-e2e.ts

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

export const QA_MARKER = "QA-PARTIAL-BAG-RESTART-1";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-partial-bag-restart-e2e] FAIL: ${msg}`);
    process.exit(1);
  }
}

function refuseUnlessStaging(): void {
  const allow =
    process.env.ALLOW_STAGING_QA_DATA === "true" ||
    process.env.ALLOW_STAGING_QA_DATA === "1";
  const stagingOnly =
    process.env.VERIFY_PARTIAL_BAG_RESTART_STAGING_ONLY === "true" ||
    process.env.VERIFY_PARTIAL_BAG_RESTART_STAGING_ONLY === "1";
  if (!allow || !stagingOnly) {
    console.error(
      "[verify-partial-bag-restart-e2e] Refusing: set ALLOW_STAGING_QA_DATA=true and VERIFY_PARTIAL_BAG_RESTART_STAGING_ONLY=true",
    );
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production" && !allow) {
    console.error("[verify-partial-bag-restart-e2e] Refusing in production without ALLOW_STAGING_QA_DATA");
    process.exit(2);
  }
}

type CleanupIds = {
  workflowBagIds: string[];
  cardIds: string[];
  sessionIds: string[];
  allocationEventIds: number[];
  inventoryBagIds: string[];
  smallBoxIds: string[];
  receiveIds: string[];
  poIds: string[];
};

async function countQaRows(db: Awaited<typeof import("@/lib/db")>["db"]): Promise<number> {
  const { inventoryBags, purchaseOrders, qrCards, receives } =
    await import("@/lib/db/schema");
  const like = `%${QA_MARKER}%`;
  const counts = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(sql`${purchaseOrders.poNumber} LIKE ${like}`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(receives)
      .where(sql`${receives.receiveName} LIKE ${like}`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryBags)
      .where(sql`${inventoryBags.internalReceiptNumber} LIKE ${like}`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(qrCards)
      .where(sql`${qrCards.label} LIKE ${like}`),
  ]);
  return counts.reduce((sum, r) => sum + (r[0]?.n ?? 0), 0);
}

async function cleanup(ids: CleanupIds): Promise<void> {
  const { db } = await import("@/lib/db");
  const {
    inventoryBags,
    purchaseOrders,
    qrCards,
    rawBagAllocationEvents,
    rawBagAllocationSessions,
    readBagState,
    readStationLive,
    receives,
    smallBoxes,
    workflowBags,
    workflowEvents,
  } = await import("@/lib/db/schema");

  if (ids.workflowBagIds.length > 0) {
    await db
      .delete(workflowEvents)
      .where(inArray(workflowEvents.workflowBagId, ids.workflowBagIds));
    await db
      .delete(readBagState)
      .where(inArray(readBagState.workflowBagId, ids.workflowBagIds));
    await db
      .delete(readStationLive)
      .where(inArray(readStationLive.currentWorkflowBagId, ids.workflowBagIds));
    await db.delete(workflowBags).where(inArray(workflowBags.id, ids.workflowBagIds));
  }
  if (ids.allocationEventIds.length > 0) {
    await db
      .delete(rawBagAllocationEvents)
      .where(inArray(rawBagAllocationEvents.id, ids.allocationEventIds));
  }
  if (ids.sessionIds.length > 0) {
    await db
      .delete(rawBagAllocationSessions)
      .where(inArray(rawBagAllocationSessions.id, ids.sessionIds));
  }
  if (ids.cardIds.length > 0) {
    await db.delete(qrCards).where(inArray(qrCards.id, ids.cardIds));
  }
  if (ids.inventoryBagIds.length > 0) {
    await db
      .delete(inventoryBags)
      .where(inArray(inventoryBags.id, ids.inventoryBagIds));
  }
  if (ids.smallBoxIds.length > 0) {
    await db.delete(smallBoxes).where(inArray(smallBoxes.id, ids.smallBoxIds));
  }
  if (ids.receiveIds.length > 0) {
    await db.delete(receives).where(inArray(receives.id, ids.receiveIds));
  }
  if (ids.poIds.length > 0) {
    await db.delete(purchaseOrders).where(inArray(purchaseOrders.id, ids.poIds));
  }
}

async function runStagingE2e(): Promise<void> {
  const { db } = await import("@/lib/db");
  const {
    inventoryBags,
    productAllowedTablets,
    products,
    purchaseOrders,
    qrCards,
    rawBagAllocationSessions,
    readBagState,
    receives,
    smallBoxes,
    stations,
    tabletTypes,
    workflowBags,
    workflowEvents,
  } = await import("@/lib/db/schema");
  const { projectEvent } = await import("@/lib/projector");
  const { checkPackagingPrereqs } = await import("@/lib/production/packaging-prereqs");
  const {
    canRestartAvailablePartialRawBag,
  } = await import("@/lib/production/partial-bag-restart");
  const { validateRawBagQrForStart } = await import("@/lib/production/start-production");
  const { deriveBagStatusAfterClose } = await import("@/lib/production/bag-allocation");
  const { checkStageProgression } = await import("@/lib/production/stage-progression");

  const preExisting = await countQaRows(db);
  console.log(`[verify-partial-bag-restart-e2e] pre-run QA marker rows: ${preExisting}`);

  const [blisterStation] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(and(eq(stations.kind, "BLISTER"), eq(stations.isActive, true)))
    .limit(1);
  const [sealingStation] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(and(eq(stations.kind, "SEALING"), eq(stations.isActive, true)))
    .limit(1);
  const [packStation] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(and(eq(stations.kind, "PACKAGING"), eq(stations.isActive, true)))
    .limit(1);
  assert(!!blisterStation && !!sealingStation && !!packStation, "need BLISTER, SEALING, PACKAGING stations");

  const allowedPairs = await db
    .select({
      tabletTypeId: productAllowedTablets.tabletTypeId,
      productId: products.id,
      sku: products.sku,
      name: products.name,
      kind: products.kind,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
    })
    .from(productAllowedTablets)
    .innerJoin(products, eq(products.id, productAllowedTablets.productId))
    .where(
      and(
        eq(products.isActive, true),
        eq(products.kind, "CARD"),
        isNotNull(products.unitsPerDisplay),
        isNotNull(products.displaysPerCase),
      ),
    );

  const byTablet = new Map<
    string,
    Array<(typeof allowedPairs)[number]>
  >();
  for (const row of allowedPairs) {
    const list = byTablet.get(row.tabletTypeId) ?? [];
    list.push(row);
    byTablet.set(row.tabletTypeId, list);
  }
  let tabletTypeId: string | null = null;
  let productA: (typeof allowedPairs)[number] | null = null;
  let productB: (typeof allowedPairs)[number] | null = null;
  for (const [tt, list] of byTablet) {
    const distinct = list.filter(
      (p, i, arr) => arr.findIndex((x) => x.productId === p.productId) === i,
    );
    if (distinct.length >= 2) {
      tabletTypeId = tt;
      productA = distinct[0]!;
      productB = distinct[1]!;
      break;
    }
  }
  if (!tabletTypeId || !productA || !productB) {
    assert(
      false,
      "need two distinct CARD products on same tablet type with packaging structure",
    );
    return;
  }
  if (productA.productId === productB.productId) {
    assert(false, "Product A and B must differ");
    return;
  }

  const ttId = tabletTypeId;
  const prodA = productA;
  const prodB = productB;
  const blisterStationId = blisterStation!.id;
  const sealingStationId = sealingStation!.id;
  const packStationId = packStation!.id;

  const [tabletRow] = await db
    .select({ name: tabletTypes.name })
    .from(tabletTypes)
    .where(eq(tabletTypes.id, ttId))
    .limit(1);
  assert(!!tabletRow, "tablet type row");

  const tag = `${QA_MARKER}-${randomUUID().slice(0, 8)}`;
  const ids: CleanupIds = {
    workflowBagIds: [],
    cardIds: [],
    sessionIds: [],
    allocationEventIds: [],
    inventoryBagIds: [],
    smallBoxIds: [],
    receiveIds: [],
    poIds: [],
  };

  try {
    const [po] = await db
      .insert(purchaseOrders)
      .values({
        poNumber: `${QA_MARKER}-PO-${tag}`,
        vendorName: QA_MARKER,
        status: "OPEN",
        notes: QA_MARKER,
      })
      .returning({ id: purchaseOrders.id });
    if (!po) {
      assert(false, "po insert");
      return;
    }
    ids.poIds.push(po.id);

    const [recv] = await db
      .insert(receives)
      .values({
        poId: po.id,
        receiveName: `${QA_MARKER}-RCV-${tag}`,
        notes: QA_MARKER,
      })
      .returning({ id: receives.id });
    if (!recv) {
      assert(false, "receive insert");
      return;
    }
    ids.receiveIds.push(recv.id);

    const [box] = await db
      .insert(smallBoxes)
      .values({
        receiveId: recv.id,
        boxNumber: 1,
        defaultTabletTypeId: ttId,
        totalBags: 1,
      })
      .returning({ id: smallBoxes.id });
    if (!box) {
      assert(false, "small box insert");
      return;
    }
    ids.smallBoxIds.push(box.id);

    const bagQr = `${QA_MARKER}-BAG-${tag}`;
    const [invBag] = await db
      .insert(inventoryBags)
      .values({
        smallBoxId: box.id,
        bagNumber: 1,
        tabletTypeId: ttId,
        status: "IN_USE",
        bagQrCode: bagQr,
        internalReceiptNumber: `${QA_MARKER}-IR-${tag}`,
        declaredPillCount: 10_000,
        pillCount: 10_000,
        notes: QA_MARKER,
      })
      .returning({ id: inventoryBags.id });
    if (!invBag) {
      assert(false, "inventory bag insert");
      return;
    }
    ids.inventoryBagIds.push(invBag.id);

    const [card] = await db
      .insert(qrCards)
      .values({
        label: `${QA_MARKER}-QR`,
        scanToken: bagQr,
        cardType: "RAW_BAG",
        status: "ASSIGNED",
        notes: QA_MARKER,
      })
      .returning({ id: qrCards.id });
    if (!card) {
      assert(false, "qr card insert");
      return;
    }
    ids.cardIds.push(card.id);

    // ── Run 1: Product A ─────────────────────────────────────────
    const [wf1] = await db
      .insert(workflowBags)
      .values({
        productId: prodA.productId,
        inventoryBagId: invBag.id,
      })
      .returning({ id: workflowBags.id, productId: workflowBags.productId });
    if (!wf1) {
      assert(false, "workflow bag 1");
      return;
    }
    ids.workflowBagIds.push(wf1.id);
    await db
      .update(qrCards)
      .set({ assignedWorkflowBagId: wf1.id })
      .where(eq(qrCards.id, card.id));

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: wf1.id,
        stationId: blisterStationId,
        eventType: "CARD_ASSIGNED",
        payload: { qa: QA_MARKER, product_a: prodA.productId },
      });
      await projectEvent(tx, {
        workflowBagId: wf1.id,
        stationId: blisterStationId,
        eventType: "PRODUCT_MAPPED",
        payload: {
          product_id: prodA.productId,
          product_sku: prodA.sku,
          product_name: prodA.name,
          source: "QA_FIRST_RUN",
          qa: QA_MARKER,
        },
      });
    });

    const [openSession] = await db
      .insert(rawBagAllocationSessions)
      .values({
        inventoryBagId: invBag.id,
        workflowBagId: wf1.id,
        productId: prodA.productId,
        allocationStatus: "OPEN",
        startingBalanceQty: 10_000,
        notes: QA_MARKER,
      })
      .returning({ id: rawBagAllocationSessions.id });
    if (!openSession) {
      assert(false, "allocation session");
      return;
    }
    ids.sessionIds.push(openSession.id);

    const endingBalance = 6_000;
    const consumedQty = 4_000;
    await db
      .update(rawBagAllocationSessions)
      .set({
        allocationStatus: "CLOSED",
        closedAt: new Date(),
        consumedQty,
        endingBalanceQty: endingBalance,
        endingBalanceSource: "WEIGH_BACK",
      })
      .where(eq(rawBagAllocationSessions.id, openSession.id));

    const newBagStatus = deriveBagStatusAfterClose(endingBalance);
    assert(newBagStatus === "AVAILABLE", "partial close sets AVAILABLE");
    await db
      .update(inventoryBags)
      .set({ status: "AVAILABLE" })
      .where(eq(inventoryBags.id, invBag.id));

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: wf1.id,
        stationId: packStationId,
        eventType: "BAG_FINALIZED",
        payload: { qa: QA_MARKER },
      });
    });

    const [wf1Final] = await db
      .select({
        productId: workflowBags.productId,
        isFinalized: readBagState.isFinalized,
      })
      .from(workflowBags)
      .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
      .where(eq(workflowBags.id, wf1.id));
    assert(wf1Final?.productId === prodA.productId, "run 1 keeps Product A");
    assert(wf1Final?.isFinalized === true, "run 1 finalized");

    const sessions = await db
      .select({
        allocationStatus: rawBagAllocationSessions.allocationStatus,
        endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
        closedAt: rawBagAllocationSessions.closedAt,
      })
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.inventoryBagId, invBag.id));

    assert(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "AVAILABLE",
        sessions: sessions as import("@/lib/production/partial-bags").PartialBagSession[],
      }),
      "partial bag eligible for restart",
    );

    const qrOk = validateRawBagQrForStart(
      {
        status: "ASSIGNED",
        cardType: "RAW_BAG",
        assignedWorkflowBagId: wf1.id,
      },
      bagQr,
      { allowPartialBagRestart: true },
    );
    assert(qrOk.ok, "QR valid for partial restart");

    // ── Run 2: restart with Product B (admin-start shape) ────────
    const [wf2] = await db
      .insert(workflowBags)
      .values({
        productId: prodB.productId,
        inventoryBagId: invBag.id,
      })
      .returning({ id: workflowBags.id, productId: workflowBags.productId });
    if (!wf2) {
      assert(false, "workflow bag 2");
      return;
    }
    ids.workflowBagIds.push(wf2.id);

    assert(
      wf2.productId === prodB.productId,
      "new run uses Product B, not inherited A",
    );
    assert(wf2.productId !== prodA.productId, "Product B distinct from A");

    await db
      .update(qrCards)
      .set({ assignedWorkflowBagId: wf2.id })
      .where(eq(qrCards.id, card.id));

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: wf2.id,
        stationId: blisterStationId,
        eventType: "CARD_ASSIGNED",
        payload: {
          qa: QA_MARKER,
          partial_bag_restart: true,
          inventory_bag_id: invBag.id,
        },
      });
      await projectEvent(tx, {
        workflowBagId: wf2.id,
        stationId: blisterStationId,
        eventType: "PRODUCT_MAPPED",
        payload: {
          product_id: prodB.productId,
          product_sku: prodB.sku,
          product_name: prodB.name,
          source: "ADMIN_START_PRODUCTION",
          qa: QA_MARKER,
        },
      });
      await projectEvent(tx, {
        workflowBagId: wf2.id,
        stationId: blisterStationId,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 100, qa: QA_MARKER },
      });
      await projectEvent(tx, {
        workflowBagId: wf2.id,
        stationId: sealingStationId,
        eventType: "SEALING_SEGMENT_COMPLETE",
        payload: { count_total: 24, qa: QA_MARKER },
        clientEventId: randomUUID(),
      });
      await projectEvent(tx, {
        workflowBagId: wf2.id,
        stationId: sealingStationId,
        eventType: "SEALING_COMPLETE",
        payload: { lane_close: true, qa: QA_MARKER },
        clientEventId: randomUUID(),
      });
    });

    const [wf2Mid] = await db
      .select({ productId: workflowBags.productId, stage: readBagState.stage })
      .from(workflowBags)
      .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
      .where(eq(workflowBags.id, wf2.id));
    assert(wf2Mid?.productId === prodB.productId, "Product B persists through sealing");
    assert(wf2Mid?.stage === "SEALED", "stage SEALED after lane close");

    const [productBRow] = await db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        unitsPerDisplay: products.unitsPerDisplay,
        displaysPerCase: products.displaysPerCase,
      })
      .from(products)
      .where(eq(products.id, prodB.productId));

    const packPrereq = checkPackagingPrereqs({
      bag: { id: wf2.id, productId: wf2Mid?.productId ?? null },
      product: productBRow
        ? {
            id: productBRow.id,
            name: productBRow.name,
            sku: productBRow.sku,
            unitsPerDisplay: productBRow.unitsPerDisplay,
            displaysPerCase: productBRow.displaysPerCase,
          }
        : null,
    });
    assert(packPrereq.ok, `packaging prereq for Product B: ${!packPrereq.ok ? packPrereq.reason : ""}`);

    const prog = checkStageProgression({
      eventType: "PACKAGING_COMPLETE",
      currentStage: "SEALED",
    });
    assert(prog.allowed, "packaging allowed at SEALED");

    const [cardBeforePack] = await db
      .select({
        status: qrCards.status,
        assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      })
      .from(qrCards)
      .where(eq(qrCards.id, card.id));
    assert(cardBeforePack?.assignedWorkflowBagId === wf2.id, "QR on run 2 before packaging");

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: wf2.id,
        stationId: packStationId,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          master_cases: 0,
          displays_made: 1,
          loose_cards: 0,
          qa: QA_MARKER,
        },
        clientEventId: randomUUID(),
      });
    });

    const [wf2Packaged] = await db
      .select({
        bagProductId: workflowBags.productId,
        readProductId: readBagState.productId,
        stage: readBagState.stage,
      })
      .from(workflowBags)
      .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
      .where(eq(workflowBags.id, wf2.id));
    assert(wf2Packaged?.stage === "PACKAGED", "packaged stage");
    assert(wf2Packaged?.bagProductId === prodB.productId, "workflow_bags still Product B");
    assert(wf2Packaged?.readProductId === prodB.productId, "read_bag_state uses Product B");

    const mappedEvents = await db
      .select({ payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.workflowBagId, wf2.id),
          eq(workflowEvents.eventType, "PRODUCT_MAPPED"),
        ),
      );
    assert(
      mappedEvents.some(
        (e) =>
          (e.payload as Record<string, unknown> | null)?.product_id ===
          prodB.productId,
      ),
      "PRODUCT_MAPPED on run 2 references Product B",
    );

    const [wf1After] = await db
      .select({ productId: workflowBags.productId })
      .from(workflowBags)
      .where(eq(workflowBags.id, wf1.id));
    assert(
      wf1After?.productId === prodA.productId,
      "prior workflow bag still Product A (not mutated)",
    );

    const [cardAfter] = await db
      .select({ assignedWorkflowBagId: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, card.id));
    assert(cardAfter?.assignedWorkflowBagId === wf2.id, "QR stays on current run after packaging");

    console.log(
      `[verify-partial-bag-restart-e2e] PASS — Product A=${prodA.sku} run1, Product B=${prodB.sku} run2+packaging`,
    );
  } finally {
    await cleanup(ids);
    const leftover = await countQaRows(db);
    assert(leftover === preExisting, `cleanup sweep: expected ${preExisting} QA rows, got ${leftover}`);
    console.log(
      `[verify-partial-bag-restart-e2e] cleanup sweep OK (${leftover} preexisting QA marker rows)`,
    );
  }
}

async function main(): Promise<void> {
  refuseUnlessStaging();
  await runStagingE2e();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
