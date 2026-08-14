// SEALING-PARTIAL-CLOSEOUT-1 — contract + optional staging QA.
//
// Static (always):
//   npx tsx scripts/verify-sealing-partial-closeout.ts
//
// Staging DB integration (QA-tagged, self-cleaning):
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-sealing-partial-closeout.ts

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
    console.error(`[verify-sealing-partial-closeout] FAIL: ${msg}`);
    process.exit(1);
  }
}

function runStaticContracts(): void {
  const actionsPath = resolve(root, "app/(floor)/floor/[token]/actions.ts");
  try {
    readFileSync(actionsPath);
  } catch {
    console.log(
      "[verify-sealing-partial-closeout] SKIP static contracts (no source tree — run from repo checkout)",
    );
    return;
  }

  const actions = read("app/(floor)/floor/[token]/actions.ts");
  // P4b Task 5 (THE CUTOVER): the three UI assertions that used to read
  // stage-action-buttons.tsx now read the operator screen, where the
  // flow lives as More -> "Close sealing early" (the spec's Normal /
  // Exception split — closing a bag that is not empty is an exception,
  // so it is deliberately not a third button beside "Yes, bag empty").
  const screen = read("app/(floor)/floor/[token]/operator-screen.tsx");
  const operatorActions = read("app/(floor)/floor/[token]/operator-actions.ts");
  // P4a extractions moved fireStageEventAction's and
  // packagingCompleteAction's transaction bodies out of actions.ts into
  // the engine, which left the four server assertions below reading a
  // file the code had already vacated (this script had been FAILING on
  // the first of them since then). They now read the modules that
  // actually hold the behaviour.
  const recordStage = read("lib/production/engine/record-stage-event.ts");
  const recordPackaging = read(
    "lib/production/engine/record-packaging-complete.ts",
  );
  const projector = read("lib/projector/index.ts");
  const partial = read("lib/production/sealing-partial-closeout.ts");
  const progression = read("lib/production/stage-progression.ts");


  assert(screen.includes("Close sealing early"), "Step 3 UI: Close sealing early entry");
  assert(
    screen.includes('sealingCloseMode: "partial"'),
    "Step 3 UI: submits sealingCloseMode partial",
  );
  assert(
    screen.includes("SEALING_PARTIAL_CLOSE_REASONS") &&
      screen.includes("SEALING_PARTIAL_CLOSE_REASON_LABELS"),
    "Step 3 UI: reason picker draws from the engine vocabulary",
  );
  assert(
    !screen.includes("Confirm sealing complete"),
    "Step 3 UI: old confirm copy absent",
  );
  assert(
    operatorActions.includes("sealingCloseMode") &&
      operatorActions.includes("partialCloseReason"),
    "operator-actions: partial close fields reach advanceBag",
  );

  assert(actions.includes("sealingCloseMode"), "actions: sealingCloseMode form field");
  assert(
    recordStage.includes("sealingFinalOnPureStation"),
    "engine: pure sealing final close skips counter",
  );
  assert(
    recordStage.includes("validateSealingPartialCloseInput"),
    "engine: partial validation",
  );
  assert(
    recordStage.includes("maybeAutoReleaseAfterPartialSealingClose"),
    "engine: partial auto-release",
  );
  assert(
    recordPackaging.includes("packagingPartialSealedReady"),
    "engine: packaging BLISTERED gate",
  );

  assert(projector.includes("resolveStageForWorkflowEvent"), "projector: stage resolver");
  assert(projector.includes("isPartialSealingClosePayload"), "projector: partial payload guard");

  assert(partial.includes("partial_close: true"), "partial helpers: durable partial_close flag");
  assert(partial.includes("lane_close: false"), "partial helpers: not whole lane close");
  assert(partial.includes("partial_packaging: true"), "partial helpers: partial_packaging flag");
  assert(
    partial.includes("isWorkflowBagResumableAtSealingAfterPartialPackaging"),
    "partial helpers: resumable after partial packaging",
  );
  assert(
    recordPackaging.includes("shouldEmitPartialPackagingComplete"),
    "engine: partial packaging emit gate",
  );
  assert(
    recordPackaging.includes("buildPartialPackagingCompletePayload"),
    "engine: partial packaging payload builder",
  );
  assert(
    recordPackaging.includes("!emitPartialPackaging"),
    "engine: skip auto-finalize for partial packaging",
  );
  assert(projector.includes("isPartialPackagingPayload"), "projector: partial packaging payload guard");

  assert(
    progression.includes("packagingPartialSealedReady"),
    "stage-progression: packaging BLISTERED exception",
  );

  console.log("[verify-sealing-partial-closeout] PASS — static contracts OK");
}

const QA_PREFIX = "SEAL-PARTIAL-VERIFY";
const ALLOW_STAGING =
  process.env.ALLOW_STAGING_QA_DATA === "true" ||
  process.env.ALLOW_STAGING_QA_DATA === "1";

async function runStagingQa(): Promise<void> {
  if (!ALLOW_STAGING) {
    console.log(
      "[verify-sealing-partial-closeout] SKIP staging QA (set ALLOW_STAGING_QA_DATA=true)",
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
  const { checkStageProgression } = await import("@/lib/production/stage-progression");
  const {
    buildPartialPackagingCompletePayload,
    buildPartialSealingClosePayload,
    allowsPackagingCompleteAtBlistered,
    isPartialPackagingPayload,
    isPartialSealingClosePayload,
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

  const sealingStationId = sealingStation.id;
  const packStationId = packStation.id;
  const productId = productRow.id;

  const qaCardToken = `${QA_PREFIX}-${randomUUID().slice(0, 8)}`;
  let workflowBagId: string | null = null;
  let cardId: string | null = null;

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

    const [card] = await db
      .insert(qrCards)
      .values({
        label: QA_PREFIX,
        scanToken: qaCardToken,
        cardType: "WORKFLOW_TRAVELER",
        status: "ASSIGNED",
        assignedWorkflowBagId: workflowBagId,
        notes: QA_PREFIX,
      })
      .returning({ id: qrCards.id });
    if (!card) {
      assert(false, "could not insert QA qr card");
      return;
    }
    cardId = card.id;

    const clientSegment = randomUUID();
    const clientPartial = randomUUID();

    const bagId = workflowBagId;
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
        payload: { count_total: 24, qa: QA_PREFIX },
        clientEventId: clientSegment,
      });
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: sealingStationId,
        eventType: "SEALING_COMPLETE",
        payload: buildPartialSealingClosePayload({
          sealedPartialCount: 24,
          reason: "END_OF_SHIFT",
        }),
        clientEventId: clientPartial,
      });
    });

    const [state] = await db
      .select({ stage: readBagState.stage })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    assert(state?.stage === "BLISTERED", `stage after partial close: ${state?.stage}`);

    const events = await db
      .select({ eventType: workflowEvents.eventType, payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, workflowBagId));

    const partialEv = events.find((e) => e.eventType === "SEALING_COMPLETE");
    assert(
      partialEv != null && isPartialSealingClosePayload(partialEv.payload as Record<string, unknown>),
      "partial SEALING_COMPLETE payload persisted",
    );

    assert(
      allowsPackagingCompleteAtBlistered(
        events.map((e) => ({
          eventType: e.eventType,
          payload: (e.payload as Record<string, unknown> | null) ?? null,
        })),
      ),
      "allowsPackagingCompleteAtBlistered",
    );

    const prog = checkStageProgression({
      eventType: "PACKAGING_COMPLETE",
      currentStage: "BLISTERED",
      packagingPartialSealedReady: true,
    });
    assert(prog.allowed, `packaging progression: ${!prog.allowed && "reason" in prog ? prog.reason : ""}`);

    const [cardBefore] = await db
      .select({ status: qrCards.status, assignedWorkflowBagId: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, cardId));
    assert(cardBefore?.status === "ASSIGNED", "QR must stay assigned before packaging");
    assert(
      cardBefore?.assignedWorkflowBagId === workflowBagId,
      "QR must stay on workflow bag before packaging",
    );

    await db.transaction(async (tx) => {
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
            sealedPartialCount: 24,
          }),
          qa: QA_PREFIX,
        },
        clientEventId: randomUUID(),
      });
    });

    const [stateAfter] = await db
      .select({ stage: readBagState.stage, isFinalized: readBagState.isFinalized })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    assert(
      stateAfter?.stage === "BLISTERED",
      `stage after partial packaging: ${stateAfter?.stage} (must stay BLISTERED)`,
    );
    assert(stateAfter?.isFinalized === false, "partial packaging must not finalize bag");

    const eventsAfterPack = await db
      .select({ eventType: workflowEvents.eventType, payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, workflowBagId));
    const packEv = eventsAfterPack.find((e) => e.eventType === "PACKAGING_COMPLETE");
    assert(
      packEv != null && isPartialPackagingPayload(packEv.payload as Record<string, unknown>),
      "partial PACKAGING_COMPLETE payload persisted",
    );
    assert(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(
        eventsAfterPack.map((e) => ({
          eventType: e.eventType,
          payload: (e.payload as Record<string, unknown> | null) ?? null,
        })),
        { stage: stateAfter?.stage ?? null, isFinalized: false },
      ),
      "bag resumable at sealing after partial packaging",
    );

    const [cardAfterPack] = await db
      .select({ status: qrCards.status, assignedWorkflowBagId: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, cardId));
    assert(
      cardAfterPack?.assignedWorkflowBagId === workflowBagId,
      "QR assignment must survive packaging complete",
    );

    // Idempotency: duplicate partial clientEventId must not add another row.
    const countBefore = events.filter((e) => e.eventType === "SEALING_COMPLETE").length;
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: sealingStationId,
        eventType: "SEALING_COMPLETE",
        payload: buildPartialSealingClosePayload({
          sealedPartialCount: 24,
          reason: "END_OF_SHIFT",
        }),
        clientEventId: clientPartial,
      });
    });
    const eventsAfter = await db
      .select({ eventType: workflowEvents.eventType })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, workflowBagId));
    const partialCount = eventsAfter.filter((e) => e.eventType === "SEALING_COMPLETE").length;
    assert(partialCount === countBefore, "duplicate clientEventId must not double partial close");

    console.log("[verify-sealing-partial-closeout] PASS — staging QA OK");
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
    } else if (qaCardToken) {
      await db.delete(qrCards).where(eq(qrCards.scanToken, qaCardToken));
    }
  }
}

async function main(): Promise<void> {
  const stagingOnly =
    process.env.VERIFY_SEALING_PARTIAL_STAGING_ONLY === "true" ||
    process.env.VERIFY_SEALING_PARTIAL_STAGING_ONLY === "1";
  if (!stagingOnly) {
    runStaticContracts();
  }
  await runStagingQa();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
