// COMMERCIAL-TRACE-7 — mock end-to-end commercial-trace verification.
//
// Seeds a clearly-marked QA fixture (customer, product, finished lot,
// shipment, invoice, invoice line, confirmed allocation), composes
// each Nexus endpoint's behavior by calling the same helpers + DB
// loaders the route handlers use (authenticateNexusLookupRequest,
// resolveNexusLookupScope, loadConfirmedBatchesForInvoice, etc.),
// asserts the documented contract (customer scope strips CSR-only
// fields, CSR scope keeps them, 422 on cross-customer mismatch, 401
// on bad token, 200 with HIGH confidence on the happy path), then
// cleans up every QA row it created in reverse dependency order.
//
// Direct-helper composition (rather than dynamic-importing route
// modules) is necessary because the Next.js standalone runtime image
// keeps only the compiled .next output, not the app/ source tree.
// The unit tests in lib/integrations/nexus/lookup.test.ts cover the
// route-file boilerplate (URL parsing, 405 method guards) — this
// harness covers the live data path against real Postgres.
//
// Run:
//   docker compose exec -T app node_modules/.bin/tsx scripts/verify-commercial-trace.ts
//
// Refuses to run when ALLOW_STAGING_QA_DATA != "true" so it never
// fires inside a production deploy.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  finishedLotInvoiceAllocations,
  finishedLots,
  products,
  shipmentFinishedLots,
  shipments,
  zohoInvoiceLines,
  zohoInvoices,
} from "@/lib/db/schema";
import {
  authenticateNexusLookupRequest,
  buildBatchPassportResponse,
  buildCustomerBatchesResponse,
  buildInvoiceBatchesResponse,
  resolveNexusLookupScope,
  type NexusLookupScope,
  type NexusPassportRow,
} from "@/lib/integrations/nexus/lookup";
import {
  loadBatchPassportForNexus,
  loadConfirmedBatchesForCustomer,
  loadConfirmedBatchesForInvoice,
} from "@/lib/db/queries/nexus-lookups";

// QA-prefixed marker. Every row created here carries this string in a
// stable column so cleanup is unambiguous and a manual sweep can
// always find leftovers.
const QA_TAG = "QA-COMMERCIAL-TRACE-7";

const QA_FIXTURE = {
  customer: {
    customerCode: "QA-COMMERCIAL-CUSTOMER",
    name: "QA Commercial Trace Customer",
    nexusCustomerId: "QA-NEXUS-CUSTOMER-001",
    zohoCustomerId: "QA-ZOHO-CUSTOMER-001",
  },
  product: {
    sku: "QA-MANGO-PEACH",
    name: "QA Mango Peach",
    zohoItemId: "QA-ZOHO-ITEM-MANGO",
    kind: "BOTTLE" as const,
  },
  finishedLot: {
    finishedLotNumber: "QA-FL-MANGO-001-LOT",
    traceCode: "QA-FL-MANGO-001",
    producedOn: "2026-05-01",
    expiryDate: "2027-05-01",
    unitsProduced: 100,
    packedAt: new Date("2026-05-10T12:00:00Z"),
  },
  shipment: {
    carrier: "QA Carrier",
    trackingNumber: "QA-TRACKING-001",
    shippedAt: new Date("2026-05-15T12:00:00Z"),
  },
  shipmentFinishedLot: {
    quantity: 10,
    unit: "cases",
    shippedAt: new Date("2026-05-15T12:00:00Z"),
  },
  invoice: {
    zohoInvoiceId: "QA-ZOHO-INVOICE-001",
    invoiceNumber: "QA-INV-001",
    zohoCustomerId: "QA-ZOHO-CUSTOMER-001",
    invoiceDate: "2026-05-12",
    status: "sent",
    currency: "USD",
  },
  invoiceLine: {
    zohoInvoiceLineId: "QA-ZOHO-INVOICE-LINE-001",
    zohoItemId: "QA-ZOHO-ITEM-MANGO",
    sku: "QA-MANGO-PEACH",
    itemName: "QA Mango Peach",
    quantity: "10",
    unit: "cases",
  },
  allocation: {
    quantityAllocated: "10",
    unit: "cases",
    confidence: "HIGH" as const,
    source: "QA_COMMERCIAL_TRACE_7",
    status: "CONFIRMED" as const,
    confirmed: true,
    notes: `Seeded by ${QA_TAG}.`,
  },
  tokens: {
    customer: "qa-customer-token-COMMERCIAL-TRACE-7-aaaa",
    csr: "qa-csr-token-COMMERCIAL-TRACE-7-bbbb",
  },
};

// IDs we create — populated as we go; cleanup walks the list in
// reverse.
type Created = {
  customerId: string | null;
  productId: string | null;
  finishedLotId: string | null;
  shipmentId: string | null;
  shipmentFinishedLotId: string | null;
  zohoInvoiceId: string | null;
  zohoInvoiceLineId: string | null;
  allocationId: string | null;
  /** When true, the customer/product was pre-existing and we MUST
   *  leave it in place during cleanup. */
  customerPreexisting: boolean;
  productPreexisting: boolean;
};

const out = (label: string, value: unknown = "") => {
  console.log(`[verify-commercial-trace] ${label}`, value);
};
function fail(msg: string): never {
  throw new Error(`[verify-commercial-trace] FAIL: ${msg}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

async function refuseInProduction() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_STAGING_QA_DATA !== "true") {
    fail(
      "Refusing to run: NODE_ENV=production and ALLOW_STAGING_QA_DATA != true. This harness seeds QA rows; never run on prod.",
    );
  }
}

async function seedFixture(): Promise<Created> {
  out("seeding QA fixture…");

  // Customer — upsert by nexus_customer_id, never overwrite production data.
  let customerPreexisting = false;
  const existingCustomer = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.nexusCustomerId, QA_FIXTURE.customer.nexusCustomerId))
    .limit(1);
  let customerId: string;
  const existingCustomerRow = existingCustomer[0];
  if (existingCustomerRow) {
    customerPreexisting = true;
    customerId = existingCustomerRow.id;
    out("customer already exists (preserving)", customerId);
  } else {
    const inserted = await db
      .insert(customers)
      .values({
        customerCode: QA_FIXTURE.customer.customerCode,
        name: QA_FIXTURE.customer.name,
        nexusCustomerId: QA_FIXTURE.customer.nexusCustomerId,
        zohoCustomerId: QA_FIXTURE.customer.zohoCustomerId,
        notes: QA_TAG,
      })
      .returning({ id: customers.id });
    const c = inserted[0];
    if (!c) fail("customer insert returned no row");
    customerId = c.id;
    out("customer created", customerId);
  }

  // Product — upsert by zoho_item_id; never overwrite.
  let productPreexisting = false;
  const existingProduct = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.zohoItemId, QA_FIXTURE.product.zohoItemId))
    .limit(1);
  let productId: string;
  const existingProductRow = existingProduct[0];
  if (existingProductRow) {
    productPreexisting = true;
    productId = existingProductRow.id;
    out("product already exists (preserving)", productId);
  } else {
    const inserted = await db
      .insert(products)
      .values({
        sku: QA_FIXTURE.product.sku,
        name: QA_FIXTURE.product.name,
        zohoItemId: QA_FIXTURE.product.zohoItemId,
        kind: QA_FIXTURE.product.kind,
      })
      .returning({ id: products.id });
    const p = inserted[0];
    if (!p) fail("product insert returned no row");
    productId = p.id;
    out("product created", productId);
  }

  // Finished lot.
  const [fl] = await db
    .insert(finishedLots)
    .values({
      productId,
      finishedLotNumber: QA_FIXTURE.finishedLot.finishedLotNumber,
      traceCode: QA_FIXTURE.finishedLot.traceCode,
      producedOn: QA_FIXTURE.finishedLot.producedOn,
      expiryDate: QA_FIXTURE.finishedLot.expiryDate,
      unitsProduced: QA_FIXTURE.finishedLot.unitsProduced,
      packedAt: QA_FIXTURE.finishedLot.packedAt,
      notes: QA_TAG,
    })
    .returning({ id: finishedLots.id });
  if (!fl) fail("finished_lot insert returned no row");
  const finishedLotId = fl.id;
  out("finished_lot created", finishedLotId);

  // Shipment.
  const [ship] = await db
    .insert(shipments)
    .values({
      carrier: QA_FIXTURE.shipment.carrier,
      trackingNumber: QA_FIXTURE.shipment.trackingNumber,
      shippedAt: QA_FIXTURE.shipment.shippedAt,
      customerId,
    })
    .returning({ id: shipments.id });
  if (!ship) fail("shipment insert returned no row");
  const shipmentId = ship.id;
  out("shipment created", shipmentId);

  // Shipment finished lot.
  const [sfl] = await db
    .insert(shipmentFinishedLots)
    .values({
      shipmentId,
      finishedLotId,
      customerId,
      quantity: QA_FIXTURE.shipmentFinishedLot.quantity,
      unit: QA_FIXTURE.shipmentFinishedLot.unit,
      shippedAt: QA_FIXTURE.shipmentFinishedLot.shippedAt,
      notes: QA_TAG,
    })
    .returning({ id: shipmentFinishedLots.id });
  if (!sfl) fail("shipment_finished_lot insert returned no row");
  const shipmentFinishedLotId = sfl.id;
  out("shipment_finished_lot created", shipmentFinishedLotId);

  // Zoho invoice.
  const [inv] = await db
    .insert(zohoInvoices)
    .values({
      zohoInvoiceId: QA_FIXTURE.invoice.zohoInvoiceId,
      invoiceNumber: QA_FIXTURE.invoice.invoiceNumber,
      zohoCustomerId: QA_FIXTURE.invoice.zohoCustomerId,
      customerId,
      invoiceDate: QA_FIXTURE.invoice.invoiceDate,
      status: QA_FIXTURE.invoice.status,
      currency: QA_FIXTURE.invoice.currency,
      rawPayload: { qa: QA_TAG },
    })
    .returning({ id: zohoInvoices.id });
  if (!inv) fail("zoho_invoice insert returned no row");
  const zohoInvoiceId = inv.id;
  out("zoho_invoice created", zohoInvoiceId);

  // Zoho invoice line.
  const [line] = await db
    .insert(zohoInvoiceLines)
    .values({
      zohoInvoiceId,
      zohoInvoiceLineId: QA_FIXTURE.invoiceLine.zohoInvoiceLineId,
      zohoItemId: QA_FIXTURE.invoiceLine.zohoItemId,
      sku: QA_FIXTURE.invoiceLine.sku,
      itemName: QA_FIXTURE.invoiceLine.itemName,
      quantity: QA_FIXTURE.invoiceLine.quantity,
      unit: QA_FIXTURE.invoiceLine.unit,
      rawPayload: { qa: QA_TAG },
    })
    .returning({ id: zohoInvoiceLines.id });
  if (!line) fail("zoho_invoice_line insert returned no row");
  const zohoInvoiceLineId = line.id;
  out("zoho_invoice_line created", zohoInvoiceLineId);

  // Confirmed allocation.
  const [alloc] = await db
    .insert(finishedLotInvoiceAllocations)
    .values({
      invoiceLineId: zohoInvoiceLineId,
      finishedLotId,
      shipmentFinishedLotId,
      quantityAllocated: QA_FIXTURE.allocation.quantityAllocated,
      unit: QA_FIXTURE.allocation.unit,
      confidence: QA_FIXTURE.allocation.confidence,
      source: QA_FIXTURE.allocation.source,
      status: QA_FIXTURE.allocation.status,
      confirmed: QA_FIXTURE.allocation.confirmed,
      confirmedAt: new Date(),
      notes: QA_FIXTURE.allocation.notes,
    })
    .returning({ id: finishedLotInvoiceAllocations.id });
  if (!alloc) fail("allocation insert returned no row");
  const allocationId = alloc.id;
  out("confirmed allocation created", allocationId);

  return {
    customerId,
    productId,
    finishedLotId,
    shipmentId,
    shipmentFinishedLotId,
    zohoInvoiceId,
    zohoInvoiceLineId,
    allocationId,
    customerPreexisting,
    productPreexisting,
  };
}

async function cleanup(created: Created) {
  out("cleaning up QA rows…");
  // Reverse dependency order. Each delete is filtered by the QA tag /
  // id so we never touch unrelated rows. Wrapped in try/catch per-row
  // so one stuck row doesn't strand the others.
  const tryDelete = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      out(`cleaned ${label}`);
    } catch (e) {
      out(`failed to clean ${label}`, e instanceof Error ? e.message : e);
    }
  };

  if (created.allocationId) {
    await tryDelete("allocation", () =>
      db
        .delete(finishedLotInvoiceAllocations)
        .where(eq(finishedLotInvoiceAllocations.id, created.allocationId!)),
    );
  }
  if (created.zohoInvoiceLineId) {
    await tryDelete("zoho_invoice_line", () =>
      db
        .delete(zohoInvoiceLines)
        .where(eq(zohoInvoiceLines.id, created.zohoInvoiceLineId!)),
    );
  }
  if (created.zohoInvoiceId) {
    await tryDelete("zoho_invoice", () =>
      db.delete(zohoInvoices).where(eq(zohoInvoices.id, created.zohoInvoiceId!)),
    );
  }
  if (created.shipmentFinishedLotId) {
    await tryDelete("shipment_finished_lot", () =>
      db
        .delete(shipmentFinishedLots)
        .where(eq(shipmentFinishedLots.id, created.shipmentFinishedLotId!)),
    );
  }
  if (created.shipmentId) {
    await tryDelete("shipment", () =>
      db.delete(shipments).where(eq(shipments.id, created.shipmentId!)),
    );
  }
  if (created.finishedLotId) {
    await tryDelete("finished_lot", () =>
      db.delete(finishedLots).where(eq(finishedLots.id, created.finishedLotId!)),
    );
  }
  if (created.productId && !created.productPreexisting) {
    await tryDelete("product", () =>
      db.delete(products).where(eq(products.id, created.productId!)),
    );
  } else {
    out("product preserved (preexisting)", created.productId);
  }
  if (created.customerId && !created.customerPreexisting) {
    await tryDelete("customer", () =>
      db.delete(customers).where(eq(customers.id, created.customerId!)),
    );
  } else {
    out("customer preserved (preexisting)", created.customerId);
  }
}

// ─── Nexus endpoint emulation (helper composition) ───────────────────
//
// Each endpoint emulator mirrors what the corresponding route handler
// does: authenticate → resolve scope → parse query → call the DB
// loader → wrap with the response builder. The route handler's
// 405-method-guard branch is covered by lib/integrations/nexus/
// lookup.test.ts; this harness only exercises the GET data path.

type EndpointResult = {
  status: number;
  body: unknown;
};

function buildRequest(
  routePath: string,
  query: Record<string, string>,
  opts: { token?: string } = {},
): Request {
  const params = new URLSearchParams(query);
  const url = `http://internal.local${routePath}?${params.toString()}`;
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  return new Request(url, { method: "GET", headers });
}

function errorResponse(status: number, code: string, message: string): EndpointResult {
  return {
    status,
    body: {
      error: { code, message },
      schema_version: "1.0",
      source: "LUMA",
    },
  };
}

async function emulateInvoiceBatches(
  query: Record<string, string>,
  opts: { token?: string } = {},
): Promise<EndpointResult> {
  const request = buildRequest("/api/nexus/invoice-batches", query, opts);
  const auth = authenticateNexusLookupRequest(request);
  if (!auth.ok) {
    return errorResponse(auth.error.httpStatus, auth.error.code, auth.error.message);
  }
  const scope: NexusLookupScope = resolveNexusLookupScope(request, auth.scope);
  const url = new URL(request.url);
  const invoiceNumber = url.searchParams.get("invoice_number")?.trim() ?? "";
  if (!invoiceNumber) {
    return errorResponse(400, "INVALID_REQUEST", "invoice_number query parameter is required.");
  }
  const result = await loadConfirmedBatchesForInvoice({
    invoiceNumber,
    nexusCustomerId: url.searchParams.get("nexus_customer_id"),
    customerCode: url.searchParams.get("customer_code"),
    productSku: url.searchParams.get("product_sku"),
  });
  if (result.kind === "NOT_FOUND") return errorResponse(404, "NOT_FOUND", result.message);
  if (result.kind === "CUSTOMER_SCOPE_MISMATCH") {
    return errorResponse(422, "CUSTOMER_SCOPE_MISMATCH", result.message);
  }
  const body = buildInvoiceBatchesResponse({
    scope,
    invoice: {
      invoice_number: result.invoice.invoice_number,
      invoice_date: result.invoice.invoice_date,
      customer_code: result.invoice.customer_code,
      nexus_customer_id: result.invoice.nexus_customer_id,
    },
    batches: result.batches,
    warnings: result.warnings,
  });
  return { status: 200, body };
}

async function emulateCustomerBatches(
  query: Record<string, string>,
  opts: { token?: string } = {},
): Promise<EndpointResult> {
  const request = buildRequest("/api/nexus/customer-batches", query, opts);
  const auth = authenticateNexusLookupRequest(request);
  if (!auth.ok) {
    return errorResponse(auth.error.httpStatus, auth.error.code, auth.error.message);
  }
  const scope: NexusLookupScope = resolveNexusLookupScope(request, auth.scope);
  const url = new URL(request.url);
  const nexusCustomerId = url.searchParams.get("nexus_customer_id")?.trim() ?? "";
  const customerCode = url.searchParams.get("customer_code")?.trim() ?? "";
  if (!nexusCustomerId && !customerCode) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide nexus_customer_id or customer_code as a query parameter.",
    );
  }
  const productSku = url.searchParams.get("product_sku");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const activeOnly = url.searchParams.get("active_only") === "true";
  const result = await loadConfirmedBatchesForCustomer({
    nexusCustomerId,
    customerCode,
    productSku,
    dateFrom,
    dateTo,
    activeOnly,
  });
  if (result.kind === "NOT_FOUND") return errorResponse(404, "NOT_FOUND", result.message);
  const body = buildCustomerBatchesResponse({
    scope,
    customer: {
      customer_code: result.customer.customer_code,
      nexus_customer_id: result.customer.nexus_customer_id,
    },
    filters: {
      product_sku: productSku ?? null,
      date_from: dateFrom ?? null,
      date_to: dateTo ?? null,
      active_only: activeOnly,
    },
    batches: result.batches,
    warnings: result.warnings,
  });
  return { status: 200, body };
}

async function emulateBatchPassport(
  query: Record<string, string>,
  opts: { token?: string } = {},
): Promise<EndpointResult> {
  const request = buildRequest("/api/nexus/batch-passport", query, opts);
  const auth = authenticateNexusLookupRequest(request);
  if (!auth.ok) {
    return errorResponse(auth.error.httpStatus, auth.error.code, auth.error.message);
  }
  const scope: NexusLookupScope = resolveNexusLookupScope(request, auth.scope);
  const url = new URL(request.url);
  const traceCode = url.searchParams.get("trace_code");
  const sflId = url.searchParams.get("shipment_finished_lot_id");
  if ((!traceCode || !traceCode.trim()) && (!sflId || !sflId.trim())) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide trace_code or shipment_finished_lot_id as a query parameter.",
    );
  }
  const askedCustomerId = url.searchParams.get("nexus_customer_id");
  const result = await loadBatchPassportForNexus({
    traceCode,
    shipmentFinishedLotId: sflId,
  });
  if (result.kind === "NOT_FOUND") return errorResponse(404, "NOT_FOUND", result.message);
  if (
    scope === "customer" &&
    askedCustomerId &&
    askedCustomerId.trim() &&
    result.passport.customer.nexus_id !== askedCustomerId.trim()
  ) {
    return errorResponse(
      422,
      "CUSTOMER_SCOPE_MISMATCH",
      "Requested batch is not linked to the supplied nexus_customer_id.",
    );
  }
  const passport: NexusPassportRow = {
    trace_code: result.passport.trace_code,
    finished_lot_id: result.passport.finished_lot_id,
    shipment_finished_lot_id: result.passport.shipment_finished_lot_id,
    product_name: result.passport.product_name,
    product_sku: result.passport.product_sku,
    packed_at: result.passport.packed_at,
    shipped_at: result.passport.shipped_at,
    quantity: result.passport.quantity,
    unit: result.passport.unit,
    warnings: result.passport.warnings,
    missing_links: result.passport.missing_links,
    supplier_lots: result.passport.supplier_lots,
    raw_bag_receipts: result.passport.raw_bag_receipts,
    raw_bag_qrs: result.passport.raw_bag_qrs,
    pos: result.passport.pos,
    operators: result.passport.operators,
    machines: result.passport.machines,
    qc_events: result.passport.qc_events,
    packaging_lots: result.passport.packaging_lots,
  };
  return { status: 200, body: buildBatchPassportResponse({ scope, passport }) };
}

// ─── Assertions ──────────────────────────────────────────────────────

async function runAssertions(created: Created) {
  // 1. Missing auth header returns 401 (method-guard 405 is covered by
  //    the route-shape unit tests; this harness only exercises the GET
  //    data path since the route source isn't present in the runtime
  //    standalone image).
  out("step 1 · missing Authorization returns 401");
  const noAuth = await emulateInvoiceBatches({
    invoice_number: QA_FIXTURE.invoice.invoiceNumber,
  });
  assert(noAuth.status === 401, `expected 401 missing auth, got ${noAuth.status}`);

  // 2. Invalid token returns 401.
  out("step 2 · invalid bearer token returns 401");
  const bad = await emulateInvoiceBatches(
    { invoice_number: QA_FIXTURE.invoice.invoiceNumber },
    { token: "obviously-wrong" },
  );
  assert(bad.status === 401, `expected 401 on bad token, got ${bad.status}`);
  const badStr = JSON.stringify(bad.body);
  assert(
    !badStr.includes(QA_FIXTURE.tokens.customer) &&
      !badStr.includes(QA_FIXTURE.tokens.csr) &&
      !badStr.includes("obviously-wrong"),
    "401 response must not echo any token",
  );

  // 3. invoice-batches happy path (customer scope).
  out("step 3 · invoice-batches customer scope");
  const inv = await emulateInvoiceBatches(
    {
      invoice_number: QA_FIXTURE.invoice.invoiceNumber,
      nexus_customer_id: QA_FIXTURE.customer.nexusCustomerId,
    },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(inv.status === 200, `expected 200, got ${inv.status}`);
  const invBody = inv.body as {
    schema_version?: string;
    source?: string;
    scope?: string;
    batches?: Array<Record<string, unknown>>;
  };
  assert(invBody.schema_version === "1.0", "schema_version must be 1.0");
  assert(invBody.source === "LUMA", "source must be LUMA");
  assert(invBody.scope === "customer", `scope must be customer, got ${invBody.scope}`);
  assert(Array.isArray(invBody.batches) && invBody.batches.length === 1, "expected exactly 1 batch");
  const batch = invBody.batches![0]!;
  assert(batch.trace_code === QA_FIXTURE.finishedLot.traceCode, `trace_code wrong: ${batch.trace_code}`);
  assert(batch.product_sku === QA_FIXTURE.product.sku, `product_sku wrong: ${batch.product_sku}`);
  assert(Number(batch.quantity) === 10, `quantity wrong: ${batch.quantity}`);
  assert(batch.unit === "cases", `unit wrong: ${batch.unit}`);
  assert(batch.confidence === "HIGH", `confidence wrong: ${batch.confidence}`);
  const label = String(batch.dropdown_label ?? "");
  assert(
    label.includes(QA_FIXTURE.product.name) && label.includes(QA_FIXTURE.finishedLot.traceCode),
    `dropdown_label should include product + trace: ${label}`,
  );
  for (const csrField of [
    "supplier_lot_number",
    "internal_receipt_number",
    "raw_bag_qr",
    "operator_name",
    "machine_id",
  ]) {
    assert(
      !(csrField in batch),
      `customer-scope batch must NOT include ${csrField}`,
    );
  }

  // 4. customer-batches happy path (customer scope).
  out("step 4 · customer-batches customer scope");
  const cust = await emulateCustomerBatches(
    { nexus_customer_id: QA_FIXTURE.customer.nexusCustomerId },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(cust.status === 200, `expected 200, got ${cust.status}`);
  const custBody = cust.body as {
    scope?: string;
    batches?: Array<Record<string, unknown>>;
    customer?: Record<string, unknown>;
  };
  assert(custBody.scope === "customer", "scope must be customer");
  assert(
    Array.isArray(custBody.batches) && custBody.batches.length === 1,
    `expected 1 batch, got ${custBody.batches?.length}`,
  );
  assert(
    custBody.batches![0]!.trace_code === QA_FIXTURE.finishedLot.traceCode,
    "trace_code mismatch on customer-batches",
  );
  assert(
    custBody.customer?.nexus_customer_id === QA_FIXTURE.customer.nexusCustomerId,
    "customer.nexus_customer_id mismatch",
  );

  // 5. batch-passport customer scope hides CSR-only fields.
  out("step 5 · batch-passport customer scope hides CSR-only fields");
  const passC = await emulateBatchPassport(
    {
      trace_code: QA_FIXTURE.finishedLot.traceCode,
      nexus_customer_id: QA_FIXTURE.customer.nexusCustomerId,
    },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(passC.status === 200, `expected 200, got ${passC.status}`);
  const passCBody = passC.body as {
    scope?: string;
    passport?: Record<string, unknown>;
  };
  assert(passCBody.scope === "customer", "scope must be customer");
  const cp = passCBody.passport!;
  for (const csrField of [
    "supplier_lots",
    "raw_bag_receipts",
    "raw_bag_qrs",
    "operators",
    "machines",
    "qc_events",
    "packaging_lots",
  ]) {
    assert(
      !(csrField in cp),
      `customer-scope passport must NOT include ${csrField}`,
    );
  }
  assert(cp.trace_code === QA_FIXTURE.finishedLot.traceCode, "passport trace_code mismatch");
  assert(cp.product_sku === QA_FIXTURE.product.sku, "passport product_sku mismatch");
  assert(Array.isArray(cp.warnings), "passport.warnings must be an array");
  assert(Array.isArray(cp.missing_links), "passport.missing_links must be an array");

  // 6. batch-passport CSR scope can carry internal arrays (possibly empty).
  out("step 6 · batch-passport CSR scope");
  const passCSR = await emulateBatchPassport(
    {
      trace_code: QA_FIXTURE.finishedLot.traceCode,
    },
    { token: QA_FIXTURE.tokens.csr },
  );
  assert(passCSR.status === 200, `expected 200, got ${passCSR.status}`);
  const passCSRBody = passCSR.body as {
    scope?: string;
    passport?: Record<string, unknown>;
  };
  assert(passCSRBody.scope === "csr", `scope must be csr, got ${passCSRBody.scope}`);
  const cs = passCSRBody.passport!;
  for (const csrField of [
    "supplier_lots",
    "raw_bag_receipts",
    "raw_bag_qrs",
    "operators",
    "machines",
    "qc_events",
    "packaging_lots",
  ]) {
    assert(csrField in cs, `csr passport MUST include ${csrField} key (array may be empty)`);
    assert(
      Array.isArray((cs as Record<string, unknown>)[csrField]),
      `${csrField} should be an array on csr scope`,
    );
  }

  // 7. Cross-customer mismatch returns 422.
  out("step 7 · cross-customer mismatch returns 422");
  const mismatch = await emulateInvoiceBatches(
    {
      invoice_number: QA_FIXTURE.invoice.invoiceNumber,
      nexus_customer_id: "QA-NEXUS-WRONG-CUSTOMER",
    },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(
    mismatch.status === 422,
    `expected 422 on customer mismatch, got ${mismatch.status}`,
  );
  assert(
    (mismatch.body as { error?: { code?: string } })?.error?.code ===
      "CUSTOMER_SCOPE_MISMATCH",
    "mismatch body code wrong",
  );

  // 8. Cross-customer batch-passport returns 422.
  out("step 8 · cross-customer batch-passport returns 422");
  const passWrong = await emulateBatchPassport(
    {
      trace_code: QA_FIXTURE.finishedLot.traceCode,
      nexus_customer_id: "QA-NEXUS-WRONG-CUSTOMER",
    },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(passWrong.status === 422, `expected 422, got ${passWrong.status}`);

  // 9. Unknown invoice returns honest 404.
  out("step 9 · unknown invoice returns 404");
  const noInv = await emulateInvoiceBatches(
    { invoice_number: "QA-INV-DOES-NOT-EXIST" },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(noInv.status === 404, `expected 404, got ${noInv.status}`);

  // 10. Missing required query → 400.
  out("step 10 · missing invoice_number → 400");
  const missing = await emulateInvoiceBatches(
    {},
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(missing.status === 400, `expected 400, got ${missing.status}`);

  out("all assertions passed");
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  await refuseInProduction();

  // Stage the Nexus tokens for the duration of this process.
  process.env.NEXUS_LOOKUP_TOKEN = QA_FIXTURE.tokens.customer;
  process.env.NEXUS_CSR_LOOKUP_TOKEN = QA_FIXTURE.tokens.csr;

  let created: Created | null = null;
  try {
    created = await seedFixture();
    await runAssertions(created);
    out("VERIFY OK");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (created) {
      try {
        await cleanup(created);
      } catch (cleanupErr) {
        console.error("[verify-commercial-trace] cleanup failed:", cleanupErr);
        process.exitCode = 1;
      }
    }
    // Sanity sweep — log any QA-tagged rows that survived.
    try {
      const survivors = await db
        .select({ id: customers.id, code: customers.customerCode })
        .from(customers)
        .where(eq(customers.nexusCustomerId, QA_FIXTURE.customer.nexusCustomerId));
      if (survivors.length > 0) {
        out("WARNING: QA customer rows survived cleanup", survivors);
      }
      const alloc = await db
        .select({ id: finishedLotInvoiceAllocations.id })
        .from(finishedLotInvoiceAllocations)
        .where(eq(finishedLotInvoiceAllocations.source, QA_FIXTURE.allocation.source));
      if (alloc.length > 0) {
        out("WARNING: QA allocation rows survived cleanup", alloc);
      }
    } catch {
      // Ignore — the report is best-effort.
    }
    // Defensive: prevent unused-import lint on `and`, `inArray` since
    // we kept them in case future cleanup paths use them.
    void and;
    void inArray;
  }
}

main();
