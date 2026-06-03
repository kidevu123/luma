// PARTIAL-BAG-REVIEW-CLOSEOUT-WORKFLOW-1 — static + optional staging QA.
//
//   npx tsx scripts/verify-partial-bag-review-closeout.ts
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-partial-bag-review-closeout.ts

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-partial-bag-review-closeout] FAIL: ${msg}`);
    process.exit(1);
  }
}

function runStaticContracts(): void {
  const page = read("app/(admin)/partial-bags/page.tsx");
  const resolvePage = read("app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx");
  const actions = read("app/(admin)/partial-bags/actions.ts");
  const lib = read("lib/production/partial-bag-review-closeout.ts");

  assert(page.includes("Resolve inventory"), "partial-bags: Resolve inventory action");
  assert(page.includes("missing_linkage"), "partial-bags: Needs review resolve gate");
  assert(resolvePage.includes("requireLead"), "resolve page: lead auth");
  assert(resolvePage.includes("traceability only"), "resolve page: anti-fabrication copy");
  assert(actions.includes("requireLead"), "actions: lead auth");
  assert(lib.includes("partial_bag.inventory_resolution"), "lib: audit action name");
  assert(lib.includes("admin_partial_bag_review_closeout"), "lib: session marker");
  assert(lib.includes("endingBalanceQty: args.remainingTabletCount"), "lib: admin-entered ending balance");

  console.log("[verify-partial-bag-review-closeout] PASS — static contracts OK");
}

const QA_PREFIX = "PARTIAL-BAG-REVIEW-CLOSEOUT-VERIFY";
const ALLOW_STAGING =
  process.env.ALLOW_STAGING_QA_DATA === "true" ||
  process.env.ALLOW_STAGING_QA_DATA === "1";

async function runStagingQa(): Promise<void> {
  if (!ALLOW_STAGING) {
    console.log(
      "[verify-partial-bag-review-closeout] SKIP staging QA (set ALLOW_STAGING_QA_DATA=true)",
    );
    return;
  }

  const { db } = await import("@/lib/db");
  const {
    inventoryBags,
    products,
    purchaseOrders,
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
  const { loadPartialBagAdminRows } = await import("@/lib/production/partial-bags");
  const {
    buildPartialPackagingCompletePayload,
    buildPartialSealingClosePayload,
  } = await import("@/lib/production/sealing-partial-closeout");
  const { resolvePartialBagInventoryLedger } = await import(
    "@/lib/production/partial-bag-review-closeout"
  );
  const { canRestartAvailablePartialRawBag } = await import(
    "@/lib/production/partial-bag-restart"
  );

  const adminRows = (await db.execute(sql`
    SELECT id::text AS id, role::text AS role
    FROM users
    WHERE disabled_at IS NULL AND role IN ('OWNER','ADMIN')
    LIMIT 1
  `)) as unknown as Array<{ id: string; role: string }>;
  const admin = adminRows[0];
  assert(admin != null, "need admin user for QA resolution");

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
  const [tabletType] = await db
    .select({ id: tabletTypes.id })
    .from(tabletTypes)
    .where(eq(tabletTypes.isActive, true))
    .limit(1);
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.isActive, true))
    .limit(1);
  assert(
    Boolean(sealingStation && packStation && tabletType && productRow),
    "need staging master data",
  );

  let poId: string | null = null;
  let receiveId: string | null = null;
  let smallBoxId: string | null = null;
  let inventoryBagId: string | null = null;
  let workflowBagId: string | null = null;
  let sessionId: string | null = null;
  const tag = randomUUID().slice(0, 8);

  try {
    const [po] = await db
      .insert(purchaseOrders)
      .values({ poNumber: `${QA_PREFIX}-PO-${tag}`, status: "OPEN", notes: QA_PREFIX })
      .returning({ id: purchaseOrders.id });
    poId = po!.id;

    const [recv] = await db
      .insert(receives)
      .values({ poId: po!.id, receiveName: `${QA_PREFIX}-RCV`, notes: QA_PREFIX })
      .returning({ id: receives.id });
    receiveId = recv!.id;

    const [box] = await db
      .insert(smallBoxes)
      .values({
        receiveId: recv!.id,
        boxNumber: 1,
        defaultTabletTypeId: tabletType!.id,
        totalBags: 1,
      })
      .returning({ id: smallBoxes.id });
    smallBoxId = box!.id;

    const [invBag] = await db
      .insert(inventoryBags)
      .values({
        smallBoxId: box!.id,
        bagNumber: 1,
        tabletTypeId: tabletType!.id,
        bagQrCode: `${QA_PREFIX}-${tag}`,
        declaredPillCount: 5000,
        pillCount: 5000,
        status: "AVAILABLE",
        notes: QA_PREFIX,
      })
      .returning({ id: inventoryBags.id });
    inventoryBagId = invBag!.id;

    const [wfBag] = await db
      .insert(workflowBags)
      .values({
        productId: productRow!.id,
        inventoryBagId: invBag!.id,
      })
      .returning({ id: workflowBags.id });
    workflowBagId = wfBag!.id;

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: wfBag!.id,
        stationId: sealingStation!.id,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 100, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: wfBag!.id,
        stationId: sealingStation!.id,
        eventType: "SEALING_SEGMENT_COMPLETE",
        payload: { count_total: 10, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: wfBag!.id,
        stationId: sealingStation!.id,
        eventType: "SEALING_COMPLETE",
        payload: buildPartialSealingClosePayload({
          sealedPartialCount: 10,
          reason: "END_OF_SHIFT",
        }),
      });
      await projectEvent(tx, {
        workflowBagId: wfBag!.id,
        stationId: packStation!.id,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          ...buildPartialPackagingCompletePayload({
            masterCases: 0,
            displaysMade: 1,
            looseCards: 0,
            damagedPackaging: 0,
            rippedCards: 0,
            sealedPartialCount: 10,
          }),
          qa: QA_PREFIX,
        },
      });
    });

    const beforeRows = await loadPartialBagAdminRows();
    const reviewRow = beforeRows.find(
      (r) => r.bagId === inventoryBagId && r.eligibility === "missing_linkage",
    );
    assert(reviewRow != null, "loadPartialBagAdminRows classifies Needs review before resolution");

    const resolved = await resolvePartialBagInventoryLedger({
      inventoryBagId: invBag!.id,
      remainingTabletCount: 4200,
      resolutionMethod: "PHYSICAL_COUNT",
      note: `${QA_PREFIX} floor count verified`,
      actor: {
        id: admin!.id,
        role: admin!.role as "ADMIN",
        email: "qa@luma",
        employeeId: null,
      },
    });
    assert(resolved.ok, `resolution failed: ${!resolved.ok ? resolved.error : ""}`);
    if (!resolved.ok) return;
    sessionId = resolved.sessionId;

    const [session] = await db
      .select({
        allocationStatus: rawBagAllocationSessions.allocationStatus,
        endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      })
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.id, resolved.sessionId));
    assert(session?.allocationStatus === "RETURNED_TO_STOCK", "session RETURNED_TO_STOCK");
    assert(session?.endingBalanceQty === 4200, "session ending balance set");

    const sessions = await db
      .select({
        allocationStatus: rawBagAllocationSessions.allocationStatus,
        endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
        closedAt: rawBagAllocationSessions.closedAt,
      })
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.inventoryBagId, invBag!.id));

    assert(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "AVAILABLE",
        sessions: sessions.map((s) => ({
          allocationStatus: s.allocationStatus as "RETURNED_TO_STOCK",
          endingBalanceQty: s.endingBalanceQty,
          closedAt: s.closedAt,
        })),
      }),
      "Start run eligibility after resolution",
    );

    const afterRows = await loadPartialBagAdminRows();
    const readyRow = afterRows.find(
      (r) => r.bagId === inventoryBagId && r.eligibility === "ready",
    );
    assert(readyRow != null, "loadPartialBagAdminRows classifies Ready after resolution");

    const leftover = await db
      .select({ id: inventoryBags.id })
      .from(inventoryBags)
      .where(sql`${inventoryBags.notes} = ${QA_PREFIX}`);
    assert(leftover.length === 1, "QA bag still present before cleanup");

    console.log("[verify-partial-bag-review-closeout] PASS — staging QA OK");
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

    const remaining = await db
      .select({ id: inventoryBags.id })
      .from(inventoryBags)
      .where(sql`${inventoryBags.notes} = ${QA_PREFIX}`);
    assert(remaining.length === 0, "zero QA inventory rows remain after cleanup");
  }
}

runStaticContracts();
runStagingQa().catch((err) => {
  console.error(err);
  process.exit(1);
});
