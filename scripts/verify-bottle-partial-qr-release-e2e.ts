// P2-PARTIAL-KEEP v1.10.1 — staging-only DB E2E for QR release consistency.
//
// Verifies, against a real Postgres, the v1.10.1 contract on the manual
// allocation close/deplete paths:
//   • A kept-partial close (endingBalanceQty > 0) HOLDS the RAW_BAG QR —
//     status stays ASSIGNED and assignedWorkflowBagId is preserved.
//   • A confirmed-empty deplete RELEASES the QR — status IDLE *and*
//     assignedWorkflowBagId is cleared (the v1.10.1 fix).
//   • A variety-run close RELEASES the VARIETY_PACK QR — status IDLE *and*
//     assignedWorkflowBagId is cleared (the v1.11.1 fix).
//
// It exercises the real floor server actions (closeAllocationSessionAction /
// markBagDepletedAction), creates only QA-marked rows, and deletes every one of
// them in a finally block. It REFUSES to run without explicit staging flags and
// never touches production data.
//
//   ALLOW_STAGING_QA_DATA=true LUMA_STAGING_ONLY=true \
//     npx tsx scripts/verify-bottle-partial-qr-release-e2e.ts
//
// On the LXC (staging only):
//   docker compose exec -T -e ALLOW_STAGING_QA_DATA=true -e LUMA_STAGING_ONLY=true \
//     app node_modules/.bin/tsx scripts/verify-bottle-partial-qr-release-e2e.ts
//
// Fuller lifecycle (packaging keep-partial → scan/resume into a DIFFERENT
// bottle product → confirmed empty) is covered at the decision level by
// lib/production/bottle-partial-lifecycle.test.ts; driving it through the floor
// scan/packaging UI actions needs a station scan-token harness and is the
// documented next extension of this script.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const QA_MARKER = "QA-BOTTLE-PARTIAL-QR-RELEASE-1";

function log(msg: string): void {
  console.log(`[verify-bottle-partial-qr-release-e2e] ${msg}`);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-bottle-partial-qr-release-e2e] FAIL: ${msg}`);
    process.exit(1);
  }
}

function refuseUnlessStaging(): void {
  const allow =
    process.env.ALLOW_STAGING_QA_DATA === "true" ||
    process.env.ALLOW_STAGING_QA_DATA === "1";
  const stagingOnly =
    process.env.LUMA_STAGING_ONLY === "true" ||
    process.env.LUMA_STAGING_ONLY === "1";
  if (!allow || !stagingOnly) {
    console.error(
      "[verify-bottle-partial-qr-release-e2e] Refusing: set ALLOW_STAGING_QA_DATA=true and LUMA_STAGING_ONLY=true",
    );
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[verify-bottle-partial-qr-release-e2e] Refusing: NODE_ENV=production — staging only.",
    );
    process.exit(2);
  }
}

type Ids = {
  stationId?: string;
  cardIds: string[];
  workflowBagIds: string[];
  inventoryBagIds: string[];
  sessionIds: string[];
  varietyRunIds: string[];
};

async function main(): Promise<void> {
  refuseUnlessStaging();

  const { db } = await import("@/lib/db");
  const {
    stations,
    qrCards,
    workflowBags,
    inventoryBags,
    rawBagAllocationSessions,
    varietyRuns,
  } = await import("@/lib/db/schema");
  const { closeAllocationSessionAction, markBagDepletedAction } = await import(
    "@/app/(floor)/floor/[token]/bag-allocation-actions"
  );
  const { closeVarietyRunAction } = await import(
    "@/app/(floor)/floor/[token]/variety-run-actions"
  );

  const ids: Ids = {
    cardIds: [],
    workflowBagIds: [],
    inventoryBagIds: [],
    sessionIds: [],
    varietyRunIds: [],
  };
  const token = randomUUID();

  try {
    // ── QA fixtures ──────────────────────────────────────────────
    const [station] = await db
      .insert(stations)
      .values({
        label: `${QA_MARKER} station`,
        kind: "PACKAGING",
        scanToken: token,
        isActive: true,
      })
      .returning({ id: stations.id });
    assert(!!station, "station insert");
    ids.stationId = station!.id;

    // Helper: build one QA partial bag (inventory bag + ASSIGNED RAW_BAG QR
    // pointing at a finalized-ish workflow bag + an OPEN allocation session).
    async function makeQaBag(suffix: string): Promise<{
      sessionId: string;
      cardId: string;
      workflowBagId: string;
    }> {
      const qr = `${QA_MARKER}-${suffix}-${randomUUID().slice(0, 8)}`;
      const [wf] = await db
        .insert(workflowBags)
        .values({ finalizedAt: new Date() })
        .returning({ id: workflowBags.id });
      ids.workflowBagIds.push(wf!.id);
      const [inv] = await db
        .insert(inventoryBags)
        .values({
          internalReceiptNumber: `${QA_MARKER}-${suffix}`,
          bagQrCode: qr,
          status: "IN_USE",
          pillCount: 20000,
          declaredPillCount: 20000,
        })
        .returning({ id: inventoryBags.id });
      ids.inventoryBagIds.push(inv!.id);
      const [card] = await db
        .insert(qrCards)
        .values({
          label: `${QA_MARKER}-${suffix}`,
          scanToken: qr,
          status: "ASSIGNED",
          cardType: "RAW_BAG",
          assignedWorkflowBagId: wf!.id,
        })
        .returning({ id: qrCards.id });
      ids.cardIds.push(card!.id);
      const [session] = await db
        .insert(rawBagAllocationSessions)
        .values({
          inventoryBagId: inv!.id,
          workflowBagId: wf!.id,
          allocationStatus: "OPEN",
          startingBalanceQty: 20000,
          unitOfMeasure: "tablets",
          confidence: "LOW",
        })
        .returning({ id: rawBagAllocationSessions.id });
      ids.sessionIds.push(session!.id);
      return { sessionId: session!.id, cardId: card!.id, workflowBagId: wf!.id };
    }

    // ── Scenario A — kept partial (remaining > 0) HOLDS the QR ────
    const a = await makeQaBag("held");
    const fdHeld = new FormData();
    fdHeld.set("token", token);
    fdHeld.set("stationId", ids.stationId);
    fdHeld.set("sessionId", a.sessionId);
    fdHeld.set("endingBalanceQty", "5000"); // remaining > 0 → AVAILABLE, no release
    const heldRes = await closeAllocationSessionAction(fdHeld);
    assert(!heldRes?.error, `held close errored: ${heldRes?.error}`);
    const [heldCard] = await db
      .select({ status: qrCards.status, assigned: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, a.cardId));
    assert(heldCard?.status === "ASSIGNED", "held QR must stay ASSIGNED");
    assert(
      heldCard?.assigned === a.workflowBagId,
      "held QR must keep assignedWorkflowBagId",
    );
    log("Scenario A OK — kept-partial close held the QR (ASSIGNED, assignment kept).");

    // ── Scenario B — confirmed empty RELEASES + clears assignment ─
    const b = await makeQaBag("empty");
    const fdEmpty = new FormData();
    fdEmpty.set("token", token);
    fdEmpty.set("stationId", ids.stationId);
    fdEmpty.set("sessionId", b.sessionId);
    const emptyRes = await markBagDepletedAction(fdEmpty);
    assert(!emptyRes?.error, `deplete errored: ${emptyRes?.error}`);
    const [emptyCard] = await db
      .select({ status: qrCards.status, assigned: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, b.cardId));
    assert(emptyCard?.status === "IDLE", "depleted QR must be IDLE");
    assert(
      emptyCard?.assigned === null,
      "depleted QR must clear assignedWorkflowBagId (v1.10.1 fix)",
    );
    log("Scenario B OK — confirmed-empty deplete released the QR (IDLE, assignment cleared).");

    // ── Scenario C — variety-run close RELEASES the VARIETY_PACK QR ─
    const varietyToken = `${QA_MARKER}-variety-${randomUUID().slice(0, 8)}`;
    const [vWf] = await db
      .insert(workflowBags)
      .values({ finalizedAt: new Date() })
      .returning({ id: workflowBags.id });
    ids.workflowBagIds.push(vWf!.id);
    const [varietyCard] = await db
      .insert(qrCards)
      .values({
        label: `${QA_MARKER}-variety`,
        scanToken: varietyToken,
        status: "ASSIGNED",
        cardType: "VARIETY_PACK",
        assignedWorkflowBagId: vWf!.id,
      })
      .returning({ id: qrCards.id });
    ids.cardIds.push(varietyCard!.id);
    const [vRun] = await db
      .insert(varietyRuns)
      .values({
        parentScanToken: varietyToken,
        varietyQrCardId: varietyCard!.id,
        status: "OPEN",
      })
      .returning({ id: varietyRuns.id });
    ids.varietyRunIds.push(vRun!.id);

    const fdVariety = new FormData();
    fdVariety.set("token", token);
    fdVariety.set("stationId", ids.stationId);
    fdVariety.set("varietyRunId", vRun!.id);
    const vRes = await closeVarietyRunAction(fdVariety);
    assert(!("error" in vRes), `variety close errored: ${(vRes as { error?: string }).error}`);
    const [vCard] = await db
      .select({ status: qrCards.status, assigned: qrCards.assignedWorkflowBagId })
      .from(qrCards)
      .where(eq(qrCards.id, varietyCard!.id));
    assert(vCard?.status === "IDLE", "released VARIETY_PACK QR must be IDLE");
    assert(
      vCard?.assigned === null,
      "released VARIETY_PACK QR must clear assignedWorkflowBagId (v1.11.1 fix)",
    );
    log("Scenario C OK — variety-run close released the VARIETY_PACK QR (IDLE, assignment cleared).");

    log("PASS — QR release consistency verified.");
  } finally {
    // ── Cleanup — delete every QA-marked row ─────────────────────
    const { db } = await import("@/lib/db");
    const {
      stations,
      qrCards,
      workflowBags,
      inventoryBags,
      rawBagAllocationSessions,
      rawBagAllocationEvents,
      varietyRuns,
    } = await import("@/lib/db/schema");
    if (ids.varietyRunIds.length) {
      await db
        .delete(varietyRuns)
        .where(inArray(varietyRuns.id, ids.varietyRunIds));
    }
    if (ids.sessionIds.length) {
      await db
        .delete(rawBagAllocationEvents)
        .where(inArray(rawBagAllocationEvents.allocationSessionId, ids.sessionIds));
      await db
        .delete(rawBagAllocationSessions)
        .where(inArray(rawBagAllocationSessions.id, ids.sessionIds));
    }
    if (ids.cardIds.length) {
      await db.delete(qrCards).where(inArray(qrCards.id, ids.cardIds));
    }
    if (ids.inventoryBagIds.length) {
      await db
        .delete(inventoryBags)
        .where(inArray(inventoryBags.id, ids.inventoryBagIds));
    }
    if (ids.workflowBagIds.length) {
      await db
        .delete(workflowBags)
        .where(inArray(workflowBags.id, ids.workflowBagIds));
    }
    if (ids.stationId) {
      await db.delete(stations).where(eq(stations.id, ids.stationId));
    }
    log("Cleanup complete — all QA rows removed.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[verify-bottle-partial-qr-release-e2e] ERROR", err);
    process.exit(1);
  });
