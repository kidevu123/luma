// LOT-1D — recall-passport loaders for /recall.
//
// Two entry points:
//   - getRecallPassport({searchKind, searchValue, dateFrom?, dateTo?})
//       single-row-style lookup that returns the full recall passport
//       for whatever the user typed (supplier lot, internal receipt
//       number, raw-bag QR, finished-lot trace code, product+date,
//       customer+date).
//   - getForwardTrace({supplierLotNumber})
//       inverse: which customers received product made from this lot.
//
// Both are read-only against the LOT-1B / LOT-1C tables. Never invent
// data; missing links surface as warnings.

import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  customers,
  finishedLotOutputs,
  finishedLotPackagingLots,
  finishedLotQcEvents,
  finishedLotRawBags,
  finishedLots,
  inventoryBags,
  packagingLots,
  packagingMaterials,
  products,
  receives,
  shipmentFinishedLots,
  shipments,
  smallBoxes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import {
  rollupRecallConfidence,
  type RecallConfidence,
} from "./recall-passport";

// ─── Types ────────────────────────────────────────────────────────────

export type RecallSearchKind =
  | "supplier_lot"
  | "internal_receipt_number"
  | "raw_bag_qr"
  | "finished_lot_trace_code"
  | "product_date_range"
  | "customer_date_range";

export type RecallSearchInput =
  | { kind: "supplier_lot"; value: string }
  | { kind: "internal_receipt_number"; value: string }
  | { kind: "raw_bag_qr"; value: string }
  | { kind: "finished_lot_trace_code"; value: string }
  | { kind: "product_date_range"; productId: string; fromDate: string; toDate: string }
  | { kind: "customer_date_range"; customerId: string; fromDate: string; toDate: string };

export type RawBagRow = {
  id: string;
  bagNumber: number;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  declaredPillCount: number | null;
  pillCount: number | null;
  weightGrams: number | null;
  vendorBarcode: string | null;
  status: string;
  notes: string | null;
  batchId: string | null;
  batchNumber: string | null;
  supplierLotNumber: string | null;
  vendorName: string | null;
  smallBoxId: string;
  boxNumber: number | null;
  receiveId: string | null;
  receiveName: string | null;
  receivedAt: Date | null;
};

export type FinishedLotRow = {
  id: string;
  finishedLotNumber: string;
  traceCode: string | null;
  finishedLotCodeAlias: string | null;
  productId: string;
  productName: string | null;
  productSku: string | null;
  producedOn: string;
  packedAt: Date | null;
  expiresAt: Date | null;
  unitsProduced: number;
  displaysProduced: number | null;
  casesProduced: number | null;
  status: string;
  workflowBagId: string | null;
};

export type WorkflowBagRow = {
  id: string;
  receiptNumber: string | null;
  boxNumber: number | null;
  bagNumber: number | null;
  startedAt: Date;
  finalizedAt: Date | null;
  productId: string | null;
  inventoryBagId: string | null;
};

export type OutputRow = {
  id: string;
  finishedLotId: string;
  outputType: string;
  quantity: number;
  unit: string;
  traceCodePrinted: string | null;
  printPayload: Record<string, unknown>;
};

export type PackagingLotRow = {
  id: string;
  finishedLotId: string;
  packagingLotId: string;
  materialId: string | null;
  materialName: string | null;
  materialKind: string | null;
  rollNumber: string | null;
  supplier: string | null;
  supplierLotNumber: string | null;
  quantityUsed: number | null;
  unit: string | null;
  confidence: RecallConfidence;
  source: string;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
};

export type QcEventRow = {
  id: string;
  finishedLotId: string;
  workflowEventId: string;
  eventType: string;
  occurredAt: Date;
};

export type ShipmentLink = {
  id: string;
  shipmentId: string;
  finishedLotId: string;
  customerId: string | null;
  customerCode: string | null;
  customerName: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  quantity: number | null;
  unit: string | null;
  shippedAt: Date | null;
};

export type RecallPassport = {
  searchInput: RecallSearchInput;
  rawBags: RawBagRow[];
  finishedLots: FinishedLotRow[];
  workflowBags: WorkflowBagRow[];
  outputs: OutputRow[];
  packagingLots: PackagingLotRow[];
  qcEvents: QcEventRow[];
  shipmentLinks: ShipmentLink[];
  confidence: RecallConfidence;
  warnings: string[];
  /** Things the search expected but couldn't find. Each entry is a
   *  human-readable note, e.g. "no customer linkage recorded". Never
   *  filled with fake data. */
  missingLinks: string[];
};

export type ForwardTraceResult = {
  supplierLotNumber: string;
  rawBags: RawBagRow[];
  finishedLots: FinishedLotRow[];
  shipmentLinks: ShipmentLink[];
  customers: Array<{
    id: string;
    customerCode: string;
    name: string;
  }>;
  warnings: string[];
};

// ─── Helpers (small) ──────────────────────────────────────────────────

function emptyPassport(input: RecallSearchInput): RecallPassport {
  return {
    searchInput: input,
    rawBags: [],
    finishedLots: [],
    workflowBags: [],
    outputs: [],
    packagingLots: [],
    qcEvents: [],
    shipmentLinks: [],
    confidence: "MISSING",
    warnings: [],
    missingLinks: [],
  };
}

function dedupeBy<T>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ─── Raw-bag fetchers ────────────────────────────────────────────────

async function fetchRawBagsByIds(ids: string[]): Promise<RawBagRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      weightGrams: inventoryBags.weightGrams,
      vendorBarcode: inventoryBags.vendorBarcode,
      status: inventoryBags.status,
      notes: inventoryBags.notes,
      batchId: inventoryBags.batchId,
      batchNumber: batches.batchNumber,
      supplierLotNumber: batches.vendorLotNumber,
      vendorName: batches.vendorName,
      smallBoxId: inventoryBags.smallBoxId,
      boxNumber: smallBoxes.boxNumber,
      receiveId: smallBoxes.receiveId,
      receiveName: receives.receiveName,
      receivedAt: receives.receivedAt,
    })
    .from(inventoryBags)
    .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
    .leftJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .leftJoin(receives, eq(smallBoxes.receiveId, receives.id))
    .where(inArray(inventoryBags.id, ids));
  return rows as RawBagRow[];
}

async function fetchFinishedLotsByIds(
  ids: string[],
): Promise<FinishedLotRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: finishedLots.id,
      finishedLotNumber: finishedLots.finishedLotNumber,
      traceCode: finishedLots.traceCode,
      finishedLotCodeAlias: finishedLots.finishedLotCodeAlias,
      productId: finishedLots.productId,
      productName: products.name,
      productSku: products.sku,
      producedOn: finishedLots.producedOn,
      packedAt: finishedLots.packedAt,
      expiresAt: finishedLots.expiresAt,
      unitsProduced: finishedLots.unitsProduced,
      displaysProduced: finishedLots.displaysProduced,
      casesProduced: finishedLots.casesProduced,
      status: finishedLots.status,
      workflowBagId: finishedLots.workflowBagId,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(inArray(finishedLots.id, ids));
  return rows as FinishedLotRow[];
}

async function fetchWorkflowBagsByIds(
  ids: string[],
): Promise<WorkflowBagRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: workflowBags.id,
      receiptNumber: workflowBags.receiptNumber,
      boxNumber: workflowBags.boxNumber,
      bagNumber: workflowBags.bagNumber,
      startedAt: workflowBags.startedAt,
      finalizedAt: workflowBags.finalizedAt,
      productId: workflowBags.productId,
      inventoryBagId: workflowBags.inventoryBagId,
    })
    .from(workflowBags)
    .where(inArray(workflowBags.id, ids));
  return rows;
}

async function fetchOutputsByLotIds(
  lotIds: string[],
): Promise<OutputRow[]> {
  if (lotIds.length === 0) return [];
  const rows = await db
    .select({
      id: finishedLotOutputs.id,
      finishedLotId: finishedLotOutputs.finishedLotId,
      outputType: finishedLotOutputs.outputType,
      quantity: finishedLotOutputs.quantity,
      unit: finishedLotOutputs.unit,
      traceCodePrinted: finishedLotOutputs.traceCodePrinted,
      printPayload: finishedLotOutputs.printPayload,
    })
    .from(finishedLotOutputs)
    .where(inArray(finishedLotOutputs.finishedLotId, lotIds));
  return rows.map((r) => ({
    ...r,
    printPayload: (r.printPayload as Record<string, unknown>) ?? {},
  }));
}

async function fetchPackagingLotsByLotIds(
  lotIds: string[],
): Promise<PackagingLotRow[]> {
  if (lotIds.length === 0) return [];
  const rows = await db
    .select({
      id: finishedLotPackagingLots.id,
      finishedLotId: finishedLotPackagingLots.finishedLotId,
      packagingLotId: finishedLotPackagingLots.packagingLotId,
      materialId: finishedLotPackagingLots.materialId,
      materialName: packagingMaterials.name,
      materialKind: packagingMaterials.kind,
      rollNumber: packagingLots.rollNumber,
      supplier: packagingLots.supplier,
      supplierLotNumber: packagingLots.supplierLotNumber,
      quantityUsed: finishedLotPackagingLots.quantityUsed,
      unit: finishedLotPackagingLots.unit,
      confidence: finishedLotPackagingLots.confidence,
      source: finishedLotPackagingLots.source,
      firstUsedAt: finishedLotPackagingLots.firstUsedAt,
      lastUsedAt: finishedLotPackagingLots.lastUsedAt,
    })
    .from(finishedLotPackagingLots)
    .leftJoin(
      packagingLots,
      eq(finishedLotPackagingLots.packagingLotId, packagingLots.id),
    )
    .leftJoin(
      packagingMaterials,
      eq(finishedLotPackagingLots.materialId, packagingMaterials.id),
    )
    .where(inArray(finishedLotPackagingLots.finishedLotId, lotIds));
  return rows.map((r) => ({
    ...r,
    quantityUsed: r.quantityUsed != null ? Number(r.quantityUsed) : null,
    confidence: (r.confidence as RecallConfidence) ?? "MISSING",
  }));
}

async function fetchQcEventsByLotIds(
  lotIds: string[],
): Promise<QcEventRow[]> {
  if (lotIds.length === 0) return [];
  const rows = await db
    .select({
      id: finishedLotQcEvents.id,
      finishedLotId: finishedLotQcEvents.finishedLotId,
      workflowEventId: finishedLotQcEvents.workflowEventId,
      eventType: finishedLotQcEvents.eventType,
      occurredAt: finishedLotQcEvents.occurredAt,
    })
    .from(finishedLotQcEvents)
    .where(inArray(finishedLotQcEvents.finishedLotId, lotIds));
  return rows;
}

async function fetchShipmentsByLotIds(
  lotIds: string[],
): Promise<ShipmentLink[]> {
  if (lotIds.length === 0) return [];
  const rows = await db
    .select({
      id: shipmentFinishedLots.id,
      shipmentId: shipmentFinishedLots.shipmentId,
      finishedLotId: shipmentFinishedLots.finishedLotId,
      customerId: shipmentFinishedLots.customerId,
      customerCode: customers.customerCode,
      customerName: customers.name,
      carrier: shipments.carrier,
      trackingNumber: shipments.trackingNumber,
      quantity: shipmentFinishedLots.quantity,
      unit: shipmentFinishedLots.unit,
      shippedAt: shipmentFinishedLots.shippedAt,
    })
    .from(shipmentFinishedLots)
    .leftJoin(shipments, eq(shipmentFinishedLots.shipmentId, shipments.id))
    .leftJoin(customers, eq(shipmentFinishedLots.customerId, customers.id))
    .where(inArray(shipmentFinishedLots.finishedLotId, lotIds));
  return rows;
}

// Map a list of raw-bag ids to the finished-lot ids that consumed them
// (per LOT-1C's finished_lot_raw_bags projection).
async function finishedLotIdsForRawBags(
  bagIds: string[],
): Promise<Array<{ inventoryBagId: string; finishedLotId: string; confidence: RecallConfidence }>> {
  if (bagIds.length === 0) return [];
  const rows = await db
    .select({
      finishedLotId: finishedLotRawBags.finishedLotId,
      inventoryBagId: finishedLotRawBags.inventoryBagId,
      confidence: finishedLotRawBags.confidence,
    })
    .from(finishedLotRawBags)
    .where(inArray(finishedLotRawBags.inventoryBagId, bagIds));
  return rows.map((r) => ({
    ...r,
    confidence: (r.confidence as RecallConfidence) ?? "MISSING",
  }));
}

// Map a list of finished-lot ids back to all contributing raw-bag ids.
async function rawBagIdsForFinishedLots(
  lotIds: string[],
): Promise<Array<{ finishedLotId: string; inventoryBagId: string; workflowBagId: string | null; confidence: RecallConfidence }>> {
  if (lotIds.length === 0) return [];
  const rows = await db
    .select({
      finishedLotId: finishedLotRawBags.finishedLotId,
      inventoryBagId: finishedLotRawBags.inventoryBagId,
      workflowBagId: finishedLotRawBags.workflowBagId,
      confidence: finishedLotRawBags.confidence,
    })
    .from(finishedLotRawBags)
    .where(inArray(finishedLotRawBags.finishedLotId, lotIds));
  return rows.map((r) => ({
    ...r,
    confidence: (r.confidence as RecallConfidence) ?? "MISSING",
  }));
}

// ─── Single-axis resolvers ───────────────────────────────────────────

async function resolveBySupplierLot(value: string): Promise<string[]> {
  // Match canonical and operator-typed (case-insensitive) values.
  const v = value.trim();
  if (v.length === 0) return [];
  const matches = await db
    .select({ id: inventoryBags.id })
    .from(inventoryBags)
    .innerJoin(batches, eq(inventoryBags.batchId, batches.id))
    .where(
      or(
        eq(batches.vendorLotNumber, v),
        ilike(batches.vendorLotNumber, `%${v}%`),
      ),
    );
  return matches.map((m) => m.id);
}

async function resolveByInternalReceipt(value: string): Promise<string[]> {
  const v = value.trim();
  if (v.length === 0) return [];
  const matches = await db
    .select({ id: inventoryBags.id })
    .from(inventoryBags)
    .where(
      or(
        eq(inventoryBags.internalReceiptNumber, v),
        ilike(inventoryBags.internalReceiptNumber, `%${v}%`),
      ),
    );
  return matches.map((m) => m.id);
}

async function resolveByBagQr(value: string): Promise<string[]> {
  const v = value.trim();
  if (v.length === 0) return [];
  const matches = await db
    .select({ id: inventoryBags.id })
    .from(inventoryBags)
    .where(eq(inventoryBags.bagQrCode, v));
  return matches.map((m) => m.id);
}

async function resolveByTraceCode(value: string): Promise<string[]> {
  const v = value.trim();
  if (v.length === 0) return [];
  const matches = await db
    .select({ id: finishedLots.id })
    .from(finishedLots)
    .where(
      or(
        eq(finishedLots.traceCode, v),
        eq(finishedLots.finishedLotNumber, v),
        eq(finishedLots.finishedLotCodeAlias, v),
      ),
    );
  return matches.map((m) => m.id);
}

async function resolveByProductDate(
  productId: string,
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  const matches = await db
    .select({ id: finishedLots.id })
    .from(finishedLots)
    .where(
      and(
        eq(finishedLots.productId, productId),
        gte(finishedLots.producedOn, fromDate),
        lte(finishedLots.producedOn, toDate),
      ),
    )
    .orderBy(desc(finishedLots.producedOn));
  return matches.map((m) => m.id);
}

async function resolveByCustomerDate(
  customerId: string,
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  const matches = await db
    .select({ finishedLotId: shipmentFinishedLots.finishedLotId })
    .from(shipmentFinishedLots)
    .where(
      and(
        eq(shipmentFinishedLots.customerId, customerId),
        gte(shipmentFinishedLots.shippedAt, new Date(fromDate)),
        lte(shipmentFinishedLots.shippedAt, new Date(toDate)),
      ),
    );
  return Array.from(new Set(matches.map((m) => m.finishedLotId)));
}

// ─── Public API ──────────────────────────────────────────────────────

export async function getRecallPassport(
  input: RecallSearchInput,
): Promise<RecallPassport> {
  // Step 1 — translate the search axis into (rawBagIds, finishedLotIds).
  let rawBagIds: string[] = [];
  let finishedLotIdsFromInput: string[] = [];
  switch (input.kind) {
    case "supplier_lot":
      rawBagIds = await resolveBySupplierLot(input.value);
      break;
    case "internal_receipt_number":
      rawBagIds = await resolveByInternalReceipt(input.value);
      break;
    case "raw_bag_qr":
      rawBagIds = await resolveByBagQr(input.value);
      break;
    case "finished_lot_trace_code":
      finishedLotIdsFromInput = await resolveByTraceCode(input.value);
      break;
    case "product_date_range":
      finishedLotIdsFromInput = await resolveByProductDate(
        input.productId,
        input.fromDate,
        input.toDate,
      );
      break;
    case "customer_date_range":
      finishedLotIdsFromInput = await resolveByCustomerDate(
        input.customerId,
        input.fromDate,
        input.toDate,
      );
      break;
  }

  if (rawBagIds.length === 0 && finishedLotIdsFromInput.length === 0) {
    return emptyPassport(input);
  }

  // Step 2 — bidirectional expansion.
  const bagToLot = await finishedLotIdsForRawBags(rawBagIds);
  const fromBagFinishedLotIds = bagToLot.map((b) => b.finishedLotId);
  const allLotIds = Array.from(
    new Set([...finishedLotIdsFromInput, ...fromBagFinishedLotIds]),
  );

  const lotToBag = await rawBagIdsForFinishedLots(allLotIds);
  const allRawBagIds = Array.from(
    new Set([...rawBagIds, ...lotToBag.map((l) => l.inventoryBagId)]),
  );

  // Step 3 — fan-out fetches in parallel.
  const [rawBags, lots, workflowBagsFromLinks, outputs, packagingLotsRows, qcEvents, shipmentLinks] =
    await Promise.all([
      fetchRawBagsByIds(allRawBagIds),
      fetchFinishedLotsByIds(allLotIds),
      (async () => {
        const wfIds = Array.from(
          new Set(lotToBag.map((l) => l.workflowBagId).filter((x): x is string => !!x)),
        );
        const fromLot = (await db
          .select({ workflowBagId: finishedLots.workflowBagId })
          .from(finishedLots)
          .where(inArray(finishedLots.id, allLotIds))).map((r) => r.workflowBagId)
          .filter((x): x is string => !!x);
        return fetchWorkflowBagsByIds(Array.from(new Set([...wfIds, ...fromLot])));
      })(),
      fetchOutputsByLotIds(allLotIds),
      fetchPackagingLotsByLotIds(allLotIds),
      fetchQcEventsByLotIds(allLotIds),
      fetchShipmentsByLotIds(allLotIds),
    ]);

  // Step 4 — warnings + confidence rollup.
  const warnings: string[] = [];
  const missingLinks: string[] = [];

  for (const b of rawBags) {
    if (b.bagQrCode == null) {
      warnings.push(
        `Bag ${b.internalReceiptNumber ?? b.id.slice(0, 8)}: legacy raw-bag QR missing — recall lookup is using receipt/bag identity.`,
      );
    }
  }
  if (lots.length > 0 && shipmentLinks.length === 0) {
    missingLinks.push(
      "No shipment / customer linkage recorded yet for any of the matched finished lots.",
    );
  }
  if (rawBagIds.length === 0 && lotToBag.length === 0 && allLotIds.length > 0) {
    missingLinks.push(
      "Matched finished lot(s) have no raw-bag linkage recorded — projector hasn't run or upstream chain is incomplete.",
    );
  }

  const confidenceEdges: RecallConfidence[] = [
    ...bagToLot.map((b) => b.confidence),
    ...lotToBag.map((l) => l.confidence),
    ...packagingLotsRows.map((p) => p.confidence),
  ];
  const confidence: RecallConfidence =
    confidenceEdges.length > 0
      ? rollupRecallConfidence(confidenceEdges)
      : "MISSING";

  return {
    searchInput: input,
    rawBags: dedupeBy(rawBags, (r) => r.id),
    finishedLots: dedupeBy(lots, (r) => r.id),
    workflowBags: dedupeBy(workflowBagsFromLinks, (r) => r.id),
    outputs: dedupeBy(outputs, (r) => r.id),
    packagingLots: dedupeBy(packagingLotsRows, (r) => r.id),
    qcEvents: dedupeBy(qcEvents, (r) => r.id),
    shipmentLinks: dedupeBy(shipmentLinks, (r) => r.id),
    confidence,
    warnings: dedupeBy(warnings, (w) => w),
    missingLinks: dedupeBy(missingLinks, (m) => m),
  };
}

export async function getForwardTrace(args: {
  supplierLotNumber: string;
}): Promise<ForwardTraceResult> {
  const bagIds = await resolveBySupplierLot(args.supplierLotNumber);
  const bagToLot = await finishedLotIdsForRawBags(bagIds);
  const finishedLotIds = Array.from(
    new Set(bagToLot.map((b) => b.finishedLotId)),
  );
  const [bags, lots, shipments] = await Promise.all([
    fetchRawBagsByIds(bagIds),
    fetchFinishedLotsByIds(finishedLotIds),
    fetchShipmentsByLotIds(finishedLotIds),
  ]);
  const customerIds = Array.from(
    new Set(
      shipments
        .map((s) => s.customerId)
        .filter((id): id is string => id != null),
    ),
  );
  let customerRows: Array<{ id: string; customerCode: string; name: string }> = [];
  if (customerIds.length > 0) {
    customerRows = await db
      .select({
        id: customers.id,
        customerCode: customers.customerCode,
        name: customers.name,
      })
      .from(customers)
      .where(inArray(customers.id, customerIds));
  }
  const warnings: string[] = [];
  if (bagIds.length > 0 && finishedLotIds.length === 0) {
    warnings.push(
      "Matched raw bag(s) have no finished-lot linkage yet — production hasn't finalised these into recall-projected lots.",
    );
  }
  if (finishedLotIds.length > 0 && shipments.length === 0) {
    warnings.push(
      "Matched finished lot(s) have no shipment / customer linkage recorded yet.",
    );
  }
  return {
    supplierLotNumber: args.supplierLotNumber,
    rawBags: bags,
    finishedLots: lots,
    shipmentLinks: shipments,
    customers: customerRows,
    warnings,
  };
}

/** Suppress drizzle's unused-import warning for `sql` if a future
 *  resolver path needs raw SQL. */
void sql;
void workflowEvents;
