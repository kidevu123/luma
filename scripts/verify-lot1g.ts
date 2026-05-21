// LOT-1G — end-to-end verification of the Luma → Nexus handoff.
//
// Runs inside the luma-app container. Seeds QA-only customers /
// shipments / finished-lots / shipment-finished-lots / outputs, spins
// up an in-process mock Nexus receiver, calls the payload builder +
// sendFinishedLotToNexus, mimics the action's persistence branch,
// asserts the captured headers + payload + DB writes are correct,
// runs the failure path with a 500 mock, then deletes every QA row
// it created (audit log entries stay as forensic history).
//
// Same shape as scripts/verify-pt7f.ts. No real customer data
// touched. Exits 0 on success.

import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  finishedLotOutputs,
  finishedLots,
  packagingMaterials,
  products,
  shipmentFinishedLots,
  shipments,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  buildNexusFinishedLotPayload,
  isFinishedLotSendableToNexus,
  sendFinishedLotToNexus,
} from "@/lib/integrations/nexus/finished-lots";

const QA_TAG = "LOT-1G verification";

type Captured = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

async function startMockReceiver(opts: {
  status: number;
  responseBody: object | string;
}): Promise<{ url: string; close: () => Promise<void>; captured: Captured[] }> {
  const captured: Captured[] = [];
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
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("mock receiver failed to bind");
  }
  return {
    url: `http://127.0.0.1:${addr.port}/inbox`,
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
  if (a !== e) throw new Error(`assert ${label}: expected ${e}, got ${a}`);
  console.log(`    ✓ ${label}`);
}

function assertTruthy(label: string, v: unknown): void {
  if (!v) throw new Error(`assert ${label}: expected truthy, got ${String(v)}`);
  console.log(`    ✓ ${label}`);
}

async function main(): Promise<void> {
  console.log("LOT-1G — Luma → Nexus handoff end-to-end verification");

  // ── Pick a real product to anchor the finished_lot FK ────────
  const [product] = await db
    .select({ id: products.id, name: products.name, sku: products.sku })
    .from(products)
    .limit(1);
  if (!product) {
    throw new Error("No products seeded on staging — cannot create QA finished lot");
  }
  // packagingMaterials is unused in this run but referenced for
  // future expansion if we need a finished_lot_packaging_lots row.
  void packagingMaterials;

  // ── Seed QA customer ─────────────────────────────────────────
  console.log("\n[1] seeding QA customer");
  const [customer] = await db
    .insert(customers)
    .values({
      customerCode: `LOT1G-QA-${Date.now()}`,
      name: `${QA_TAG} — QA Customer`,
      nexusCustomerId: `nx-qa-${Date.now()}`,
      supplierLotVisible: false,
      active: true,
      notes: QA_TAG,
    })
    .returning();
  if (!customer) throw new Error("customer insert empty");
  console.log(`  customer id=${customer.id} code=${customer.customerCode}`);

  // ── Seed QA shipment ─────────────────────────────────────────
  console.log("\n[2] seeding QA shipment");
  const [shipment] = await db
    .insert(shipments)
    .values({
      poId: null,
      customerId: customer.id,
      carrier: "QA Carrier",
      trackingNumber: `QA-${Date.now()}`,
      shippedAt: new Date(),
    })
    .returning();
  if (!shipment) throw new Error("shipment insert empty");
  console.log(`  shipment id=${shipment.id}`);

  // ── Seed QA finished_lot ─────────────────────────────────────
  console.log("\n[3] seeding QA finished_lot");
  const traceBody = `QA-${Date.now()}`;
  const [lot] = await db
    .insert(finishedLots)
    .values({
      productId: product.id,
      finishedLotNumber: traceBody,
      traceCode: `FL-${traceBody}`,
      producedOn: new Date().toISOString().slice(0, 10),
      expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
      packedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      unitsProduced: 100,
      displaysProduced: 10,
      casesProduced: 1,
      status: "RELEASED",
      notes: QA_TAG,
    })
    .returning();
  if (!lot) throw new Error("finished_lot insert empty");
  console.log(`  lot id=${lot.id} trace_code=${lot.traceCode}`);

  // ── Seed one output row ──────────────────────────────────────
  console.log("\n[4] seeding QA finished_lot_outputs row");
  const [output] = await db
    .insert(finishedLotOutputs)
    .values({
      finishedLotId: lot.id,
      outputType: "MASTER_CASE",
      quantity: 1,
      unit: "each",
      traceCodePrinted: lot.traceCode,
      printPayload: { source: "QA" } as unknown as object,
    })
    .returning();
  if (!output) throw new Error("output insert empty");

  // ── Seed shipment_finished_lots link ─────────────────────────
  console.log("\n[5] seeding QA shipment_finished_lots link");
  const [link] = await db
    .insert(shipmentFinishedLots)
    .values({
      shipmentId: shipment.id,
      finishedLotId: lot.id,
      customerId: customer.id,
      quantity: 1,
      unit: "cases",
      shippedAt: new Date(),
      notes: QA_TAG,
    })
    .returning();
  if (!link) throw new Error("shipment_finished_lots insert empty");
  console.log(`  shipment_finished_lots id=${link.id}`);

  try {
    // ── Sendability gate ──────────────────────────────────────
    console.log("\n[6] sendability gate");
    const gate = isFinishedLotSendableToNexus({
      traceCode: lot.traceCode,
      nexusCustomerId: customer.nexusCustomerId,
      shipmentLinkPresent: true,
      configured: true,
    });
    assertEq("gate sendable=true", gate.sendable, true);
    assertEq("gate reasons empty", gate.reasons, []);

    // ── Build the payload ─────────────────────────────────────
    console.log("\n[7] building Nexus payload");
    const payload = buildNexusFinishedLotPayload({
      finishedLotId: lot.id,
      traceCode: lot.traceCode,
      productName: product.name,
      productSku: product.sku,
      packedAt: lot.packedAt,
      expiresAt: lot.expiresAt,
      outputs: [
        {
          outputType: output.outputType,
          quantity: output.quantity,
          unit: output.unit,
          traceCodePrinted: output.traceCodePrinted,
        },
      ],
      customer: {
        customerCode: customer.customerCode,
        customerName: customer.name,
        nexusCustomerId: customer.nexusCustomerId,
        supplierLotVisible: customer.supplierLotVisible,
      },
      shipment: {
        shipmentId: shipment.id,
        shippedAt: shipment.shippedAt,
        trackingNumber: shipment.trackingNumber,
        carrier: shipment.carrier,
      },
      recallPassport: {
        confidence: "HIGH",
        warnings: [],
        missingLinks: [],
        qcSummary: [],
        supplierLotNumber: "HN-LOT-QA-555",
      },
    });
    assertEq("schema_version 1.0", payload.schema_version, "1.0");
    assertEq("source LUMA", payload.source, "LUMA");
    assertEq("trace_code present", payload.finished_lot.trace_code, lot.traceCode);
    assertEq(
      "supplier_lot hidden (default)",
      payload.recall_passport.supplier_lot_visible,
      false,
    );
    assertTruthy(
      "supplier_lot field omitted (no value when hidden)",
      !("supplier_lot_number" in payload.recall_passport),
    );

    // ── Happy-path send against mock receiver ─────────────────
    console.log("\n[8] mock Nexus receiver (happy path)");
    const happy = await startMockReceiver({
      status: 200,
      responseBody: { status: "received", message: "mock accepted" },
    });
    const sendOk = await sendFinishedLotToNexus(payload, {
      config: { url: happy.url, secret: "QA-NEXUS-SECRET" },
    });
    assertTruthy("send ok", sendOk.ok);
    if (sendOk.ok) {
      assertEq("status 200", sendOk.status, 200);
      assertEq("message", sendOk.message, "mock accepted");
    }
    assertEq("mock captured one request", happy.captured.length, 1);
    const req = happy.captured[0]!;
    assertEq(
      "x-luma-nexus-secret header",
      req.headers["x-luma-nexus-secret"],
      "QA-NEXUS-SECRET",
    );
    assertEq(
      "x-luma-finished-lot-id header",
      req.headers["x-luma-finished-lot-id"],
      lot.id,
    );
    assertEq(
      "x-luma-trace-code header",
      req.headers["x-luma-trace-code"],
      lot.traceCode,
    );
    const parsedBody = JSON.parse(req.body);
    assertEq("body.schema_version", parsedBody.schema_version, "1.0");
    assertEq(
      "body.customer.nexus_customer_id",
      parsedBody.customer.nexus_customer_id,
      customer.nexusCustomerId,
    );
    await happy.close();

    // ── Persist success branch (mirrors the action) ───────────
    console.log("\n[9] persisting success branch (sent_at + response)");
    const sentNow = new Date();
    if (!sendOk.ok) throw new Error("expected ok");
    await db.transaction(async (tx) => {
      await tx
        .update(shipmentFinishedLots)
        .set({
          nexusSentAt: sentNow,
          nexusLastSentResponse:
            (sendOk.rawBody ?? null) as unknown as object,
          nexusLastSendError: null,
          updatedAt: sentNow,
        })
        .where(eq(shipmentFinishedLots.id, link.id));
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "nexus.finished_lot.send",
          targetType: "shipment_finished_lots",
          targetId: link.id,
          after: { sentAt: sentNow, by: QA_TAG, status: sendOk.status },
        },
        tx,
      );
    });
    const [afterOk] = await db
      .select()
      .from(shipmentFinishedLots)
      .where(eq(shipmentFinishedLots.id, link.id));
    assertTruthy("nexus_sent_at populated", afterOk?.nexusSentAt);
    assertTruthy(
      "nexus_last_sent_response populated",
      afterOk?.nexusLastSentResponse,
    );
    assertEq(
      "nexus_last_send_error cleared",
      afterOk?.nexusLastSendError,
      null,
    );

    // ── Failure path: 500 mock; sent_at must survive ──────────
    console.log("\n[10] failure path — mock returns 500");
    const bad = await startMockReceiver({
      status: 500,
      responseBody: "internal nexus error",
    });
    const sendFail = await sendFinishedLotToNexus(payload, {
      config: { url: bad.url, secret: "QA-NEXUS-SECRET" },
    });
    assertEq("send failed", sendFail.ok, false);
    if (!sendFail.ok) {
      assertEq("failure code HTTP_ERROR", sendFail.code, "HTTP_ERROR");
    }
    const failedAt = new Date();
    if (sendFail.ok) throw new Error("expected failure");
    await db.transaction(async (tx) => {
      await tx
        .update(shipmentFinishedLots)
        .set({
          nexusLastSendError: sendFail.reason,
          updatedAt: failedAt,
        })
        .where(eq(shipmentFinishedLots.id, link.id));
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "nexus.finished_lot.send_failed",
          targetType: "shipment_finished_lots",
          targetId: link.id,
          after: {
            reason: sendFail.reason,
            code: sendFail.code,
            by: QA_TAG,
          },
        },
        tx,
      );
    });
    const [afterFail] = await db
      .select()
      .from(shipmentFinishedLots)
      .where(eq(shipmentFinishedLots.id, link.id));
    assertTruthy(
      "nexus_last_send_error populated",
      afterFail?.nexusLastSendError,
    );
    assertTruthy(
      "nexus_sent_at preserved across the failed retry",
      afterFail?.nexusSentAt,
    );
    await bad.close();

    console.log("\nALL ASSERTIONS PASSED.");
  } finally {
    // ── Cleanup ──────────────────────────────────────────────
    console.log("\n[cleanup] deleting QA rows");
    await db
      .delete(shipmentFinishedLots)
      .where(eq(shipmentFinishedLots.id, link.id));
    await db
      .delete(finishedLotOutputs)
      .where(eq(finishedLotOutputs.finishedLotId, lot.id));
    await db.delete(finishedLots).where(eq(finishedLots.id, lot.id));
    await db.delete(shipments).where(eq(shipments.id, shipment.id));
    await db.delete(customers).where(eq(customers.id, customer.id));
    console.log("  cleanup done");
  }
}

main()
  .then(() => {
    console.log("\nLOT-1G verification: OK");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("\nLOT-1G verification: FAILED");
    console.error(err);
    process.exit(1);
  });
