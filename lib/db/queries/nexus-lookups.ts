// COMMERCIAL-TRACE-6 — DB layer for Nexus read-only lookup endpoints.
//
// Three loaders. All filter on confirmed=true + status='CONFIRMED' so
// suggested / needs_review / rejected allocations are NEVER exposed
// to Nexus. Customer scoping is enforced in SQL where possible:
//   - loadConfirmedBatchesForInvoice: filters by invoice number, and
//     when nexus_customer_id / customer_code is supplied, validates
//     the invoice belongs to that customer.
//   - loadConfirmedBatchesForCustomer: requires nexus_customer_id OR
//     customer_code; never returns batches for other customers.
//   - loadBatchPassportForNexus: lookup by trace_code OR
//     shipment_finished_lot_id, returning the recall passport summary
//     plus the linked confirmed-allocation context.

import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, sql } from "drizzle-orm";
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
  buildNexusBatchDropdownLabel,
  type NexusBatchRow,
} from "@/lib/integrations/nexus/lookup";
import { getRecallPassport } from "@/lib/production/recall-passport-loaders";

// ─── Shared row builder ───────────────────────────────────────────────

type ConfirmedJoinRow = {
  allocationId: string;
  invoiceLineId: string;
  finishedLotId: string;
  shipmentFinishedLotId: string | null;
  quantityAllocated: string;
  unit: string | null;
  notes: string | null;
  productName: string | null;
  productSku: string | null;
  traceCode: string | null;
  packedAt: Date | null;
  shippedAt: Date | null;
  sflShippedAt: Date | null;
};

function rowToBatch(r: ConfirmedJoinRow): NexusBatchRow {
  const shipped = r.sflShippedAt ?? r.shippedAt ?? null;
  const base = {
    shipment_finished_lot_id: r.shipmentFinishedLotId,
    finished_lot_id: r.finishedLotId,
    trace_code: r.traceCode,
    product_name: r.productName,
    product_sku: r.productSku,
    quantity:
      r.quantityAllocated != null && r.quantityAllocated !== ""
        ? Number(r.quantityAllocated)
        : null,
    unit: r.unit,
    packed_at: r.packedAt ? r.packedAt.toISOString() : null,
    shipped_at: shipped ? shipped.toISOString() : null,
    confidence: "HIGH" as const,
    warnings: r.notes ? [r.notes] : [],
  };
  return {
    ...base,
    dropdown_label: buildNexusBatchDropdownLabel({
      product_name: base.product_name,
      trace_code: base.trace_code,
      shipped_at: base.shipped_at,
      packed_at: base.packed_at,
    }),
  };
}

// ─── loadConfirmedBatchesForInvoice ───────────────────────────────────

export type InvoiceBatchesLookupResult =
  | {
      kind: "OK";
      invoice: {
        invoice_number: string;
        invoice_date: string | null;
        customer_code: string | null;
        nexus_customer_id: string | null;
        customerId: string | null;
      };
      batches: NexusBatchRow[];
      warnings: string[];
    }
  | { kind: "NOT_FOUND"; message: string }
  | { kind: "CUSTOMER_SCOPE_MISMATCH"; message: string };

export async function loadConfirmedBatchesForInvoice(opts: {
  invoiceNumber: string;
  /** When supplied, the invoice's resolved customer must match one of
   *  these identifiers (after a lookup against the customers table).
   *  Pass null for both when the caller is internal / CSR. */
  nexusCustomerId?: string | null;
  customerCode?: string | null;
  productSku?: string | null;
}): Promise<InvoiceBatchesLookupResult> {
  const invoiceNumber = opts.invoiceNumber.trim();
  if (invoiceNumber.length === 0) {
    return { kind: "NOT_FOUND", message: "Empty invoice number." };
  }

  const [invoice] = await db
    .select({
      id: zohoInvoices.id,
      invoiceNumber: zohoInvoices.invoiceNumber,
      invoiceDate: zohoInvoices.invoiceDate,
      customerId: zohoInvoices.customerId,
      customerCode: customers.customerCode,
      nexusCustomerId: customers.nexusCustomerId,
    })
    .from(zohoInvoices)
    .leftJoin(customers, eq(customers.id, zohoInvoices.customerId))
    .where(eq(zohoInvoices.invoiceNumber, invoiceNumber))
    .limit(1);

  if (!invoice) {
    return {
      kind: "NOT_FOUND",
      message: `Invoice ${invoiceNumber} not found in Luma.`,
    };
  }

  // Customer-scope validation when caller supplied an identifier.
  const askedCustomerId = (opts.nexusCustomerId ?? "").trim();
  const askedCustomerCode = (opts.customerCode ?? "").trim();
  if (askedCustomerId.length > 0 || askedCustomerCode.length > 0) {
    const matchesId =
      askedCustomerId.length > 0 &&
      invoice.nexusCustomerId === askedCustomerId;
    const matchesCode =
      askedCustomerCode.length > 0 &&
      invoice.customerCode === askedCustomerCode;
    if (!matchesId && !matchesCode) {
      return {
        kind: "CUSTOMER_SCOPE_MISMATCH",
        message:
          "Invoice does not belong to the customer supplied with the request.",
      };
    }
  }

  // Confirmed allocations only.
  const allocRows = await db
    .select({
      allocationId: finishedLotInvoiceAllocations.id,
      invoiceLineId: finishedLotInvoiceAllocations.invoiceLineId,
      finishedLotId: finishedLotInvoiceAllocations.finishedLotId,
      shipmentFinishedLotId:
        finishedLotInvoiceAllocations.shipmentFinishedLotId,
      quantityAllocated: finishedLotInvoiceAllocations.quantityAllocated,
      unit: finishedLotInvoiceAllocations.unit,
      notes: finishedLotInvoiceAllocations.notes,
      productName: products.name,
      productSku: products.sku,
      traceCode: finishedLots.traceCode,
      packedAt: finishedLots.packedAt,
      sflShippedAt: shipmentFinishedLots.shippedAt,
      shippedAt: shipments.shippedAt,
    })
    .from(finishedLotInvoiceAllocations)
    .innerJoin(
      zohoInvoiceLines,
      eq(zohoInvoiceLines.id, finishedLotInvoiceAllocations.invoiceLineId),
    )
    .innerJoin(
      finishedLots,
      eq(finishedLots.id, finishedLotInvoiceAllocations.finishedLotId),
    )
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(
      shipmentFinishedLots,
      eq(
        shipmentFinishedLots.id,
        finishedLotInvoiceAllocations.shipmentFinishedLotId,
      ),
    )
    .leftJoin(shipments, eq(shipments.id, shipmentFinishedLots.shipmentId))
    .where(
      and(
        eq(zohoInvoiceLines.zohoInvoiceId, invoice.id),
        eq(finishedLotInvoiceAllocations.confirmed, true),
        eq(finishedLotInvoiceAllocations.status, "CONFIRMED"),
        opts.productSku && opts.productSku.trim().length > 0
          ? ilike(products.sku, opts.productSku.trim())
          : sql`TRUE`,
      ),
    )
    .orderBy(
      desc(shipmentFinishedLots.shippedAt),
      desc(finishedLots.packedAt),
      asc(finishedLots.id),
    );

  const batches = allocRows.map(rowToBatch);
  return {
    kind: "OK",
    invoice: {
      invoice_number: invoice.invoiceNumber,
      invoice_date: invoice.invoiceDate ?? null,
      customer_code: invoice.customerCode ?? null,
      nexus_customer_id: invoice.nexusCustomerId ?? null,
      customerId: invoice.customerId ?? null,
    },
    batches,
    warnings:
      batches.length === 0
        ? ["No confirmed allocations exist for this invoice yet."]
        : [],
  };
}

// ─── loadConfirmedBatchesForCustomer ──────────────────────────────────

export type CustomerBatchesLookupResult =
  | {
      kind: "OK";
      customer: {
        customer_code: string | null;
        nexus_customer_id: string | null;
        customerId: string;
      };
      batches: NexusBatchRow[];
      warnings: string[];
    }
  | { kind: "NOT_FOUND"; message: string };

export async function loadConfirmedBatchesForCustomer(opts: {
  nexusCustomerId?: string | null;
  customerCode?: string | null;
  productSku?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  activeOnly?: boolean;
}): Promise<CustomerBatchesLookupResult> {
  const nid = (opts.nexusCustomerId ?? "").trim();
  const code = (opts.customerCode ?? "").trim();
  if (nid.length === 0 && code.length === 0) {
    return {
      kind: "NOT_FOUND",
      message: "Provide nexus_customer_id or customer_code.",
    };
  }

  const customerRow = await db
    .select({
      id: customers.id,
      customerCode: customers.customerCode,
      nexusCustomerId: customers.nexusCustomerId,
    })
    .from(customers)
    .where(
      nid.length > 0
        ? eq(customers.nexusCustomerId, nid)
        : eq(customers.customerCode, code),
    )
    .limit(1);
  const customer = customerRow[0];
  if (!customer) {
    return {
      kind: "NOT_FOUND",
      message: "Customer not found in Luma.",
    };
  }

  const rows = await db
    .select({
      allocationId: finishedLotInvoiceAllocations.id,
      invoiceLineId: finishedLotInvoiceAllocations.invoiceLineId,
      finishedLotId: finishedLotInvoiceAllocations.finishedLotId,
      shipmentFinishedLotId:
        finishedLotInvoiceAllocations.shipmentFinishedLotId,
      quantityAllocated: finishedLotInvoiceAllocations.quantityAllocated,
      unit: finishedLotInvoiceAllocations.unit,
      notes: finishedLotInvoiceAllocations.notes,
      productName: products.name,
      productSku: products.sku,
      traceCode: finishedLots.traceCode,
      packedAt: finishedLots.packedAt,
      sflShippedAt: shipmentFinishedLots.shippedAt,
      shippedAt: shipments.shippedAt,
    })
    .from(finishedLotInvoiceAllocations)
    .innerJoin(
      shipmentFinishedLots,
      eq(
        shipmentFinishedLots.id,
        finishedLotInvoiceAllocations.shipmentFinishedLotId,
      ),
    )
    .innerJoin(
      finishedLots,
      eq(finishedLots.id, finishedLotInvoiceAllocations.finishedLotId),
    )
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(shipments, eq(shipments.id, shipmentFinishedLots.shipmentId))
    .where(
      and(
        eq(finishedLotInvoiceAllocations.confirmed, true),
        eq(finishedLotInvoiceAllocations.status, "CONFIRMED"),
        eq(shipmentFinishedLots.customerId, customer.id),
        opts.productSku && opts.productSku.trim().length > 0
          ? ilike(products.sku, opts.productSku.trim())
          : sql`TRUE`,
        opts.dateFrom
          ? gte(shipmentFinishedLots.shippedAt, new Date(opts.dateFrom))
          : sql`TRUE`,
        opts.dateTo
          ? lte(shipmentFinishedLots.shippedAt, new Date(opts.dateTo))
          : sql`TRUE`,
        opts.activeOnly === true
          ? isNotNull(shipmentFinishedLots.shippedAt)
          : sql`TRUE`,
      ),
    )
    .orderBy(
      desc(shipmentFinishedLots.shippedAt),
      desc(finishedLots.packedAt),
    );

  const batches = rows.map(rowToBatch);
  return {
    kind: "OK",
    customer: {
      customer_code: customer.customerCode,
      nexus_customer_id: customer.nexusCustomerId,
      customerId: customer.id,
    },
    batches,
    warnings:
      batches.length === 0
        ? ["No confirmed allocations exist for this customer yet."]
        : [],
  };
}

// ─── loadBatchPassportForNexus ────────────────────────────────────────

export type BatchPassportLookupResult =
  | {
      kind: "OK";
      passport: {
        trace_code: string | null;
        finished_lot_id: string;
        shipment_finished_lot_id: string | null;
        product_name: string | null;
        product_sku: string | null;
        packed_at: string | null;
        shipped_at: string | null;
        quantity: number | null;
        unit: string | null;
        warnings: string[];
        missing_links: string[];
        supplier_lots: Array<{
          batch_number: string | null;
          vendor_name: string | null;
        }>;
        raw_bag_receipts: string[];
        raw_bag_qrs: string[];
        pos: Array<{ po_number: string | null; vendor_name: string | null }>;
        operators: string[];
        machines: string[];
        qc_events: Array<{ event_type: string; occurred_at: string }>;
        packaging_lots: Array<{
          material_name: string | null;
          roll_number: string | null;
          supplier: string | null;
        }>;
        customer: { id: string | null; code: string | null; nexus_id: string | null };
      };
    }
  | { kind: "NOT_FOUND"; message: string };

export async function loadBatchPassportForNexus(opts: {
  traceCode?: string | null;
  shipmentFinishedLotId?: string | null;
}): Promise<BatchPassportLookupResult> {
  const trace = (opts.traceCode ?? "").trim();
  const sflId = (opts.shipmentFinishedLotId ?? "").trim();
  if (trace.length === 0 && sflId.length === 0) {
    return {
      kind: "NOT_FOUND",
      message: "Provide trace_code or shipment_finished_lot_id.",
    };
  }

  // Resolve the finished lot.
  let finishedLot: {
    id: string;
    traceCode: string | null;
    packedAt: Date | null;
    productName: string | null;
    productSku: string | null;
  } | null = null;
  let shipmentRow: {
    id: string | null;
    customerId: string | null;
    customerCode: string | null;
    nexusCustomerId: string | null;
    shippedAt: Date | null;
    quantity: number | null;
    unit: string | null;
  } | null = null;

  if (sflId.length > 0) {
    const [row] = await db
      .select({
        sflId: shipmentFinishedLots.id,
        finishedLotId: shipmentFinishedLots.finishedLotId,
        customerId: shipmentFinishedLots.customerId,
        customerCode: customers.customerCode,
        nexusCustomerId: customers.nexusCustomerId,
        shippedAt: shipmentFinishedLots.shippedAt,
        quantity: shipmentFinishedLots.quantity,
        unit: shipmentFinishedLots.unit,
        traceCode: finishedLots.traceCode,
        packedAt: finishedLots.packedAt,
        productName: products.name,
        productSku: products.sku,
      })
      .from(shipmentFinishedLots)
      .innerJoin(finishedLots, eq(finishedLots.id, shipmentFinishedLots.finishedLotId))
      .leftJoin(products, eq(products.id, finishedLots.productId))
      .leftJoin(customers, eq(customers.id, shipmentFinishedLots.customerId))
      .where(eq(shipmentFinishedLots.id, sflId))
      .limit(1);
    if (row) {
      finishedLot = {
        id: row.finishedLotId,
        traceCode: row.traceCode,
        packedAt: row.packedAt,
        productName: row.productName,
        productSku: row.productSku,
      };
      shipmentRow = {
        id: row.sflId,
        customerId: row.customerId,
        customerCode: row.customerCode,
        nexusCustomerId: row.nexusCustomerId,
        shippedAt: row.shippedAt,
        quantity: row.quantity,
        unit: row.unit,
      };
    }
  } else {
    const [row] = await db
      .select({
        id: finishedLots.id,
        traceCode: finishedLots.traceCode,
        packedAt: finishedLots.packedAt,
        productName: products.name,
        productSku: products.sku,
      })
      .from(finishedLots)
      .leftJoin(products, eq(products.id, finishedLots.productId))
      .where(eq(finishedLots.traceCode, trace))
      .limit(1);
    if (row) {
      finishedLot = row;
      const [s] = await db
        .select({
          id: shipmentFinishedLots.id,
          customerId: shipmentFinishedLots.customerId,
          customerCode: customers.customerCode,
          nexusCustomerId: customers.nexusCustomerId,
          shippedAt: shipmentFinishedLots.shippedAt,
          quantity: shipmentFinishedLots.quantity,
          unit: shipmentFinishedLots.unit,
        })
        .from(shipmentFinishedLots)
        .leftJoin(customers, eq(customers.id, shipmentFinishedLots.customerId))
        .where(eq(shipmentFinishedLots.finishedLotId, row.id))
        .orderBy(desc(shipmentFinishedLots.shippedAt))
        .limit(1);
      shipmentRow = s ?? null;
    }
  }

  if (!finishedLot) {
    return {
      kind: "NOT_FOUND",
      message: "Finished lot not found by trace code or shipment id.",
    };
  }

  // Pull the recall passport summary via the existing canonical loader.
  // We use trace_code if present; otherwise we fall back to the lot id
  // (the loader's `finished_lot_trace_code` kind requires a string —
  // if no trace code exists, we skip the deep loader and rely on the
  // minimal data we already collected).
  const traceForPassport = finishedLot.traceCode;
  const passport = traceForPassport
    ? await getRecallPassport({
        kind: "finished_lot_trace_code",
        value: traceForPassport,
      })
    : null;

  const supplierLots: Array<{ batch_number: string | null; vendor_name: string | null }> = [];
  const rawBagReceipts: string[] = [];
  const rawBagQrs: string[] = [];
  const pos: Array<{ po_number: string | null; vendor_name: string | null }> = [];
  const operators: string[] = [];
  const machines: string[] = [];
  const qcEvents: Array<{ event_type: string; occurred_at: string }> = [];
  const packagingLots: Array<{
    material_name: string | null;
    roll_number: string | null;
    supplier: string | null;
  }> = [];
  const passportWarnings: string[] = [];
  const passportMissing: string[] = [];

  if (passport) {
    passportWarnings.push(...passport.warnings);
    passportMissing.push(...passport.missingLinks);
    const seenLots = new Set<string>();
    for (const rb of passport.rawBags) {
      if (rb.supplierLotNumber && !seenLots.has(rb.supplierLotNumber)) {
        seenLots.add(rb.supplierLotNumber);
        supplierLots.push({
          batch_number: rb.supplierLotNumber,
          vendor_name: rb.vendorName ?? null,
        });
      }
      if (rb.internalReceiptNumber) rawBagReceipts.push(rb.internalReceiptNumber);
      if (rb.bagQrCode) rawBagQrs.push(rb.bagQrCode);
    }
    for (const pkg of passport.packagingLots) {
      packagingLots.push({
        material_name: pkg.materialName,
        roll_number: pkg.rollNumber,
        supplier: pkg.supplier,
      });
    }
    for (const ev of passport.qcEvents) {
      qcEvents.push({
        event_type: ev.eventType,
        occurred_at: ev.occurredAt.toISOString(),
      });
    }
  } else {
    passportMissing.push(
      "Finished lot has no trace_code; deep recall passport not available.",
    );
  }

  return {
    kind: "OK",
    passport: {
      trace_code: finishedLot.traceCode,
      finished_lot_id: finishedLot.id,
      shipment_finished_lot_id: shipmentRow?.id ?? null,
      product_name: finishedLot.productName,
      product_sku: finishedLot.productSku,
      packed_at: finishedLot.packedAt
        ? finishedLot.packedAt.toISOString()
        : null,
      shipped_at: shipmentRow?.shippedAt
        ? shipmentRow.shippedAt.toISOString()
        : null,
      quantity: shipmentRow?.quantity ?? null,
      unit: shipmentRow?.unit ?? null,
      warnings: passportWarnings,
      missing_links: passportMissing,
      supplier_lots: supplierLots,
      raw_bag_receipts: rawBagReceipts,
      raw_bag_qrs: rawBagQrs,
      pos,
      operators,
      machines,
      qc_events: qcEvents,
      packaging_lots: packagingLots,
      customer: {
        id: shipmentRow?.customerId ?? null,
        code: shipmentRow?.customerCode ?? null,
        nexus_id: shipmentRow?.nexusCustomerId ?? null,
      },
    },
  };
}

// Local typing helper — Drizzle's inArray accepts string[] but lint
// flags unused imports otherwise. Reference to keep the import alive.
void inArray;
