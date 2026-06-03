// PARTIAL-PACKAGING-MUST-NOT-TERMINATE-CARD-ASSIGNMENT-1 — static + optional staging QA.
//
// Static (always):
//   npx tsx scripts/verify-partial-packaging-resume.ts
//
// Staging DB integration (QA-tagged, self-cleaning):
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-partial-packaging-resume.ts

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-partial-packaging-resume] FAIL: ${msg}`);
    process.exit(1);
  }
}

function runStaticContracts(): void {
  const actionsPath = resolve(root, "app/(floor)/floor/[token]/actions.ts");
  try {
    readFileSync(actionsPath);
  } catch {
    console.log(
      "[verify-partial-packaging-resume] SKIP static contracts (no source tree)",
    );
    return;
  }

  const actions = read("app/(floor)/floor/[token]/actions.ts");
  const page = read("app/(floor)/floor/[token]/page.tsx");
  const partial = read("lib/production/sealing-partial-closeout.ts");
  const projector = read("lib/projector/index.ts");
  const form = read("app/(floor)/floor/[token]/scan-card-form.tsx");

  assert(
    partial.includes("partial_packaging: true"),
    "partial helpers: durable partial_packaging flag",
  );
  assert(
    partial.includes("shouldEmitPartialPackagingComplete"),
    "partial helpers: emit gate",
  );
  assert(
    partial.includes("isWorkflowBagResumableAtSealingAfterPartialPackaging"),
    "partial helpers: sealing resume predicate",
  );
  assert(
    projector.includes("isPartialPackagingPayload"),
    "projector: partial packaging stage guard",
  );
  assert(
    actions.includes("partialPackagingResume"),
    "actions: scan partial packaging resume path",
  );
  assert(
    actions.includes("partial_packaging_resume: true"),
    "actions: BAG_PICKED_UP partial_packaging_resume payload",
  );
  assert(
    actions.includes("isWorkflowBagResumableAtSealingAfterPartialPackaging"),
    "actions: assigned pickup filter for legacy PACKAGED",
  );
  assert(
    page.includes("eligiblePartialPackagingResumes"),
    "page: partial packaging resume dropdown",
  );
  assert(
    form.includes("partial packaged — resume sealing"),
    "scan form: partial packaged resume label",
  );
  assert(
    actions.includes("!emitPartialPackaging"),
    "actions: skip auto-finalize on partial packaging",
  );

  console.log("[verify-partial-packaging-resume] PASS — static contracts OK");
}

const QA_PREFIX = "PARTIAL-PKG-RESUME-VERIFY";
const ALLOW_STAGING =
  process.env.ALLOW_STAGING_QA_DATA === "true" ||
  process.env.ALLOW_STAGING_QA_DATA === "1";

async function runStagingQa(): Promise<void> {
  if (!ALLOW_STAGING) {
    console.log(
      "[verify-partial-packaging-resume] SKIP staging QA (set ALLOW_STAGING_QA_DATA=true)",
    );
    return;
  }

  const { db } = await import("@/lib/db");
  const {
    products,
    qrCards,
    readBagState,
    stations,
    workflowBags,
    workflowEvents,
  } = await import("@/lib/db/schema");
  const { projectEvent } = await import("@/lib/projector");
  const {
    buildPartialPackagingCompletePayload,
    buildPartialSealingClosePayload,
    isWorkflowBagResumableAtSealingAfterPartialPackaging,
  } = await import("@/lib/production/sealing-partial-closeout");

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
  if (!sealingStation || !packStation) {
    assert(false, "need active SEALING + PACKAGING stations on staging");
    return;
  }

  const { isNotNull } = await import("drizzle-orm");
  const [productRow] = await db
    .select({
      id: products.id,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
    })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        isNotNull(products.unitsPerDisplay),
        isNotNull(products.displaysPerCase),
      ),
    )
    .limit(1);
  if (
    !productRow?.id ||
    productRow.unitsPerDisplay == null ||
    productRow.displaysPerCase == null
  ) {
    assert(false, "need an active product with packaging structure on staging");
    return;
  }
  const productId = productRow.id;

  let workflowBagId: string | null = null;
  let cardId: string | null = null;
  const qaCardToken = `${QA_PREFIX}-${randomUUID().slice(0, 8)}`;

  try {
    const [bag] = await db
      .insert(workflowBags)
      .values({ productId })
      .returning({ id: workflowBags.id });
    if (!bag) {
      assert(false, "could not insert QA workflow bag");
      return;
    }
    workflowBagId = bag.id;
    const bagId = workflowBagId;

    const [cardRow] = await db
      .insert(qrCards)
      .values({
        label: `${QA_PREFIX} Card`,
        scanToken: qaCardToken,
        cardType: "WORKFLOW_TRAVELER",
        status: "ASSIGNED",
        assignedWorkflowBagId: bagId,
        notes: QA_PREFIX,
      })
      .returning({ id: qrCards.id });
    if (!cardRow) {
      assert(false, "could not insert QA qr card");
      return;
    }
    cardId = cardRow.id;
    const sealingStationId = sealingStation.id;
    const packStationId = packStation.id;

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: sealingStationId,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 100, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: sealingStationId,
        eventType: "SEALING_SEGMENT_COMPLETE",
        payload: { count_total: 18, qa: QA_PREFIX },
        clientEventId: randomUUID(),
      });
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: sealingStationId,
        eventType: "SEALING_COMPLETE",
        payload: buildPartialSealingClosePayload({
          sealedPartialCount: 18,
          reason: "END_OF_SHIFT",
        }),
        clientEventId: randomUUID(),
      });
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: packStationId,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          ...buildPartialPackagingCompletePayload({
            masterCases: 0,
            displaysMade: 1,
            looseCards: 0,
            damagedPackaging: 0,
            rippedCards: 0,
            sealedPartialCount: 18,
          }),
          qa: QA_PREFIX,
        },
        clientEventId: randomUUID(),
      });
    });

    const [state] = await db
      .select({
        stage: readBagState.stage,
        isFinalized: readBagState.isFinalized,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    assert(state?.stage === "BLISTERED", `stage after partial packaging: ${state?.stage}`);
    assert(state?.isFinalized === false, "bag must not be finalized");

    const [card] = await db
      .select({
        status: qrCards.status,
        assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      })
      .from(qrCards)
      .where(eq(qrCards.id, cardId));
    assert(card?.status === "ASSIGNED", "QR must stay assigned");
    assert(card?.assignedWorkflowBagId === workflowBagId, "QR must stay on workflow bag");

    const events = await db
      .select({ eventType: workflowEvents.eventType, payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, workflowBagId));
    const slices = events.map((e) => ({
      eventType: e.eventType,
      payload: (e.payload as Record<string, unknown> | null) ?? null,
    }));
    assert(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(slices, {
        stage: state?.stage ?? null,
        isFinalized: false,
      }),
      "sealing resume allowed after partial packaging",
    );

    // Whole-bag terminal path must not reopen at sealing.
    const [terminalBag] = await db
      .insert(workflowBags)
      .values({ productId })
      .returning({ id: workflowBags.id });
    if (!terminalBag) {
      assert(false, "could not insert terminal QA workflow bag");
      return;
    }
    const terminalBagId = terminalBag.id;
    const [terminalCard] = await db
      .insert(qrCards)
      .values({
        label: `${QA_PREFIX} Terminal`,
        scanToken: `${QA_PREFIX}-terminal-${randomUUID().slice(0, 6)}`,
        cardType: "WORKFLOW_TRAVELER",
        status: "ASSIGNED",
        assignedWorkflowBagId: terminalBagId,
        notes: QA_PREFIX,
      })
      .returning({ id: qrCards.id });
    if (!terminalCard) {
      assert(false, "could not insert terminal QA qr card");
      return;
    }
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: terminalBagId,
        stationId: sealingStationId,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 50, qa: QA_PREFIX },
        clientEventId: randomUUID(),
      });
      await projectEvent(tx, {
        workflowBagId: terminalBagId,
        stationId: sealingStationId,
        eventType: "SEALING_COMPLETE",
        payload: { lane_close: true, qa: QA_PREFIX },
        clientEventId: randomUUID(),
      });
      await projectEvent(tx, {
        workflowBagId: terminalBagId,
        stationId: packStationId,
        eventType: "PACKAGING_COMPLETE",
        payload: { master_cases: 1, qa: QA_PREFIX },
        clientEventId: randomUUID(),
      });
    });
    const terminalEvents = await db
      .select({ eventType: workflowEvents.eventType, payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, terminalBagId));
    assert(
      !isWorkflowBagResumableAtSealingAfterPartialPackaging(
        terminalEvents.map((e) => ({
          eventType: e.eventType,
          payload: (e.payload as Record<string, unknown> | null) ?? null,
        })),
        { stage: "PACKAGED", isFinalized: false },
      ),
      "whole-bag PACKAGED must not be resumable at sealing",
    );

    await db.delete(workflowEvents).where(eq(workflowEvents.workflowBagId, terminalBagId));
    await db.delete(readBagState).where(eq(readBagState.workflowBagId, terminalBagId));
    await db.delete(workflowBags).where(eq(workflowBags.id, terminalBagId));
    await db.delete(qrCards).where(eq(qrCards.id, terminalCard.id));

    console.log("[verify-partial-packaging-resume] PASS — staging QA OK");
  } finally {
    if (workflowBagId) {
      await db
        .delete(workflowEvents)
        .where(eq(workflowEvents.workflowBagId, workflowBagId));
      await db.delete(readBagState).where(eq(readBagState.workflowBagId, workflowBagId));
      await db.delete(workflowBags).where(eq(workflowBags.id, workflowBagId));
    }
    if (cardId) {
      await db.delete(qrCards).where(eq(qrCards.id, cardId));
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
