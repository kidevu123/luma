// PARTIAL-BAG-NOT-LISTED-AFTER-PARTIAL-PACKAGING-1 — DB-backed verify.
//
// Static:
//   npx tsx scripts/verify-available-partial-bag-after-partial-packaging.ts
//
// Staging QA (self-cleaning):
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-available-partial-bag-after-partial-packaging.ts

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QA_PREFIX = "PARTIAL-BAG-LIST-VERIFY";

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-available-partial-bag-after-partial-packaging] FAIL: ${msg}`);
    process.exit(1);
  }
}

function runStaticContracts(): void {
  try {
    readFileSync(resolve(root, "app/(floor)/floor/[token]/actions.ts"));
  } catch {
    console.log("[verify-available-partial-bag-after-partial-packaging] SKIP static (no checkout)");
    return;
  }

  const actions = read("app/(floor)/floor/[token]/actions.ts");
  const partial = read("lib/production/partial-bags.ts");
  const lifecycle = read("lib/production/partial-bag-inventory-lifecycle.ts");
  const page = read("app/(admin)/partial-bags/page.tsx");

  assert(
    actions.includes("maybeReturnInventoryAfterPartialPackaging"),
    "actions: partial packaging inventory return hook",
  );
  assert(
    lifecycle.includes("deriveSafeSessionReturnEstimate"),
    "lifecycle: safe ledger return estimate",
  );
  assert(
    !lifecycle.includes("sealed_partial_count"),
    "lifecycle: no sealed-card count fabrication",
  );
  assert(partial.includes("loadPartialBagAdminRows"), "partial-bags: admin rows loader");
  assert(
    partial.includes("classifyPartialBagInventoryEligibility"),
    "partial-bags: eligibility classifier",
  );
  assert(page.includes("loadPartialBagAdminRows"), "page: admin rows wired");
  assert(page.includes("needs_allocation_closeout"), "page: review state visible");

  console.log("[verify-available-partial-bag-after-partial-packaging] PASS — static OK");
}

const ALLOW_STAGING =
  process.env.ALLOW_STAGING_QA_DATA === "true" ||
  process.env.ALLOW_STAGING_QA_DATA === "1";

async function runStagingQa(): Promise<void> {
  if (!ALLOW_STAGING) {
    console.log(
      "[verify-available-partial-bag-after-partial-packaging] SKIP staging QA (set ALLOW_STAGING_QA_DATA=true)",
    );
    return;
  }

  const { db } = await import("@/lib/db");
  const {
    inventoryBags,
    products,
    purchaseOrders,
    qrCards,
    rawBagAllocationEvents,
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
  const {
    buildPartialPackagingCompletePayload,
    buildPartialSealingClosePayload,
  } = await import("@/lib/production/sealing-partial-closeout");
  const { loadPartialBagAdminRows } = await import("@/lib/production/partial-bags");
  const { maybeReturnInventoryAfterPartialPackaging } = await import(
    "@/lib/production/partial-bag-inventory-lifecycle"
  );

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
  assert(sealingStation != null && packStation != null, "need SEALING + PACKAGING stations");

  const { isNotNull } = await import("drizzle-orm");
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.isActive, true), isNotNull(products.unitsPerDisplay)))
    .limit(1);
  const [tabletType] = await db
    .select({ id: tabletTypes.id })
    .from(tabletTypes)
    .where(eq(tabletTypes.isActive, true))
    .limit(1);
  assert(productRow?.id != null, "need active product");
  assert(tabletType?.id != null, "need active tablet type");
  if (!productRow?.id || !tabletType?.id || !sealingStation || !packStation) return;

  const productId = productRow.id;
  const tabletTypeId = tabletType.id;
  const sealingStationId = sealingStation.id;
  const packStationId = packStation.id;

  let workflowBagId: string | null = null;
  let inventoryBagId: string | null = null;
  let sessionId: string | null = null;
  let cardId: string | null = null;
  let poId: string | null = null;
  let receiveId: string | null = null;
  let smallBoxId: string | null = null;
  const tag = randomUUID().slice(0, 8);

  try {
    const [po] = await db
      .insert(purchaseOrders)
      .values({
        poNumber: `${QA_PREFIX}-PO-${tag}`,
        status: "OPEN",
        notes: QA_PREFIX,
      })
      .returning({ id: purchaseOrders.id });
    assert(po != null, "insert PO");
    if (!po) return;
    poId = po.id;

    const [recv] = await db
      .insert(receives)
      .values({
        poId: po.id,
        receiveName: `${QA_PREFIX}-RCV-${tag}`,
        notes: QA_PREFIX,
      })
      .returning({ id: receives.id });
    assert(recv != null, "insert receive");
    if (!recv) return;
    receiveId = recv.id;

    const [box] = await db
      .insert(smallBoxes)
      .values({
        receiveId: recv.id,
        boxNumber: 1,
        defaultTabletTypeId: tabletTypeId,
        totalBags: 1,
      })
      .returning({ id: smallBoxes.id });
    assert(box != null, "insert small box");
    if (!box) return;
    smallBoxId = box.id;

    const [invBag] = await db
      .insert(inventoryBags)
      .values({
        smallBoxId: box.id,
        bagNumber: 1,
        tabletTypeId: tabletTypeId,
        bagQrCode: `${QA_PREFIX}-${tag}`,
        declaredPillCount: 10_000,
        pillCount: 10_000,
        status: "AVAILABLE",
        notes: QA_PREFIX,
      })
      .returning({ id: inventoryBags.id });
    assert(invBag != null, "insert inventory bag");
    if (!invBag) return;
    inventoryBagId = invBag.id;

    const [wfBag] = await db
      .insert(workflowBags)
      .values({ productId, inventoryBagId: invBag.id })
      .returning({ id: workflowBags.id });
    assert(wfBag != null, "insert workflow bag");
    if (!wfBag) return;
    workflowBagId = wfBag.id;

    const qaToken = `${QA_PREFIX}-card-${randomUUID().slice(0, 6)}`;
    const [card] = await db
      .insert(qrCards)
      .values({
        label: QA_PREFIX,
        scanToken: qaToken,
        cardType: "WORKFLOW_TRAVELER",
        status: "ASSIGNED",
        assignedWorkflowBagId: wfBag.id,
        notes: QA_PREFIX,
      })
      .returning({ id: qrCards.id });
    cardId = card?.id ?? null;

    await db.insert(readBagState).values({
      workflowBagId: wfBag.id,
      stage: "STARTED",
      isPaused: false,
      isFinalized: false,
    });

    const [session] = await db
      .insert(rawBagAllocationSessions)
      .values({
        inventoryBagId: invBag.id,
        workflowBagId: wfBag.id,
        productId,
        allocationStatus: "OPEN",
        startingBalanceQty: 10_000,
        startingBalanceSource: "VENDOR_DECLARED",
        unitOfMeasure: "tablets",
        confidence: "LOW",
        notes: QA_PREFIX,
      })
      .returning({ id: rawBagAllocationSessions.id });
    assert(session != null, "insert allocation session");
    if (!session) return;
    sessionId = session.id;

    await db.insert(rawBagAllocationEvents).values({
      allocationSessionId: session.id,
      inventoryBagId: invBag.id,
      workflowBagId: wfBag.id,
      eventType: "RAW_BAG_OPENED",
      quantity: "10000",
      unitOfMeasure: "tablets",
      quantitySource: "VENDOR_DECLARED",
      payload: { qa: QA_PREFIX },
      confidence: "LOW",
      clientEventId: randomUUID(),
    });
    await db.insert(rawBagAllocationEvents).values({
      allocationSessionId: session.id,
      inventoryBagId: invBag.id,
      workflowBagId: wfBag.id,
      eventType: "RAW_BAG_PARTIAL_CONSUMED",
      quantity: "2500",
      unitOfMeasure: "tablets",
      quantitySource: "MANUAL_ENTRY",
      payload: { qa: QA_PREFIX },
      confidence: "HIGH",
      clientEventId: randomUUID(),
    });

    await db
      .update(inventoryBags)
      .set({ status: "IN_USE" })
      .where(eq(inventoryBags.id, invBag.id));

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: wfBag.id,
        stationId: sealingStationId,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 100, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: wfBag.id,
        stationId: sealingStationId,
        eventType: "SEALING_SEGMENT_COMPLETE",
        payload: { count_total: 12, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: wfBag.id,
        stationId: sealingStationId,
        eventType: "SEALING_COMPLETE",
        payload: buildPartialSealingClosePayload({
          sealedPartialCount: 12,
          reason: "END_OF_SHIFT",
        }),
      });
      await projectEvent(tx, {
        workflowBagId: wfBag.id,
        stationId: packStationId,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          ...buildPartialPackagingCompletePayload({
            masterCases: 0,
            displaysMade: 1,
            looseCards: 0,
            damagedPackaging: 0,
            rippedCards: 0,
            sealedPartialCount: 12,
          }),
          qa: QA_PREFIX,
        },
      });

      const result = await maybeReturnInventoryAfterPartialPackaging(tx, {
        workflowBagId: wfBag.id,
        inventoryBagId: invBag.id,
        stationId: packStationId,
        accountability: {
          enteredByUserId: null,
          accountableEmployeeId: null,
          accountabilitySource: "MANUAL_TEXT",
          accountableEmployeeNameSnapshot: QA_PREFIX,
          isStable: false,
        },
        clientEventId: randomUUID(),
      });
      assert(result.returned === true, `inventory return: ${result.reason ?? "ok"}`);
    });

    const [invAfter] = await db
      .select({ status: inventoryBags.status })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, invBag.id));
    assert(invAfter?.status === "AVAILABLE", `inventory status: ${invAfter?.status}`);

    const rows = await loadPartialBagAdminRows();
    const hit = rows.find((r) => r.bagId === invBag.id && r.eligibility === "ready");
    assert(hit != null, "loadPartialBagAdminRows includes ready partial bag");

    console.log("[verify-available-partial-bag-after-partial-packaging] PASS — staging QA OK");
  } finally {
    if (sessionId) {
      await db
        .delete(rawBagAllocationEvents)
        .where(eq(rawBagAllocationEvents.allocationSessionId, sessionId));
      await db.delete(rawBagAllocationSessions).where(eq(rawBagAllocationSessions.id, sessionId));
    }
    if (workflowBagId) {
      await db.delete(workflowEvents).where(eq(workflowEvents.workflowBagId, workflowBagId));
      await db.delete(readBagState).where(eq(readBagState.workflowBagId, workflowBagId));
      await db.delete(workflowBags).where(eq(workflowBags.id, workflowBagId));
    }
    if (cardId) {
      await db.delete(qrCards).where(eq(qrCards.id, cardId));
    }
    if (inventoryBagId) {
      await db.delete(inventoryBags).where(eq(inventoryBags.id, inventoryBagId));
    }
    if (smallBoxId) {
      await db.delete(smallBoxes).where(eq(smallBoxes.id, smallBoxId));
    }
    if (receiveId) {
      await db.delete(receives).where(eq(receives.id, receiveId));
    }
    if (poId) {
      await db.delete(purchaseOrders).where(eq(purchaseOrders.id, poId));
    }
  }
}

async function main(): Promise<void> {
  runStaticContracts();
  await runStagingQa();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
