// PARTIAL-SUBMIT-MUST-NOT-FINALIZE-WORKFLOW-1 — static + optional staging QA.
//
//   npx tsx scripts/verify-partial-submit-does-not-finalize.ts
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-partial-submit-does-not-finalize.ts

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
    console.error(`[verify-partial-submit-does-not-finalize] FAIL: ${msg}`);
    process.exit(1);
  }
}

function runStaticContracts(): void {
  const actions = read("app/(floor)/floor/[token]/actions.ts");
  const partial = read("lib/production/sealing-partial-closeout.ts");
  const projector = read("lib/projector/index.ts");

  assert(
    partial.includes("shouldEmitPartialPackagingComplete"),
    "partial helpers: emit gate after partial seal",
  );
  assert(
    partial.includes("partial_packaging: true"),
    "partial helpers: durable partial_packaging payload",
  );
  assert(
    actions.includes("emitPartialPackaging"),
    "actions: partial packaging branch",
  );
  assert(
    actions.includes('if (station.kind === "PACKAGING" && !emitPartialPackaging)'),
    "actions: skip auto-finalize when partial packaging",
  );
  assert(
    projector.includes("isPartialPackagingPayload"),
    "projector: partial packaging must not advance to PACKAGED",
  );
  assert(
    !actions.includes("maybeAutoFinalizeAfterPartialPackagingComplete"),
    "actions: no erroneous partial finalize helper",
  );

  console.log("[verify-partial-submit-does-not-finalize] PASS — static contracts OK");
}

const QA_PREFIX = "PARTIAL-SUBMIT-NO-FINALIZE-VERIFY";
const ALLOW_STAGING =
  process.env.ALLOW_STAGING_QA_DATA === "true" ||
  process.env.ALLOW_STAGING_QA_DATA === "1";

async function runStagingQa(): Promise<void> {
  if (!ALLOW_STAGING) {
    console.log(
      "[verify-partial-submit-does-not-finalize] SKIP staging QA (set ALLOW_STAGING_QA_DATA=true)",
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
  const { isNotNull } = await import("drizzle-orm");
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.isActive, true), isNotNull(products.unitsPerDisplay)))
    .limit(1);
  assert(
    Boolean(sealingStation && packStation && productRow),
    "need staging master data",
  );

  let workflowBagId: string | null = null;
  let cardId: string | null = null;
  let terminalBagId: string | null = null;
  let terminalCardId: string | null = null;
  const qaToken = `${QA_PREFIX}-${randomUUID().slice(0, 8)}`;

  try {
    const [bag] = await db
      .insert(workflowBags)
      .values({ productId: productRow!.id })
      .returning({ id: workflowBags.id });
    workflowBagId = bag!.id;

    const [card] = await db
      .insert(qrCards)
      .values({
        label: `${QA_PREFIX} Card`,
        scanToken: qaToken,
        cardType: "WORKFLOW_TRAVELER",
        status: "ASSIGNED",
        assignedWorkflowBagId: workflowBagId,
        notes: QA_PREFIX,
      })
      .returning({ id: qrCards.id });
    cardId = card!.id;

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: workflowBagId!,
        stationId: sealingStation!.id,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 50, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: workflowBagId!,
        stationId: sealingStation!.id,
        eventType: "SEALING_SEGMENT_COMPLETE",
        payload: { count_total: 12, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: workflowBagId!,
        stationId: sealingStation!.id,
        eventType: "SEALING_COMPLETE",
        payload: buildPartialSealingClosePayload({
          sealedPartialCount: 12,
          reason: "END_OF_SHIFT",
        }),
      });
      await projectEvent(tx, {
        workflowBagId: workflowBagId!,
        stationId: packStation!.id,
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
    });

    const events = await db
      .select({ eventType: workflowEvents.eventType, payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, workflowBagId));
    const hasFinalized = events.some((e) => e.eventType === "BAG_FINALIZED");
    assert(!hasFinalized, "partial path must not emit BAG_FINALIZED");

    const pkg = events.find((e) => e.eventType === "PACKAGING_COMPLETE");
    assert(
      (pkg?.payload as Record<string, unknown> | null)?.partial_packaging === true,
      "PACKAGING_COMPLETE must carry partial_packaging: true",
    );

    const [state] = await db
      .select({ stage: readBagState.stage, isFinalized: readBagState.isFinalized })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    assert(state?.isFinalized === false, "read_bag_state.finalized must stay false");
    assert(state?.stage === "BLISTERED", `stage must stay BLISTERED, got ${state?.stage}`);

    const [cardAfter] = await db
      .select({ status: qrCards.status, assignedWorkflowBagId: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, cardId!));
    assert(cardAfter?.status === "ASSIGNED", "QR card must stay ASSIGNED");
    assert(
      cardAfter?.assignedWorkflowBagId === workflowBagId,
      "QR card must stay on workflow bag",
    );

    const slices = events.map((e) => ({
      eventType: e.eventType,
      payload: (e.payload as Record<string, unknown> | null) ?? null,
    }));
    assert(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(slices, {
        stage: state?.stage ?? null,
        isFinalized: false,
      }),
      "sealing station can resume same card",
    );

    // Whole-bag path still finalizes.
    const [terminalBag] = await db
      .insert(workflowBags)
      .values({ productId: productRow!.id })
      .returning({ id: workflowBags.id });
    terminalBagId = terminalBag!.id;
    const [terminalCard] = await db
      .insert(qrCards)
      .values({
        label: `${QA_PREFIX} Terminal`,
        scanToken: `${QA_PREFIX}-term-${randomUUID().slice(0, 6)}`,
        cardType: "WORKFLOW_TRAVELER",
        status: "ASSIGNED",
        assignedWorkflowBagId: terminalBagId,
        notes: QA_PREFIX,
      })
      .returning({ id: qrCards.id });
    terminalCardId = terminalCard!.id;

    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: terminalBagId!,
        stationId: sealingStation!.id,
        eventType: "BLISTER_COMPLETE",
        payload: { count_total: 50, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: terminalBagId!,
        stationId: sealingStation!.id,
        eventType: "SEALING_COMPLETE",
        payload: { lane_close: true, qa: QA_PREFIX },
      });
      await projectEvent(tx, {
        workflowBagId: terminalBagId!,
        stationId: packStation!.id,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          master_cases: 1,
          displays_made: 0,
          loose_cards: 0,
          damaged_packaging: 0,
          ripped_cards: 0,
          qa: QA_PREFIX,
        },
      });
      await projectEvent(tx, {
        workflowBagId: terminalBagId!,
        stationId: packStation!.id,
        eventType: "BAG_FINALIZED",
        payload: { qa: QA_PREFIX },
      });
    });

    const [terminalState] = await db
      .select({ isFinalized: readBagState.isFinalized, stage: readBagState.stage })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, terminalBagId));
    assert(terminalState?.isFinalized === true, "whole-bag path still finalizes");

    console.log("[verify-partial-submit-does-not-finalize] PASS — staging QA OK");
  } finally {
    for (const id of [workflowBagId, terminalBagId]) {
      if (!id) continue;
      await db.delete(workflowEvents).where(eq(workflowEvents.workflowBagId, id));
      await db.delete(readBagState).where(eq(readBagState.workflowBagId, id));
      await db.delete(workflowBags).where(eq(workflowBags.id, id));
    }
    for (const id of [cardId, terminalCardId]) {
      if (id) await db.delete(qrCards).where(eq(qrCards.id, id));
    }
  }
}

runStaticContracts();
runStagingQa().catch((err) => {
  console.error(err);
  process.exit(1);
});
