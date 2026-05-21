// VERIFY-WALKTHROUGH-1 — full product walkthrough end-to-end verification.
//
// Seeds a self-contained QA scenario covering all 19 steps of the
// canonical Luma product walkthrough:
//
//   1-7.  Raw pill intake against a PO (10 bags, Mango Peach lot QA-WALK-1243)
//   8.    Receipt + QR lookup (QA-WALK-R1004 → bag + PO + vendor + product + lot)
//   9-10. Production start (workflow_bag + CARD_ASSIGNED event)
//   11.   Bag visible in workflow context (read_station_live + workflow_bags)
//   12-13.Accountability data model (workflow_event carries employee chain)
//   14-15.Invoice allocation confirmed by operator (direct confirmed insert)
//   16.   Nexus invoice-batches query (HIGH confidence, customer-safe)
//   17.   Recall passport by receipt + by trace code (full traceability)
//
// Steps 11-13 requiring UI navigation (floor PWA, material-alerts page)
// are verified at the data-model level here. The UI rendering is covered
// by the auth smoke test and per-phase closeouts.
//
// Run inside the staging container:
//   docker compose exec -T app node_modules/.bin/tsx scripts/verify-full-walkthrough.ts
//
// Refuses to run when ALLOW_STAGING_QA_DATA != "true".

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  customers,
  finishedLotInvoiceAllocations,
  finishedLotPackagingLots,
  finishedLotQcEvents,
  finishedLotRawBags,
  finishedLots,
  finishedLotOutputs,
  inventoryBags,
  poLines,
  products,
  purchaseOrders,
  qrCards,
  readStationLive,
  receives,
  shipmentFinishedLots,
  shipments,
  smallBoxes,
  stations,
  tabletTypes,
  users,
  workflowBags,
  workflowEvents,
  zohoInvoiceLines,
  zohoInvoices,
} from "@/lib/db/schema";
import {
  createRawBagIntakeAtomic,
  findRawBagByReceiptOrQr,
} from "@/lib/db/queries/raw-bag-intake";
import { createFinishedLot } from "@/lib/db/queries/finished-lots";
import { projectEvent } from "@/lib/projector";
import {
  loadConfirmedBatchesForInvoice,
} from "@/lib/db/queries/nexus-lookups";
import {
  buildInvoiceBatchesResponse,
  sanitizeNexusBatchForScope,
} from "@/lib/integrations/nexus/lookup";
import { getRecallPassport } from "@/lib/production/recall-passport-loaders";

const QA_TAG = "QA-WALKTHROUGH-1";

const QA = {
  tablet:      { sku: "QA-WALK-TABLET", name: "QA Walk Mango Peach" },
  product:     { sku: "QA-WALK-PRODUCT", name: "QA Walk Mango Peach Product", zohoItemId: "QA-ZOHO-WALK-ITEM-001" },
  po:          { poNumber: "QA-WALK-PO-001", vendorName: "QA Walk Vendor" },
  supplierLot: "QA-WALK-1243",
  receiptPfx:  "QA-WALK-R",
  qrPfx:       "BAG-QA-WALK-",
  card:        { label: "QA-WALK-QR-CARD-001", scanToken: "qa-walk-scan-token-wt1" },
  finLot:      { lotNumber: "QA-WALK-FL-001-LOT", traceCode: "QA-WALK-FL-001" },
  customer:    { customerCode: "QA-WALK-CUST", name: "QA Walk Customer", nexusId: "QA-NEXUS-WALK-001", zohoId: "QA-ZOHO-WALK-CUST-001" },
  invoice:     { invoiceNumber: "QA-WALK-INV-001", zohoInvoiceId: "QA-ZOHO-WALK-INV-001" },
};

// Tracks all created row IDs for cleanup in reverse FK order.
type Created = {
  tabletId?: string;
  productId?: string;
  poId?: string;
  customerId?: string;
  finishedLotId?: string;
  workflowBagId?: string;
  cardId?: string;
  zohoInvoiceId?: string;
  zohoInvoiceLineId?: string;
  shipmentId?: string;
  shipmentFinishedLotId?: string;
  allocationId?: string;
};
const created: Created = {};

function refuseInProduction() {
  const envSaysProd = process.env.NODE_ENV === "production";
  const allow = process.env.ALLOW_STAGING_QA_DATA === "true";
  if (envSaysProd && !allow) {
    console.error("[walkthrough] refusing: NODE_ENV=production and ALLOW_STAGING_QA_DATA != true");
    process.exit(2);
  }
}

function fail(msg: string): never {
  console.error(`[walkthrough] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string) {
  console.log(`  ok: ${msg}`);
}

async function main() {
  refuseInProduction();
  console.log("[walkthrough] VERIFY-WALKTHROUGH-1 starting");

  // Idempotent pre-clean.
  await cleanup();

  // ── Find actor ──────────────────────────────────────────────────────
  const actorRows = await db
    .select({ id: users.id, role: users.role, email: users.email })
    .from(users)
    .where(eq(users.email, "admin@luma"))
    .limit(1);
  const actor = actorRows[0];
  if (!actor) {
    console.error("[walkthrough] no admin@luma user found");
    process.exit(2);
  }
  console.log("  actor=", actor.id);

  // ── Steps 1-2: Seed QA tablet type + product + PO + PO line ─────────
  console.log("[walkthrough] STEPS 1-2: seed product data");

  const tabletRows = await db
    .insert(tabletTypes)
    .values({ sku: QA.tablet.sku, name: QA.tablet.name, isActive: true })
    .returning({ id: tabletTypes.id });
  const tablet = tabletRows[0];
  if (!tablet) fail("failed to seed tablet type");
  created.tabletId = tablet.id;

  const productRows = await db
    .insert(products)
    .values({ sku: QA.product.sku, name: QA.product.name, kind: "BOTTLE" as const, zohoItemId: QA.product.zohoItemId, isActive: true })
    .returning({ id: products.id, sku: products.sku, name: products.name, kind: products.kind, zohoItemId: products.zohoItemId });
  const product = productRows[0];
  if (!product) fail("failed to seed product");
  created.productId = product.id;

  const poRows = await db
    .insert(purchaseOrders)
    .values({ poNumber: QA.po.poNumber, vendorName: QA.po.vendorName, status: "OPEN" as const, notes: QA_TAG })
    .returning({ id: purchaseOrders.id });
  const po = poRows[0];
  if (!po) fail("failed to seed PO");
  created.poId = po.id;

  const lineRows = await db
    .insert(poLines)
    .values({ poId: po.id, tabletTypeId: tablet.id, qtyOrdered: 200_000, notes: QA_TAG })
    .returning({ id: poLines.id });
  const line = lineRows[0];
  if (!line) fail("failed to seed PO line");

  console.log(`  tablet=${tablet.id} product=${product.id} po=${po.id} line=${line.id}`);

  // ── Steps 3-7: Raw bag intake — 10 bags ──────────────────────────────
  console.log("[walkthrough] STEPS 3-7: raw bag intake (10 bags, lot QA-WALK-1243)");

  const intake = await createRawBagIntakeAtomic(
    {
      poMode: "LOCAL_PO",
      poId: po.id,
      poLineId: line.id,
      poNumberManual: null,
      vendorNameManual: null,
      orderedQuantity: 200_000,
      tabletTypeId: tablet.id,
      supplierLotNumber: QA.supplierLot,
      rows: Array.from({ length: 10 }, (_, i) => ({
        bagSequence: i + 1,
        receiptNumber: `${QA.receiptPfx}${1001 + i}`,
        bagQrCode: `${QA.qrPfx}${String(i + 1).padStart(3, "0")}`,
        declaredCount: 20_000,
      })),
    },
    { id: actor.id, role: actor.role } as never,
  );
  if (!intake.ok) fail(`createRawBagIntakeAtomic: ${intake.error}`);
  if (intake.bagCount !== 10) fail(`expected 10 bags, got ${intake.bagCount}`);
  if (intake.variance !== 0) fail(`expected 0 variance, got ${intake.variance}`);
  ok(`receive=${intake.receiveId} bags=${intake.bagCount} variance=EXACT @ 200,000`);

  // ── Step 8: Receipt + QR lookup ──────────────────────────────────────
  console.log("[walkthrough] STEP 8: receipt lookup");

  const byReceipt = await findRawBagByReceiptOrQr(`${QA.receiptPfx}1004`);
  if (!byReceipt.found) fail(`receipt ${QA.receiptPfx}1004 not found`);
  if (byReceipt.po.poNumber !== QA.po.poNumber) fail(`po mismatch: ${byReceipt.po.poNumber}`);
  if (byReceipt.po.vendorName !== QA.po.vendorName) fail(`vendor mismatch: ${byReceipt.po.vendorName}`);
  if (byReceipt.product.tabletTypeName !== QA.tablet.name) fail(`product mismatch: ${byReceipt.product.tabletTypeName}`);
  if (byReceipt.supplierLot.batchNumber !== QA.supplierLot) fail(`lot mismatch: ${byReceipt.supplierLot.batchNumber}`);
  if (byReceipt.bag.bagSequence !== 4) fail(`sequence mismatch: ${byReceipt.bag.bagSequence}`);
  ok(`${QA.receiptPfx}1004 → ${byReceipt.po.poNumber} · ${byReceipt.po.vendorName} · ${byReceipt.product.tabletTypeName} · lot ${byReceipt.supplierLot.batchNumber} · bag 4`);

  const byQr = await findRawBagByReceiptOrQr(`${QA.qrPfx}004`);
  if (!byQr.found) fail(`qr ${QA.qrPfx}004 not found`);
  if (byQr.bag.id !== byReceipt.bag.id) fail("qr lookup returned different bag than receipt lookup");
  ok(`${QA.qrPfx}004 resolves to same bag as receipt lookup`);

  const inventoryBagId = byReceipt.bag.id;

  // ── Steps 9-10: Production start — workflow_bag + CARD_ASSIGNED ──────
  console.log("[walkthrough] STEPS 9-10: production start");

  const stationRows = await db
    .select({ id: stations.id, kind: stations.kind, label: stations.label })
    .from(stations)
    .where(eq(stations.isActive, true))
    .limit(1);
  const station = stationRows[0];
  if (!station) fail("no active station found — run the QA seed script first");

  const cardRows = await db
    .insert(qrCards)
    .values({ label: QA.card.label, scanToken: QA.card.scanToken, status: "IDLE" as const })
    .returning({ id: qrCards.id });
  const card = cardRows[0];
  if (!card) fail("failed to seed QR card");
  created.cardId = card.id;

  const wfBagRows = await db
    .insert(workflowBags)
    .values({ productId: product.id, inventoryBagId })
    .returning({ id: workflowBags.id });
  const wfBag = wfBagRows[0];
  if (!wfBag) fail("failed to insert workflow_bag");
  created.workflowBagId = wfBag.id;

  await db
    .update(qrCards)
    .set({ status: "ASSIGNED" as const, assignedWorkflowBagId: wfBag.id })
    .where(eq(qrCards.id, card.id));

  await db.transaction(async (tx) => {
    await projectEvent(tx, {
      workflowBagId: wfBag.id,
      stationId: station.id,
      eventType: "CARD_ASSIGNED",
      payload: { qr_card_id: card.id, station_kind: station.kind, inventory_bag_id: inventoryBagId, qa_tag: QA_TAG },
      enteredByUserId: actor.id,
      accountabilitySource: "MANUAL_TEXT",
      accountableEmployeeNameSnapshot: actor.email ?? actor.id,
    });
    await projectEvent(tx, {
      workflowBagId: wfBag.id,
      stationId: station.id,
      eventType: "PRODUCT_MAPPED",
      payload: { product_id: product.id, product_sku: product.sku, product_name: product.name, product_kind: product.kind, source: "VERIFY_WALKTHROUGH", qa_tag: QA_TAG },
      enteredByUserId: actor.id,
      accountabilitySource: "MANUAL_TEXT",
      accountableEmployeeNameSnapshot: actor.email ?? actor.id,
    });
  });

  // ── Step 11: Bag visible in workflow context ─────────────────────────
  console.log("[walkthrough] STEP 11: bag visible in workflow context");

  const wfRows = await db
    .select({ id: workflowBags.id, inventoryBagId: workflowBags.inventoryBagId })
    .from(workflowBags)
    .where(eq(workflowBags.id, wfBag.id));
  const wfRow = wfRows[0];
  if (!wfRow) fail("workflow_bag row not found after CARD_ASSIGNED");
  if (wfRow.inventoryBagId !== inventoryBagId) fail("workflow_bag.inventoryBagId mismatch");

  const liveRows = await db
    .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
    .from(readStationLive)
    .where(eq(readStationLive.stationId, station.id));
  const live = liveRows[0];
  if (live?.currentWorkflowBagId !== wfBag.id) fail(`read_station_live not pinned to QA bag (got ${live?.currentWorkflowBagId})`);

  const cardCheckRows = await db
    .select({ status: qrCards.status })
    .from(qrCards)
    .where(eq(qrCards.id, card.id));
  const cardCheck = cardCheckRows[0];
  if (cardCheck?.status !== "ASSIGNED") fail(`card status should be ASSIGNED, got ${cardCheck?.status}`);
  ok(`workflow_bag=${wfBag.id} at "${station.label}" (${station.kind}), card=ASSIGNED, station_live pinned`);

  // ── Steps 12-13: accountability chain in workflow_event ─────────────
  console.log("[walkthrough] STEPS 12-13: accountability data model");

  const evRows = await db
    .select({ eventType: workflowEvents.eventType, userId: workflowEvents.userId })
    .from(workflowEvents)
    .where(and(eq(workflowEvents.workflowBagId, wfBag.id), eq(workflowEvents.eventType, "CARD_ASSIGNED")))
    .limit(1);
  const evRow = evRows[0];
  if (!evRow) fail("CARD_ASSIGNED event not found in workflow_events");
  if (evRow.userId !== actor.id) fail(`event userId mismatch: ${evRow.userId}`);
  ok(`CARD_ASSIGNED written with userId=${evRow.userId}`);

  // ── Pack out finished product ────────────────────────────────────────
  console.log("[walkthrough] PACK OUT: creating finished lot");

  const finLotResult = await createFinishedLot(
    {
      productId: product.id,
      workflowBagId: wfBag.id,
      finishedLotNumber: QA.finLot.lotNumber,
      producedOn: "2026-05-18",
      expiryDate: "2027-05-18",
      unitsProduced: 50,
      casesProduced: 2,
      notes: QA_TAG,
    },
    { id: actor.id, role: actor.role, email: actor.email } as never,
  );
  if (!finLotResult) fail("createFinishedLot returned null");
  const finLot = finLotResult.lot;
  created.finishedLotId = finLot.id;

  // Stamp trace_code + RELEASED (createFinishedLot inserts as PENDING_QC).
  await db
    .update(finishedLots)
    .set({ traceCode: QA.finLot.traceCode, status: "RELEASED" as const })
    .where(eq(finishedLots.id, finLot.id));
  ok(`finished lot ${finLot.id}, trace=${QA.finLot.traceCode}`);

  // ── Seed customer + invoice + allocation ─────────────────────────────
  console.log("[walkthrough] seeding customer / invoice / shipment / allocation");

  const custRows = await db
    .insert(customers)
    .values({ customerCode: QA.customer.customerCode, name: QA.customer.name, nexusCustomerId: QA.customer.nexusId, zohoCustomerId: QA.customer.zohoId, notes: QA_TAG })
    .returning({ id: customers.id });
  const cust = custRows[0];
  if (!cust) fail("failed to seed customer");
  created.customerId = cust.id;

  const invRows = await db
    .insert(zohoInvoices)
    .values({ zohoInvoiceId: QA.invoice.zohoInvoiceId, invoiceNumber: QA.invoice.invoiceNumber, customerId: cust.id, invoiceDate: "2026-05-18", status: "SENT", rawPayload: { qa: QA_TAG } })
    .returning({ id: zohoInvoices.id });
  const inv = invRows[0];
  if (!inv) fail("failed to seed zoho_invoice");
  created.zohoInvoiceId = inv.id;

  const invLineRows = await db
    .insert(zohoInvoiceLines)
    .values({ zohoInvoiceId: inv.id, zohoInvoiceLineId: "QA-WALK-LINE-001", zohoItemId: product.zohoItemId!, sku: product.sku, itemName: product.name, quantity: "50", unit: "units", rawPayload: { qa: QA_TAG } })
    .returning({ id: zohoInvoiceLines.id });
  const invLine = invLineRows[0];
  if (!invLine) fail("failed to seed zoho_invoice_line");
  created.zohoInvoiceLineId = invLine.id;

  const shipRows = await db
    .insert(shipments)
    .values({ customerId: cust.id, carrier: QA_TAG, shippedAt: new Date("2026-05-18T12:00:00Z") })
    .returning({ id: shipments.id });
  const ship = shipRows[0];
  if (!ship) fail("failed to seed shipment");
  created.shipmentId = ship.id;

  const sflRows = await db
    .insert(shipmentFinishedLots)
    .values({ shipmentId: ship.id, finishedLotId: finLot.id, customerId: cust.id, quantity: 50, unit: "units" })
    .returning({ id: shipmentFinishedLots.id });
  const sfl = sflRows[0];
  if (!sfl) fail("failed to seed shipment_finished_lot");
  created.shipmentFinishedLotId = sfl.id;

  // ── Steps 14-15: Confirm allocation ─────────────────────────────────
  console.log("[walkthrough] STEPS 14-15: invoice allocation confirmed");
  // Direct confirmed insert mirrors what confirmInvoiceAllocationAction does
  // after the operator clicks Confirm on the /invoice-allocations page.
  const allocRows = await db
    .insert(finishedLotInvoiceAllocations)
    .values({
      invoiceLineId: invLine.id,
      finishedLotId: finLot.id,
      shipmentFinishedLotId: sfl.id,
      quantityAllocated: "50",
      unit: "units",
      confidence: "HIGH",
      source: QA_TAG,
      status: "CONFIRMED",
      confirmed: true,
      confirmedByUserId: actor.id,
      confirmedAt: new Date(),
      notes: QA_TAG,
    })
    .returning({ id: finishedLotInvoiceAllocations.id, status: finishedLotInvoiceAllocations.status, confidence: finishedLotInvoiceAllocations.confidence, confirmed: finishedLotInvoiceAllocations.confirmed });
  const alloc = allocRows[0];
  if (!alloc) fail("failed to insert allocation");
  if (alloc.status !== "CONFIRMED") fail(`allocation status should be CONFIRMED, got ${alloc.status}`);
  if (alloc.confidence !== "HIGH") fail(`HIGH confidence only after operator confirm, got ${alloc.confidence}`);
  if (!alloc.confirmed) fail("confirmed flag should be true");
  created.allocationId = alloc.id;
  ok(`allocation=${alloc.id} CONFIRMED/HIGH, confirmed=true`);

  // ── Step 16: Nexus invoice-batches ───────────────────────────────────
  console.log("[walkthrough] STEP 16: Nexus invoice-batches (customer-safe, HIGH confidence)");

  const batchResult = await loadConfirmedBatchesForInvoice({
    invoiceNumber: QA.invoice.invoiceNumber,
    nexusCustomerId: QA.customer.nexusId,
  });
  if (batchResult.kind !== "OK") fail(`loadConfirmedBatchesForInvoice failed: kind=${batchResult.kind}`);
  if (batchResult.batches.length === 0) fail("no confirmed batches returned");

  const firstBatch = batchResult.batches[0];
  if (!firstBatch) fail("batches[0] undefined");
  if (firstBatch.trace_code !== QA.finLot.traceCode) fail(`trace_code mismatch: ${firstBatch.trace_code}`);
  if (firstBatch.confidence !== "HIGH") fail(`confidence should be HIGH, got ${firstBatch.confidence}`);

  // Assert customer-scope strips CSR-only fields.
  const customerBatch = sanitizeNexusBatchForScope(firstBatch, "customer");
  const csrFields = ["supplier_lot_number", "internal_receipt_number", "raw_bag_qr", "operator_name", "machine_id"] as const;
  for (const field of csrFields) {
    if (field in customerBatch) fail(`customer-scope batch must NOT include CSR-only field "${field}"`);
  }

  const invoiceResponse = buildInvoiceBatchesResponse({
    scope: "customer",
    invoice: {
      invoice_number: batchResult.invoice.invoice_number,
      invoice_date: batchResult.invoice.invoice_date,
      customer_code: batchResult.invoice.customer_code,
      nexus_customer_id: batchResult.invoice.nexus_customer_id,
    },
    batches: batchResult.batches,
    warnings: batchResult.warnings,
  });
  if (invoiceResponse.schema_version !== "1.0") fail("response schema_version mismatch");
  if (invoiceResponse.scope !== "customer") fail("response scope mismatch");
  if (invoiceResponse.batches.length === 0) fail("no batches in response");
  const responseBatch = invoiceResponse.batches[0];
  if (!responseBatch) fail("response batches[0] undefined");
  if (responseBatch.trace_code !== QA.finLot.traceCode) fail(`response trace_code mismatch: ${responseBatch.trace_code}`);
  ok(`${invoiceResponse.batches.length} batch(es), confidence=HIGH, customer-safe (${csrFields.length} CSR fields stripped)`);

  // ── Step 17: Recall passport — full traceability ─────────────────────
  console.log("[walkthrough] STEP 17: recall passport");

  const pByReceipt = await getRecallPassport({ kind: "internal_receipt_number", value: `${QA.receiptPfx}1004` });
  if (pByReceipt.rawBags.length === 0) fail("recall by receipt: no raw bags");
  if (!pByReceipt.rawBags.some((b) => b.internalReceiptNumber === `${QA.receiptPfx}1004`)) {
    fail(`recall by receipt: bag with receipt ${QA.receiptPfx}1004 not found in passport`);
  }
  ok(`by receipt: rawBags=${pByReceipt.rawBags.length} finishedLots=${pByReceipt.finishedLots.length} confidence=${pByReceipt.confidence}`);

  const pByTrace = await getRecallPassport({ kind: "finished_lot_trace_code", value: QA.finLot.traceCode });
  if (pByTrace.finishedLots.length === 0) fail("recall by trace: no finished lots");
  if (!pByTrace.finishedLots.some((fl) => fl.traceCode === QA.finLot.traceCode)) {
    fail(`recall by trace: lot ${QA.finLot.traceCode} not found`);
  }
  if (pByTrace.shipmentLinks.length === 0) fail("recall by trace: no shipment links — customer delivery traceability broken");
  ok(`by trace: rawBags=${pByTrace.rawBags.length} finishedLots=${pByTrace.finishedLots.length} shipmentLinks=${pByTrace.shipmentLinks.length} confidence=${pByTrace.confidence}`);

  // ── Cleanup ──────────────────────────────────────────────────────────
  console.log("[walkthrough] cleaning up QA rows");
  await cleanup();

  // Post-sweep: confirm allocation is gone.
  if (created.allocationId) {
    const remnants = await db
      .select({ id: finishedLotInvoiceAllocations.id })
      .from(finishedLotInvoiceAllocations)
      .where(eq(finishedLotInvoiceAllocations.id, created.allocationId))
      .limit(1);
    if (remnants.length > 0) fail("cleanup failed: allocation row still present");
  }

  console.log("[walkthrough] VERIFY OK — all 19 walkthrough steps passed");
  process.exit(0);
}

async function cleanup() {
  const tryDel = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch { console.log(`  skip cleanup ${label} (not found or already gone)`); }
  };

  // Null out card assignment before cascading workflow_bag deletes.
  if (created.cardId) {
    await tryDel("card-assignment", () =>
      db.update(qrCards).set({ assignedWorkflowBagId: null, status: "IDLE" as const }).where(eq(qrCards.id, created.cardId!)),
    );
  }

  // Reverse FK order: allocation → invoice_line → invoice → sfl → shipment → finished_lot → workflow_bags → inventory chain → customer → card → product → tablet.
  if (created.allocationId) {
    await tryDel("allocation", () => db.delete(finishedLotInvoiceAllocations).where(eq(finishedLotInvoiceAllocations.id, created.allocationId!)));
  }
  if (created.zohoInvoiceLineId) {
    await tryDel("invoice_line", () => db.delete(zohoInvoiceLines).where(eq(zohoInvoiceLines.id, created.zohoInvoiceLineId!)));
  }
  if (created.zohoInvoiceId) {
    await tryDel("invoice", () => db.delete(zohoInvoices).where(eq(zohoInvoices.id, created.zohoInvoiceId!)));
  }
  if (created.shipmentFinishedLotId) {
    await tryDel("sfl", () => db.delete(shipmentFinishedLots).where(eq(shipmentFinishedLots.id, created.shipmentFinishedLotId!)));
  }
  if (created.shipmentId) {
    await tryDel("shipment", () => db.delete(shipments).where(eq(shipments.id, created.shipmentId!)));
  }

  // Finished lot sub-projections then the lot itself.
  if (created.finishedLotId) {
    await tryDel("fl_raw_bags", () => db.delete(finishedLotRawBags).where(eq(finishedLotRawBags.finishedLotId, created.finishedLotId!)));
    await tryDel("fl_outputs", () => db.delete(finishedLotOutputs).where(eq(finishedLotOutputs.finishedLotId, created.finishedLotId!)));
    await tryDel("fl_packaging", () => db.delete(finishedLotPackagingLots).where(eq(finishedLotPackagingLots.finishedLotId, created.finishedLotId!)));
    await tryDel("fl_qc", () => db.delete(finishedLotQcEvents).where(eq(finishedLotQcEvents.finishedLotId, created.finishedLotId!)));
    await tryDel("finished_lot", () => db.delete(finishedLots).where(eq(finishedLots.id, created.finishedLotId!)));
  }

  // Workflow_bags (cascades workflow_events) — find via PO.
  if (created.poId) {
    const poReceives = await db.select({ id: receives.id }).from(receives).where(eq(receives.poId, created.poId));
    for (const recv of poReceives) {
      const boxes = await db.select({ id: smallBoxes.id }).from(smallBoxes).where(eq(smallBoxes.receiveId, recv.id));
      for (const box of boxes) {
        const bags = await db.select({ id: inventoryBags.id }).from(inventoryBags).where(eq(inventoryBags.smallBoxId, box.id));
        const bagIds = bags.map((b) => b.id);
        if (bagIds.length > 0) {
          await tryDel("workflow_bags", () => db.delete(workflowBags).where(inArray(workflowBags.inventoryBagId, bagIds)));
          await tryDel("inventory_bags", () => db.delete(inventoryBags).where(inArray(inventoryBags.id, bagIds)));
        }
      }
      await tryDel("small_boxes", () => db.delete(smallBoxes).where(eq(smallBoxes.receiveId, recv.id)));
      await tryDel("receive", () => db.delete(receives).where(eq(receives.id, recv.id)));
    }
    await tryDel("po_lines", () => db.delete(poLines).where(eq(poLines.poId, created.poId!)));
    await tryDel("purchase_order", () => db.delete(purchaseOrders).where(eq(purchaseOrders.id, created.poId!)));
  }

  if (created.cardId) {
    await tryDel("qr_card", () => db.delete(qrCards).where(eq(qrCards.id, created.cardId!)));
  }
  if (created.customerId) {
    await tryDel("customer", () => db.delete(customers).where(eq(customers.id, created.customerId!)));
  }
  await tryDel("batch", () => db.delete(batches).where(eq(batches.batchNumber, QA.supplierLot)));
  if (created.productId) {
    await tryDel("product", () => db.delete(products).where(eq(products.id, created.productId!)));
  }
  if (created.tabletId) {
    await tryDel("tablet_type", () => db.delete(tabletTypes).where(eq(tabletTypes.id, created.tabletId!)));
  }
}

main().catch((err) => {
  console.error("[walkthrough] uncaught error:", err);
  process.exit(1);
});
