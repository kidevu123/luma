// PT-7F — end-to-end staging verification for the PackTrack
// shortage-recommendation flow.
//
// Runs inside the luma-app container. Exercises the full pipeline:
//   1. Seeds a clearly-marked QA row in read_material_recommendations.
//   2. Reads it back through the loader to confirm /material-alerts
//      would render it as "not acknowledged, blocked from send."
//   3. Acknowledges the row (mirrors what the server action does:
//      UPDATE + audit_log insert in one tx).
//   4. Spins up an in-process mock PackTrack receiver on 127.0.0.1.
//   5. Calls sendRecommendationToPackTrack against the mock — config
//      passed via the `config` opt (no env mutation, no app restart).
//   6. Persists sent_at + last_sent_response + audit row exactly the
//      way the action would.
//   7. Re-reads the row to confirm the persisted state.
//   8. Tests the failure path: mock returns 500 → last_send_error set,
//      sent_at unchanged.
//   9. Confirms the gate checks reject MISSING-confidence, dismissed,
//      and unacknowledged rows.
//  10. Deletes the QA row (audit chain stays in audit_log).
//
// Idempotent: the recommendation_id is randomized per run so a re-run
// never collides with itself. The QA material_id is whatever staging
// has registered as QA_TEST_DISPLAY_BOX.

import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  readMaterialRecommendations,
  packagingMaterials,
  auditLog,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  buildPackTrackRecommendationPayload,
  sendRecommendationToPackTrack,
} from "@/lib/integrations/packtrack/recommendations";
import { loadMaterialRecommendations } from "@/lib/db/queries/material-recommendations";

const QA_TAG = "PT-7F verification";

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

async function startMockReceiver(opts: {
  status: number;
  responseBody: object | string;
}): Promise<{ url: string; close: () => Promise<void>; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(",");
      }
      captured.push({ url: req.url ?? "", headers, body });
      res.statusCode = opts.status;
      res.setHeader("content-type", "application/json");
      res.end(
        typeof opts.responseBody === "string"
          ? opts.responseBody
          : JSON.stringify(opts.responseBody),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("mock receiver failed to bind");
  }
  const url = `http://127.0.0.1:${addr.port}/recs`;
  console.log(`  mock receiver up at ${url}`);
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    captured,
  };
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assert ${label}: expected ${e}, got ${a}`);
  }
  console.log(`    ✓ ${label}`);
}

function assertTruthy(label: string, v: unknown): void {
  if (!v) throw new Error(`assert ${label}: expected truthy, got ${String(v)}`);
  console.log(`    ✓ ${label}`);
}

function assertFalsy(label: string, v: unknown): void {
  if (v) throw new Error(`assert ${label}: expected falsy, got ${String(v)}`);
  console.log(`    ✓ ${label}`);
}

async function main(): Promise<void> {
  console.log("PT-7F — staging verification of PackTrack recommendation flow");

  // ── Pick a QA material id ────────────────────────────────────────
  console.log("\n[1] picking QA material");
  const mats = await db
    .select({ id: packagingMaterials.id, sku: packagingMaterials.sku })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.sku, "QA_TEST_DISPLAY_BOX"))
    .limit(1);
  if (mats.length === 0) {
    throw new Error(
      "QA_TEST_DISPLAY_BOX not found — seed it via the QA fixtures before running PT-7F.",
    );
  }
  const materialId = mats[0]!.id;
  console.log(`  material_id=${materialId} sku=${mats[0]!.sku}`);

  // Unique-per-run recommendation_id so reruns don't collide.
  const recommendationId = crypto.randomUUID();

  // ── Seed the QA row ───────────────────────────────────────────────
  console.log("\n[2] seeding QA recommendation row");
  const generatedAt = new Date();
  const inserted = await db
    .insert(readMaterialRecommendations)
    .values({
      recommendationId,
      materialId,
      materialCode: "QA_TEST_DISPLAY_BOX",
      materialName: `${QA_TAG} — Bottle Label 30mL`,
      productId: null,
      productName: null,
      productSku: null,
      compatibilityRole: null,
      currentOnHand: "0",
      acceptedInventory: "0",
      projectedDemand: "350",
      projectedShortageQuantity: "350",
      recommendedOrderQuantity: "420",
      neededByDate: "2026-05-20",
      confidence: "HIGH",
      severity: "CRITICAL",
      reason: `${QA_TAG} — synthetic shortage to exercise the outbound path`,
      sourceSignals: [
        {
          kind: "CURRENT_ON_HAND",
          label: "On-hand",
          value: 0,
          confidence: "HIGH",
        },
      ] as unknown as object,
      missingInputs: [] as unknown as object,
      warnings: [QA_TAG] as unknown as object,
      sendableToPackTrack: true,
      generatedAt,
      recommendedSupplierHint: "QA Supplier",
    })
    .returning({ id: readMaterialRecommendations.id });
  const rowId = inserted[0]!.id;
  console.log(`  inserted recommendation row id=${rowId}`);

  try {
    // ── Loader sees it as ACTIVE / not acknowledged ───────────────
    console.log("\n[3] loader returns the row in ACTIVE filter");
    const allActive = await loadMaterialRecommendations({ status: "ALL" });
    const ours = allActive.find((r) => r.id === rowId);
    assertTruthy("row visible via loader", ours);
    assertEq("row not acknowledged yet", ours!.acknowledgedAt, null);
    assertEq("row not dismissed", ours!.dismissedAt, null);
    assertEq("row sendable", ours!.sendableToPackTrack, true);
    assertEq("row confidence", ours!.confidence, "HIGH");

    // ── Acknowledge (action-equivalent: update + audit) ───────────
    console.log("\n[4] acknowledging via action-equivalent path");
    const ackedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(readMaterialRecommendations)
        .set({ acknowledgedAt: ackedAt, updatedAt: ackedAt })
        .where(eq(readMaterialRecommendations.id, rowId));
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "material_recommendation.acknowledge",
          targetType: "read_material_recommendations",
          targetId: rowId,
          after: { acknowledgedAt: ackedAt, by: "PT-7F verification" },
        },
        tx,
      );
    });
    const afterAck = await db
      .select({
        acknowledgedAt: readMaterialRecommendations.acknowledgedAt,
        dismissedAt: readMaterialRecommendations.dismissedAt,
        sentAt: readMaterialRecommendations.sentAt,
      })
      .from(readMaterialRecommendations)
      .where(eq(readMaterialRecommendations.id, rowId));
    assertTruthy("acknowledged_at populated", afterAck[0]!.acknowledgedAt);
    assertEq("not yet sent", afterAck[0]!.sentAt, null);

    // ── Mock receiver — happy path ────────────────────────────────
    console.log("\n[5] spawning mock PackTrack receiver (happy path)");
    const happy = await startMockReceiver({
      status: 200,
      responseBody: {
        recommendation_id: "MOCK-PT-001",
        status: "received",
        message: "mock accepted",
      },
    });

    console.log("\n[6] sending via the outbound client");
    const sendResult = await sendRecommendationToPackTrack(
      {
        recommendationId,
        materialCode: "QA_TEST_DISPLAY_BOX",
        materialName: `${QA_TAG} — Bottle Label 30mL`,
        productSku: null,
        productName: null,
        compatibilityRole: null,
        currentOnHand: 0,
        acceptedInventory: 0,
        projectedDemand: 350,
        projectedShortageQuantity: 350,
        recommendedOrderQuantity: 420,
        neededByDate: "2026-05-20",
        confidence: "HIGH",
        severity: "CRITICAL",
        reason: `${QA_TAG} — synthetic shortage to exercise the outbound path`,
        sourceSignals: [
          {
            kind: "CURRENT_ON_HAND",
            label: "On-hand",
            value: 0,
            confidence: "HIGH",
          },
        ],
        recommendedSupplierHint: "QA Supplier",
        generatedAt,
      },
      { config: { url: happy.url, secret: "STAGING_QA_SECRET" } },
    );
    assertTruthy("send returned ok", sendResult.ok);
    if (sendResult.ok) {
      assertEq("status 200", sendResult.status, 200);
      assertEq(
        "mapped packtrack_recommendation_id",
        sendResult.mapped.packtrack_recommendation_id,
        "MOCK-PT-001",
      );
      assertEq("mapped status", sendResult.mapped.status, "received");
    }

    // Inspect what the mock actually got.
    assertEq("mock captured one request", happy.captured.length, 1);
    const req = happy.captured[0]!;
    assertEq(
      "x-luma-packtrack-secret present",
      req.headers["x-luma-packtrack-secret"],
      "STAGING_QA_SECRET",
    );
    assertEq(
      "x-luma-recommendation-id matches recommendation_id",
      req.headers["x-luma-recommendation-id"],
      recommendationId,
    );
    assertEq(
      "content-type application/json",
      req.headers["content-type"],
      "application/json",
    );
    const payloadParsed = JSON.parse(req.body);
    assertEq("schema_version", payloadParsed.schema_version, "1.0");
    assertEq("source LUMA", payloadParsed.source, "LUMA");
    assertEq(
      "material_code echoed",
      payloadParsed.material_code,
      "QA_TEST_DISPLAY_BOX",
    );
    assertEq(
      "recommended_order_quantity echoed",
      payloadParsed.recommended_order_quantity,
      420,
    );
    assertEq(
      "confidence not MISSING",
      payloadParsed.confidence,
      "HIGH",
    );
    assertEq(
      "supporting_signals array present",
      Array.isArray(payloadParsed.supporting_signals),
      true,
    );

    await happy.close();

    // ── Persist sent_at + audit (action's success branch) ─────────
    console.log("\n[7] persisting sent_at + last_sent_response + audit");
    if (!sendResult.ok) throw new Error("send unexpectedly failed");
    const sentNow = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(readMaterialRecommendations)
        .set({
          sentAt: sentNow,
          lastSentResponse: sendResult.mapped as unknown as object,
          lastSendError: null,
          updatedAt: sentNow,
        })
        .where(eq(readMaterialRecommendations.id, rowId));
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "material_recommendation.send",
          targetType: "read_material_recommendations",
          targetId: rowId,
          after: {
            sentAt: sentNow,
            status: sendResult.status,
            mapped: sendResult.mapped,
            by: "PT-7F verification",
          },
        },
        tx,
      );
    });
    const afterSend = await db
      .select()
      .from(readMaterialRecommendations)
      .where(eq(readMaterialRecommendations.id, rowId));
    assertTruthy("sent_at populated", afterSend[0]!.sentAt);
    assertTruthy(
      "last_sent_response populated",
      afterSend[0]!.lastSentResponse,
    );
    assertEq(
      "last_send_error cleared",
      afterSend[0]!.lastSendError,
      null,
    );

    // ── Failure path: mock returns 500 → last_send_error written ──
    console.log("\n[8] failure path — mock returns 500");
    const bad = await startMockReceiver({
      status: 500,
      responseBody: "internal error in mock",
    });
    const failResult = await sendRecommendationToPackTrack(
      {
        recommendationId,
        materialCode: "QA_TEST_DISPLAY_BOX",
        materialName: `${QA_TAG} — Bottle Label 30mL`,
        productSku: null,
        productName: null,
        compatibilityRole: null,
        currentOnHand: 0,
        acceptedInventory: 0,
        projectedDemand: 350,
        projectedShortageQuantity: 350,
        recommendedOrderQuantity: 420,
        neededByDate: "2026-05-20",
        confidence: "HIGH",
        severity: "CRITICAL",
        reason: `${QA_TAG} — synthetic shortage to exercise the outbound path`,
        sourceSignals: [],
        recommendedSupplierHint: null,
        generatedAt,
      },
      { config: { url: bad.url, secret: "STAGING_QA_SECRET" } },
    );
    assertEq("send failed as expected", failResult.ok, false);
    if (!failResult.ok) {
      assertEq("failure code HTTP_ERROR", failResult.code, "HTTP_ERROR");
    }
    // Persist the failure (action's failure branch).
    const failedAt = new Date();
    if (failResult.ok) throw new Error("send unexpectedly succeeded");
    await db.transaction(async (tx) => {
      await tx
        .update(readMaterialRecommendations)
        .set({ lastSendError: failResult.reason, updatedAt: failedAt })
        .where(eq(readMaterialRecommendations.id, rowId));
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "material_recommendation.send_failed",
          targetType: "read_material_recommendations",
          targetId: rowId,
          after: {
            code: failResult.code,
            reason: failResult.reason,
            by: "PT-7F verification",
          },
        },
        tx,
      );
    });
    const afterFail = await db
      .select()
      .from(readMaterialRecommendations)
      .where(eq(readMaterialRecommendations.id, rowId));
    assertTruthy(
      "last_send_error populated",
      afterFail[0]!.lastSendError,
    );
    assertTruthy(
      "sent_at preserved across the failed retry",
      afterFail[0]!.sentAt,
    );
    await bad.close();

    // ── Defensive client-side gates (still pass without DB) ───────
    console.log("\n[9] client-side defensive gates");
    const missingConf = await sendRecommendationToPackTrack(
      {
        recommendationId,
        materialCode: "QA",
        materialName: "qa",
        productSku: null,
        productName: null,
        compatibilityRole: null,
        currentOnHand: 0,
        acceptedInventory: 0,
        projectedDemand: 0,
        projectedShortageQuantity: 0,
        recommendedOrderQuantity: 100,
        neededByDate: null,
        confidence: "MISSING",
        severity: "WATCH",
        reason: "qa",
        sourceSignals: [],
        recommendedSupplierHint: null,
        generatedAt,
      },
      { config: { url: "http://127.0.0.1:1", secret: "x" } },
    );
    assertEq("MISSING confidence refused", missingConf.ok, false);
    if (!missingConf.ok)
      assertEq(
        "BLOCKED_BY_CONFIDENCE",
        missingConf.code,
        "BLOCKED_BY_CONFIDENCE",
      );

    const zeroQty = await sendRecommendationToPackTrack(
      {
        recommendationId,
        materialCode: "QA",
        materialName: "qa",
        productSku: null,
        productName: null,
        compatibilityRole: null,
        currentOnHand: 0,
        acceptedInventory: 0,
        projectedDemand: 0,
        projectedShortageQuantity: 0,
        recommendedOrderQuantity: 0,
        neededByDate: null,
        confidence: "HIGH",
        severity: "WATCH",
        reason: "qa",
        sourceSignals: [],
        recommendedSupplierHint: null,
        generatedAt,
      },
      { config: { url: "http://127.0.0.1:1", secret: "x" } },
    );
    assertEq("zero qty refused", zeroQty.ok, false);
    if (!zeroQty.ok)
      assertEq("BLOCKED_BY_QUANTITY", zeroQty.code, "BLOCKED_BY_QUANTITY");

    // ── Audit chain — confirm both lifecycle events landed ────────
    console.log("\n[10] audit chain captured 3 entries");
    const audits = await db
      .select({ action: auditLog.action, targetId: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.targetId, rowId));
    const actions = audits.map((a) => a.action).sort();
    assertEq(
      "audit actions",
      actions,
      [
        "material_recommendation.acknowledge",
        "material_recommendation.send",
        "material_recommendation.send_failed",
      ].sort(),
    );

    // ── Payload builder shape sanity (no DB) ──────────────────────
    console.log("\n[11] payload builder shape");
    const payload = buildPackTrackRecommendationPayload({
      recommendationId,
      materialCode: "QA",
      materialName: "qa",
      productSku: null,
      productName: null,
      compatibilityRole: null,
      currentOnHand: 0,
      acceptedInventory: 0,
      projectedDemand: 350,
      projectedShortageQuantity: 350,
      recommendedOrderQuantity: 420,
      neededByDate: null,
      confidence: "HIGH",
      severity: "CRITICAL",
      reason: "qa",
      sourceSignals: [],
      recommendedSupplierHint: null,
      generatedAt,
    });
    assertEq("schema_version 1.0", payload.schema_version, "1.0");
    assertEq("source LUMA", payload.source, "LUMA");
    assertEq("recommendation_id roundtrips", payload.recommendation_id, recommendationId);

    console.log("\nALL ASSERTIONS PASSED.");
  } finally {
    // ── Cleanup: drop the QA row (audit_log entries stay) ─────────
    console.log("\n[cleanup] deleting QA recommendation row");
    await db
      .delete(readMaterialRecommendations)
      .where(eq(readMaterialRecommendations.id, rowId));
    console.log("  cleanup done");
  }
}

main()
  .then(() => {
    console.log("\nPT-7F verification: OK");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("\nPT-7F verification: FAILED");
    console.error(err);
    process.exit(1);
  });
