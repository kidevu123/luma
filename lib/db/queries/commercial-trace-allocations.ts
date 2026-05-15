// COMMERCIAL-TRACE-4 — DB layer for the allocation suggestion engine.
//
// Three responsibilities:
//   - loadInvoiceLineAllocationContext — pull one zoho_invoice_lines row
//     plus its parent invoice's customer / date / number into the pure
//     engine's input shape.
//   - loadFinishedLotCandidatesForInvoiceLine — query the
//     finished_lots ⋈ shipment_finished_lots ⋈ products surface,
//     subtracting already-allocated quantities, and return one
//     FinishedLotAllocationCandidate per (lot, shipment) pair. Used
//     directly by the engine.
//   - writeSuggestedAllocationsForInvoiceLine — persist engine output
//     into finished_lot_invoice_allocations with safe invariants:
//       * never overwrites / never deletes confirmed=true rows
//       * deletes only existing UNCONFIRMED rows for this invoice line
//         that the engine has not re-emitted (idempotent re-run does
//         not duplicate equivalent suggestions)
//       * never marks shipment_finished_lots.invoice_allocation_status
//         as ALLOCATED in this phase — only as SUGGESTED if at least
//         one row references the shipment_finished_lot pair and no
//         confirmed row exists for it yet
//
// Engine is fully pure; this file holds the only DB writes added in
// COMMERCIAL-TRACE-4.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  externalItemMappings,
  finishedLotInvoiceAllocations,
  finishedLots,
  products,
  shipmentFinishedLots,
  shipments,
  zohoInvoiceLines,
  zohoInvoices,
} from "@/lib/db/schema";
import type {
  AllocationInsertRow,
  FinishedLotAllocationCandidate,
  InvoiceLineAllocationInput,
} from "@/lib/production/commercial-trace-allocations";

/** Pull one invoice line + its parent invoice + the resolved customer
 *  mapping into the engine's input shape. Returns null if the line
 *  doesn't exist. */
export async function loadInvoiceLineAllocationContext(
  invoiceLineId: string,
): Promise<{
  input: InvoiceLineAllocationInput;
  zohoCustomerIdToLumaId: Map<string, string>;
} | null> {
  const [row] = await db
    .select({
      lineId: zohoInvoiceLines.id,
      lineQty: zohoInvoiceLines.quantity,
      lineUnit: zohoInvoiceLines.unit,
      lineSku: zohoInvoiceLines.sku,
      lineItemName: zohoInvoiceLines.itemName,
      lineZohoItemId: zohoInvoiceLines.zohoItemId,
      invoiceId: zohoInvoices.id,
      invoiceNumber: zohoInvoices.invoiceNumber,
      invoiceDate: zohoInvoices.invoiceDate,
      invoiceCustomerId: zohoInvoices.customerId,
      invoiceZohoCustomerId: zohoInvoices.zohoCustomerId,
    })
    .from(zohoInvoiceLines)
    .leftJoin(zohoInvoices, eq(zohoInvoices.id, zohoInvoiceLines.zohoInvoiceId))
    .where(eq(zohoInvoiceLines.id, invoiceLineId))
    .limit(1);
  if (!row) return null;

  // Customer lookup map. The engine accepts zohoCustomerIdToLumaId so
  // candidates with a customerId can be cross-matched against the
  // invoice's zoho_customer_id when the invoice's local customerId is
  // null. We load only the relevant pair to keep the map tight.
  const zohoCustomerIdToLumaId = new Map<string, string>();
  if (row.invoiceZohoCustomerId) {
    const [c] = await db
      .select({ id: customers.id, zohoCustomerId: customers.zohoCustomerId })
      .from(customers)
      .where(eq(customers.zohoCustomerId, row.invoiceZohoCustomerId))
      .limit(1);
    if (c?.zohoCustomerId && c.id) {
      zohoCustomerIdToLumaId.set(c.zohoCustomerId, c.id);
    }
  }

  const input: InvoiceLineAllocationInput = {
    invoiceId: row.invoiceId ?? "",
    invoiceNumber: row.invoiceNumber ?? null,
    invoiceDate: row.invoiceDate ?? null,
    customerId: row.invoiceCustomerId ?? null,
    zohoCustomerId: row.invoiceZohoCustomerId ?? null,
    invoiceLineId: row.lineId,
    zohoItemId: row.lineZohoItemId ?? null,
    sku: row.lineSku ?? null,
    itemName: row.lineItemName,
    quantity:
      row.lineQty != null && row.lineQty !== ""
        ? Number(row.lineQty)
        : null,
    unit: row.lineUnit ?? null,
  };

  return { input, zohoCustomerIdToLumaId };
}

/** Load the finished-lot candidate pool for one invoice line. Strategy:
 *    1. Find Luma product candidates by zoho_item_id (direct on products
 *       OR via external_item_mappings) and SKU.
 *    2. For each candidate product, load all shipment_finished_lots rows
 *       for that product's finished_lots — these are the (lot, shipment)
 *       pairs the engine ranks.
 *    3. Subtract existing CONFIRMED allocations for each pair so the
 *       engine sees the true remaining-available quantity.
 *
 *  When the invoice line has no zoho_item_id AND no SKU, returns []
 *  (the engine emits a NEEDS_REVIEW row).
 *
 *  When `restrictToInvoiceCustomer` is true (default), candidates are
 *  pre-filtered by the invoice's customerId/zohoCustomerId so the
 *  engine doesn't scan the whole shipment table for a small invoice.
 *  Pass false in tests that want to verify customer mismatching. */
export async function loadFinishedLotCandidatesForInvoiceLine(opts: {
  invoiceLine: InvoiceLineAllocationInput;
  restrictToInvoiceCustomer?: boolean;
}): Promise<FinishedLotAllocationCandidate[]> {
  const { invoiceLine } = opts;
  const restrict = opts.restrictToInvoiceCustomer ?? true;

  const directProductIds = new Set<string>();
  const productMatchedViaExternal = new Set<string>();

  // (a) products.zoho_item_id direct match.
  if (invoiceLine.zohoItemId) {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.zohoItemId, invoiceLine.zohoItemId));
    for (const r of rows) directProductIds.add(r.id);
  }

  // (b) external_item_mappings match.
  if (invoiceLine.zohoItemId) {
    const rows = await db
      .select({ productId: externalItemMappings.lumaProductId })
      .from(externalItemMappings)
      .where(
        and(
          eq(externalItemMappings.externalItemId, invoiceLine.zohoItemId),
          eq(externalItemMappings.isActive, true),
          isNotNull(externalItemMappings.lumaProductId),
        ),
      );
    for (const r of rows) {
      if (r.productId) {
        productMatchedViaExternal.add(r.productId);
      }
    }
  }

  // (c) SKU match.
  if (invoiceLine.sku) {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, invoiceLine.sku));
    for (const r of rows) directProductIds.add(r.id);
  }

  const productIds = new Set<string>([
    ...directProductIds,
    ...productMatchedViaExternal,
  ]);
  if (productIds.size === 0) return [];

  // Build candidate rows. One row per (finished_lot, shipment_finished_lot)
  // pair so the engine can rank shipments independently. Also include
  // lots without shipments yet — they may still be allocation targets
  // for invoices that ship in the future (rare but legal).
  const productIdsArray = Array.from(productIds);

  const rows = await db
    .select({
      finishedLotId: finishedLots.id,
      productId: finishedLots.productId,
      productZohoItemId: products.zohoItemId,
      productSku: products.sku,
      traceCode: finishedLots.traceCode,
      packedAt: finishedLots.packedAt,
      finishedLotUnitsProduced: finishedLots.unitsProduced,
      sfl_id: shipmentFinishedLots.id,
      sfl_customer_id: shipmentFinishedLots.customerId,
      sfl_quantity: shipmentFinishedLots.quantity,
      sfl_unit: shipmentFinishedLots.unit,
      sfl_shipped_at: shipmentFinishedLots.shippedAt,
      sfl_invoice_allocation_status: shipmentFinishedLots.invoiceAllocationStatus,
      ship_shipped_at: shipments.shippedAt,
    })
    .from(finishedLots)
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(
      shipmentFinishedLots,
      eq(shipmentFinishedLots.finishedLotId, finishedLots.id),
    )
    .leftJoin(shipments, eq(shipments.id, shipmentFinishedLots.shipmentId))
    .where(inArray(finishedLots.productId, productIdsArray));

  // Sum existing allocations per (finished_lot, shipment_finished_lot)
  // pair so the engine can subtract them. We treat any allocation row
  // as already claimed quantity (engine should not double-suggest the
  // same units). REJECTED rows are excluded — they don't hold quantity.
  const finishedLotIds = rows.map((r) => r.finishedLotId);
  const allocSums =
    finishedLotIds.length === 0
      ? []
      : await db
          .select({
            shipmentFinishedLotId:
              finishedLotInvoiceAllocations.shipmentFinishedLotId,
            finishedLotId: finishedLotInvoiceAllocations.finishedLotId,
            total: sql<string>`SUM(${finishedLotInvoiceAllocations.quantityAllocated})`,
          })
          .from(finishedLotInvoiceAllocations)
          .where(
            and(
              inArray(
                finishedLotInvoiceAllocations.finishedLotId,
                finishedLotIds,
              ),
              sql`${finishedLotInvoiceAllocations.status} <> 'REJECTED'`,
            ),
          )
          .groupBy(
            finishedLotInvoiceAllocations.shipmentFinishedLotId,
            finishedLotInvoiceAllocations.finishedLotId,
          );

  const allocByPair = new Map<string, number>();
  for (const a of allocSums) {
    const key = `${a.finishedLotId}::${a.shipmentFinishedLotId ?? ""}`;
    allocByPair.set(key, Number(a.total ?? 0));
  }

  const candidates: FinishedLotAllocationCandidate[] = [];
  for (const r of rows) {
    if (restrict && r.sfl_customer_id) {
      const matchesById =
        invoiceLine.customerId != null &&
        r.sfl_customer_id === invoiceLine.customerId;
      const matchesViaZoho = false; // handled by zoho map at engine layer
      if (!matchesById && !matchesViaZoho && invoiceLine.customerId != null) {
        // Pre-filter: skip lots shipped to a different Luma customer
        // when we know the invoice's customer for sure.
        continue;
      }
    }

    const matchedViaExternalMapping =
      r.productId != null && productMatchedViaExternal.has(r.productId);
    const pairKey = `${r.finishedLotId}::${r.sfl_id ?? ""}`;
    const already = allocByPair.get(pairKey) ?? 0;
    const available =
      r.sfl_quantity != null
        ? Number(r.sfl_quantity)
        : r.finishedLotUnitsProduced != null
          ? Number(r.finishedLotUnitsProduced)
          : null;

    candidates.push({
      finishedLotId: r.finishedLotId,
      shipmentFinishedLotId: r.sfl_id,
      customerId: r.sfl_customer_id ?? null,
      productId: r.productId ?? null,
      zohoItemId: r.productZohoItemId ?? null,
      sku: r.productSku ?? null,
      traceCode: r.traceCode ?? null,
      quantityAvailable: available,
      unit: r.sfl_unit ?? null,
      packedAt: r.packedAt ?? null,
      shippedAt: r.sfl_shipped_at ?? r.ship_shipped_at ?? null,
      alreadyAllocatedQuantity: already,
      invoiceAllocationStatus: r.sfl_invoice_allocation_status ?? null,
      matchedViaExternalMapping,
    });
  }

  return candidates;
}

/** Persist engine output for one invoice line. Behavior contract:
 *    - Never deletes CONFIRMED rows.
 *    - Deletes any existing UNCONFIRMED rows for this invoice line first
 *      (so a re-run of the engine never accumulates stale suggestions).
 *    - Inserts the new suggestion rows.
 *    - For each shipment_finished_lots pair touched, sets
 *      invoice_allocation_status='SUGGESTED' + last_invoice_allocation_at=now()
 *      ONLY IF the row's current status is 'UNALLOCATED'. Never demotes
 *      ALLOCATED / CONFIRMED states from a later phase.
 *    - Wrapped in a transaction so partial writes never land.
 *
 *  Returns { inserted, cleared, shipmentRowsUpdated }. */
export async function writeSuggestedAllocationsForInvoiceLine(
  invoiceLineId: string,
  rows: ReadonlyArray<AllocationInsertRow>,
): Promise<{
  inserted: number;
  cleared: number;
  shipmentRowsUpdated: number;
}> {
  return db.transaction(async (tx) => {
    // Clear existing UNCONFIRMED rows (confirmed=false). Confirmed rows
    // stay untouched.
    const deleted = await tx
      .delete(finishedLotInvoiceAllocations)
      .where(
        and(
          eq(finishedLotInvoiceAllocations.invoiceLineId, invoiceLineId),
          eq(finishedLotInvoiceAllocations.confirmed, false),
        ),
      )
      .returning({ id: finishedLotInvoiceAllocations.id });

    let inserted = 0;
    if (rows.length > 0) {
      const values = rows.map((r) => ({
        invoiceLineId: r.invoiceLineId,
        finishedLotId: r.finishedLotId,
        shipmentFinishedLotId: r.shipmentFinishedLotId,
        quantityAllocated: r.quantityAllocated,
        unit: r.unit,
        confidence: r.confidence,
        source: r.source,
        status: r.status,
        confirmed: r.confirmed,
        confirmedByUserId: r.confirmedByUserId,
        confirmedAt: r.confirmedAt,
        notes: r.notes,
      }));
      const insertedRows = await tx
        .insert(finishedLotInvoiceAllocations)
        .values(values)
        .returning({ id: finishedLotInvoiceAllocations.id });
      inserted = insertedRows.length;
    }

    // Bump shipment_finished_lots.invoice_allocation_status to SUGGESTED
    // for any pair we touched — but only when it was UNALLOCATED.
    const touchedShipmentIds = Array.from(
      new Set(
        rows
          .map((r) => r.shipmentFinishedLotId)
          .filter((id): id is string => typeof id === "string"),
      ),
    );
    let shipmentRowsUpdated = 0;
    if (touchedShipmentIds.length > 0) {
      const updated = await tx
        .update(shipmentFinishedLots)
        .set({
          invoiceAllocationStatus: "SUGGESTED",
          lastInvoiceAllocationAt: new Date(),
        })
        .where(
          and(
            inArray(shipmentFinishedLots.id, touchedShipmentIds),
            eq(shipmentFinishedLots.invoiceAllocationStatus, "UNALLOCATED"),
          ),
        )
        .returning({ id: shipmentFinishedLots.id });
      shipmentRowsUpdated = updated.length;
    }

    return {
      inserted,
      cleared: deleted.length,
      shipmentRowsUpdated,
    };
  });
}

/** Delete all unconfirmed suggestions for an invoice line. Confirmed
 *  rows are not touched. Used by the (future) "regenerate" flow. */
export async function clearUnconfirmedSuggestionsForInvoiceLine(
  invoiceLineId: string,
): Promise<number> {
  const deleted = await db
    .delete(finishedLotInvoiceAllocations)
    .where(
      and(
        eq(finishedLotInvoiceAllocations.invoiceLineId, invoiceLineId),
        eq(finishedLotInvoiceAllocations.confirmed, false),
      ),
    )
    .returning({ id: finishedLotInvoiceAllocations.id });
  return deleted.length;
}
