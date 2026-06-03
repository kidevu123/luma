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
  const buttons = read("app/(floor)/floor/[token]/stage-action-buttons.tsx");
  const projector = read("lib/projector/index.ts");
  const partial = read("lib/production/sealing-partial-closeout.ts");
  const progression = read("lib/production/stage-progression.ts");

  assert(buttons.includes("Submit whole bag"), "Step 3 UI: Submit whole bag");
  assert(buttons.includes("Submit partial bag"), "Step 3 UI: Submit partial bag");
  assert(!buttons.includes("Confirm sealing complete"), "Step 3 UI: old confirm copy removed");

  assert(actions.includes("sealingCloseMode"), "actions: sealingCloseMode form field");
  assert(actions.includes("validateSealingPartialCloseInput"), "actions: partial validation");
  assert(actions.includes("maybeAutoReleaseAfterPartialSealingClose"), "actions: partial auto-release");
  assert(actions.includes("packagingPartialSealedReady"), "actions: packaging BLISTERED gate");
  assert(buttons.includes("hasPartialSealingCloseout"), "UI: partial close-out prop wired");

  assert(projector.includes("resolveStageForWorkflowEvent"), "projector: stage resolver");
  assert(projector.includes("isPartialSealingClosePayload"), "projector: partial payload guard");

  assert(partial.includes("partial_close: true"), "partial helpers: durable partial_close flag");
  assert(partial.includes("lane_close: false"), "partial helpers: not whole lane close");

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
    buildPartialSealingClosePayload,
    allowsPackagingCompleteAtBlistered,
    isPartialSealingClosePayload,
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
          master_cases: 0,
          displays_made: 1,
          loose_cards: 0,
          damaged_packaging: 0,
          ripped_cards: 0,
          qa: QA_PREFIX,
        },
        clientEventId: randomUUID(),
      });
    });

    const [stateAfter] = await db
      .select({ stage: readBagState.stage })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    assert(stateAfter?.stage === "PACKAGED", `stage after packaging: ${stateAfter?.stage}`);

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
