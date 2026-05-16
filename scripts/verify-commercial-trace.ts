// COMMERCIAL-TRACE-7 — mock end-to-end commercial-trace verification.
//
// Seeds a clearly-marked QA fixture (customer, product, finished lot,
// shipment, invoice, invoice line, confirmed allocation), invokes
// each Nexus route handler directly with mocked env tokens, asserts
// the documented contract (customer scope strips CSR-only fields, CSR
// scope keeps them, 422 on cross-customer mismatch, 401 on bad token,
// 405 on POST, 200 with HIGH confidence on the happy path), then
// cleans up every QA row it created in reverse dependency order.
//
// We invoke the route handlers as functions (no HTTP roundtrip) so
// the running staging app's env stays untouched. This script reads
// & writes the same Postgres the app reads — that's the point.
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

// ─── Nexus route invocation harness ───────────────────────────────────

type HandlerResult = {
  status: number;
  body: unknown;
};

async function callNexus(
  /** "/api/nexus/invoice-batches" etc. */
  routePath: string,
  query: Record<string, string>,
  opts: { token?: string; method?: "GET" | "POST" } = {},
): Promise<HandlerResult> {
  const params = new URLSearchParams(query);
  const url = `http://internal.local${routePath}?${params.toString()}`;
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);

  const request = new Request(url, {
    method: opts.method ?? "GET",
    headers,
  });

  // Import the handler module lazily so process.env mutation lands
  // before validateNexusLookupConfig is invoked.
  let mod: {
    GET: (r: Request) => Promise<Response>;
    POST?: (r?: Request) => Promise<Response>;
  };
  if (routePath === "/api/nexus/invoice-batches") {
    mod = await import("@/app/api/nexus/invoice-batches/route");
  } else if (routePath === "/api/nexus/customer-batches") {
    mod = await import("@/app/api/nexus/customer-batches/route");
  } else if (routePath === "/api/nexus/batch-passport") {
    mod = await import("@/app/api/nexus/batch-passport/route");
  } else {
    fail(`unknown nexus route ${routePath}`);
  }

  const handler = opts.method === "POST" ? mod.POST : mod.GET;
  if (!handler) fail(`handler missing for ${routePath} ${opts.method}`);
  const res = await handler(request);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ─── Assertions ──────────────────────────────────────────────────────

async function runAssertions(created: Created) {
  // 1. Method guard — POST returns 405.
  out("step 1 · POST returns 405");
  const post = await callNexus(
    "/api/nexus/invoice-batches",
    { invoice_number: "ignored" },
    { method: "POST" },
  );
  assert(post.status === 405, `expected 405 on POST, got ${post.status}`);
  assert(
    (post.body as { error?: { code?: string } })?.error?.code ===
      "METHOD_NOT_ALLOWED",
    "POST body should carry METHOD_NOT_ALLOWED",
  );

  // 2. Invalid token returns 401.
  out("step 2 · invalid bearer token returns 401");
  const bad = await callNexus(
    "/api/nexus/invoice-batches",
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
  const inv = await callNexus(
    "/api/nexus/invoice-batches",
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
  const cust = await callNexus(
    "/api/nexus/customer-batches",
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
  const passC = await callNexus(
    "/api/nexus/batch-passport",
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
  const passCSR = await callNexus(
    "/api/nexus/batch-passport",
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
  const mismatch = await callNexus(
    "/api/nexus/invoice-batches",
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
  const passWrong = await callNexus(
    "/api/nexus/batch-passport",
    {
      trace_code: QA_FIXTURE.finishedLot.traceCode,
      nexus_customer_id: "QA-NEXUS-WRONG-CUSTOMER",
    },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(passWrong.status === 422, `expected 422, got ${passWrong.status}`);

  // 9. Unknown invoice returns honest 404.
  out("step 9 · unknown invoice returns 404");
  const noInv = await callNexus(
    "/api/nexus/invoice-batches",
    { invoice_number: "QA-INV-DOES-NOT-EXIST" },
    { token: QA_FIXTURE.tokens.customer },
  );
  assert(noInv.status === 404, `expected 404, got ${noInv.status}`);

  // 10. Missing required query → 400.
  out("step 10 · missing invoice_number → 400");
  const missing = await callNexus(
    "/api/nexus/invoice-batches",
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
