// ZOHO-ASSY-2 — Read-only dry-run planner for Zoho assembly operations.
//
// Returns a full plan (with status previews + payload shapes) without
// writing anything to the DB or calling Zoho.
//
// Two execution modes:
//   planZohoAssemblyForFinishedLot(id)  — DB entry point (production use)
//   computeZohoAssemblyPlan(inputs)     — pure function (unit-testable)
//
// Source resolution — two paths:
//
//   LEDGER:   raw_bag_allocation_sessions (preferred, allocation_status IN ('CLOSED','DEPLETED'))
//     Match finished_lot_id first; when unset on sessions, fall back to
//     finished_lots.workflow_bag_id → raw_bag_allocation_sessions.workflow_bag_id.
//     inventory_bag → small_box → receive → po_line → zoho_line_item_id
//     allocation_session.po_id → purchase_order → zoho_po_id
//
//   FALLBACK: finished_lot_inputs → batches (when no closed allocation sessions)
//     Cannot resolve po_line; all TABLET_RECEIVE ops are NEEDS_MAPPING.
//
//   NONE:     No tablet source records found.
//
// Status rules:
//   TABLET_RECEIVE — READY when tablet type + PO + PO line all have Zoho IDs.
//   Assembly op   — SKIPPED when qty = 0.
//                   NEEDS_MAPPING when product Zoho item ID missing, OR any
//                   BOM material for that scope lacks a Zoho item ID.
//                   READY otherwise.
// BLOCKED is not emitted by the dry-run planner (runtime scheduler concern).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  products,
  rawBagAllocationSessions,
  inventoryBags,
  tabletTypes,
  smallBoxes,
  receives,
  poLines,
  purchaseOrders,
  finishedLotInputs,
  batches,
  productPackagingSpecs,
  packagingMaterials,
} from "@/lib/db/schema";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ZohoAssemblyStatusPreview = "READY" | "NEEDS_MAPPING" | "SKIPPED" | "BLOCKED";

/** One packaging material in the BOM for an assembly op level. */
export type BomLine = {
  materialId:   string;
  materialName: string;
  zohoItemId:   string | null;
  qtyPerUnit:   number;
  expectedQty:  number;       // qtyPerUnit * assembly op quantity
  issue:        string | null; // null when OK; reason string when not
};

export type ZohoReceivePayloadPreview = {
  zohoPoId:       string | null;
  zohoLineItemId: string | null;
  quantity:       number;
};

export type ZohoAssemblyPayloadPreview = {
  zohoItemId: string | null;
  quantity:   number;
};

export type PlanTabletReceiveOp = {
  opKind:               "TABLET_RECEIVE";
  opSequence:           1;
  idempotencyKey:       string;
  sourceInventoryBagId: string | null;
  sourcePoLineId:       string | null;
  sourceTabletTypeId:   string | null;
  tabletTypeName:       string | null;
  zohoTabletItemId:     string | null;
  zohoPoId:             string | null;
  zohoLineItemId:       string | null;
  quantity:             number;
  componentRole:        string | null;
  statusPreview:        ZohoAssemblyStatusPreview;
  statusReason:         string | null;
  payloadPreview:       ZohoReceivePayloadPreview;
};

export type PlanAssemblyOp = {
  opKind:         "UNIT_ASSEMBLE" | "DISPLAY_ASSEMBLE" | "CASE_ASSEMBLE";
  opSequence:     2 | 3 | 4;
  idempotencyKey: string;
  zohoItemId:     string | null;
  quantity:       number;
  statusPreview:  ZohoAssemblyStatusPreview;
  statusReason:   string | null;
  bomLines:       BomLine[];
  payloadPreview: ZohoAssemblyPayloadPreview;
};

export type PlanOp = PlanTabletReceiveOp | PlanAssemblyOp;

export type ZohoAssemblyPlanResult = {
  finishedLotId:    string;
  finishedLotNumber: string;
  product: {
    id:                string;
    name:              string;
    sku:               string;
    kind:              string;
    zohoItemIdUnit:    string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase:    string | null;
  } | null;
  ops:           PlanOp[];
  sourceMethod:  "LEDGER" | "FALLBACK" | "NONE";
  overallStatus: ZohoAssemblyStatusPreview;
  issues:        string[];
};

// ─── Input types for the pure computation (exported for tests) ────────────────

export type PlannerLedgerRow = {
  inventoryBagId:   string;
  consumedQty:      number | null;
  tabletTypeId:     string;
  tabletZohoItemId: string | null;
  tabletName:       string;
  receivePoLineId:  string | null;
  zohoLineItemId:   string | null;
  zohoPoId:         string | null;
  componentRole:    string | null;
};

export type PlannerFallbackRow = {
  batchId:          string;
  qtyConsumed:      number;
  tabletTypeId:     string | null;
  tabletName:       string | null;
  tabletZohoItemId: string | null;
};

export type PlannerBomRow = {
  perScope:           string;
  materialId:         string;
  materialName:       string;
  materialZohoItemId: string | null;
  qtyPerUnit:         number;
};

export type PlannerRawInputs = {
  finishedLotId:    string;
  finishedLotNumber: string;
  unitsProduced:    number;
  displaysProduced: number | null;
  casesProduced:    number | null;
  product: {
    id:                string;
    name:              string;
    sku:               string;
    kind:              string;
    zohoItemIdUnit:    string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase:    string | null;
  } | null;
  ledgerRows:   PlannerLedgerRow[];
  fallbackRows: PlannerFallbackRow[];
  bomRows:      PlannerBomRow[];
};

// ─── Pure computation (no DB, fully unit-testable) ────────────────────────────

export function computeZohoAssemblyPlan(
  inputs: PlannerRawInputs,
): ZohoAssemblyPlanResult {
  const {
    finishedLotId, finishedLotNumber, product,
    unitsProduced, displaysProduced, casesProduced,
    ledgerRows, fallbackRows, bomRows,
  } = inputs;

  const issues: string[] = [];
  const ops: PlanOp[] = [];
  let sourceMethod: "LEDGER" | "FALLBACK" | "NONE";

  // ── TABLET_RECEIVE ops ────────────────────────────────────────────────────

  if (ledgerRows.length > 0) {
    sourceMethod = "LEDGER";
    for (const s of ledgerRows) {
      const key = `luma:tablet_receive:${finishedLotId}:${s.inventoryBagId}`;
      const qty  = s.consumedQty ?? 0;
      const missing: string[] = [];
      if (!s.tabletZohoItemId) missing.push("tablet type has no Zoho item ID");
      if (!s.zohoPoId)         missing.push("purchase order has no Zoho PO ID");
      if (!s.zohoLineItemId)   missing.push("PO line has no Zoho line item ID");
      const statusPreview: ZohoAssemblyStatusPreview =
        missing.length > 0 ? "NEEDS_MAPPING" : "READY";
      ops.push({
        opKind:               "TABLET_RECEIVE",
        opSequence:           1,
        idempotencyKey:       key,
        sourceInventoryBagId: s.inventoryBagId,
        sourcePoLineId:       s.receivePoLineId ?? null,
        sourceTabletTypeId:   s.tabletTypeId,
        tabletTypeName:       s.tabletName,
        zohoTabletItemId:     s.tabletZohoItemId ?? null,
        zohoPoId:             s.zohoPoId ?? null,
        zohoLineItemId:       s.zohoLineItemId ?? null,
        quantity:             qty,
        componentRole:        s.componentRole ?? null,
        statusPreview,
        statusReason:         missing.length > 0 ? missing.join("; ") : null,
        payloadPreview: {
          zohoPoId:       s.zohoPoId ?? null,
          zohoLineItemId: s.zohoLineItemId ?? null,
          quantity:       qty,
        },
      });
    }
  } else if (fallbackRows.length > 0) {
    sourceMethod = "FALLBACK";
    issues.push(
      "Source resolution fell back to batch genealogy — no closed allocation sessions found. " +
      "PO line details are unavailable; all TABLET_RECEIVE ops require manual mapping before enqueue.",
    );
    for (const fi of fallbackRows) {
      if (!fi.tabletTypeId) continue;
      // Fallback keys use `batch:` prefix — never match the official enqueue format.
      const key = `luma:tablet_receive:${finishedLotId}:batch:${fi.batchId}`;
      const missing = ["no inventory bag link — PO receive details unavailable"];
      if (!fi.tabletZohoItemId) missing.push("tablet type has no Zoho item ID");
      ops.push({
        opKind:               "TABLET_RECEIVE",
        opSequence:           1,
        idempotencyKey:       key,
        sourceInventoryBagId: null,
        sourcePoLineId:       null,
        sourceTabletTypeId:   fi.tabletTypeId,
        tabletTypeName:       fi.tabletName ?? null,
        zohoTabletItemId:     fi.tabletZohoItemId ?? null,
        zohoPoId:             null,
        zohoLineItemId:       null,
        quantity:             fi.qtyConsumed,
        componentRole:        null,
        statusPreview:        "NEEDS_MAPPING",
        statusReason:         missing.join("; "),
        payloadPreview: {
          zohoPoId:       null,
          zohoLineItemId: null,
          quantity:       fi.qtyConsumed,
        },
      });
    }
  } else {
    sourceMethod = "NONE";
    issues.push(
      "No tablet source records found — neither allocation sessions nor batch inputs exist for this lot.",
    );
  }

  // ── BOM helper ────────────────────────────────────────────────────────────

  function bomLinesFor(scope: string, assemblyQty: number): BomLine[] {
    return bomRows
      .filter((r) => r.perScope === scope)
      .map((r) => ({
        materialId:   r.materialId,
        materialName: r.materialName,
        zohoItemId:   r.materialZohoItemId,
        qtyPerUnit:   r.qtyPerUnit,
        expectedQty:  r.qtyPerUnit * assemblyQty,
        issue:        r.materialZohoItemId
          ? null
          : "Missing Zoho item ID on packaging material",
      }));
  }

  // ── Assembly ops ──────────────────────────────────────────────────────────

  const unitZohoItemId    = product?.zohoItemIdUnit    ?? null;
  const displayZohoItemId = product?.zohoItemIdDisplay ?? null;
  const caseZohoItemId    = product?.zohoItemIdCase    ?? null;

  // UNIT_ASSEMBLE (sequence 2)
  {
    const bomLines = bomLinesFor("UNIT", unitsProduced);
    const bomMissing = bomLines.some((l) => l.issue !== null);
    let statusPreview: ZohoAssemblyStatusPreview;
    let statusReason: string | null = null;
    if (unitsProduced <= 0) {
      statusPreview = "SKIPPED";
      statusReason  = "No units produced";
    } else if (!unitZohoItemId) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "Product has no Zoho item ID for unit level";
    } else if (bomMissing) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "One or more unit-level BOM materials lack a Zoho item ID";
    } else {
      statusPreview = "READY";
    }
    ops.push({
      opKind:         "UNIT_ASSEMBLE",
      opSequence:     2,
      idempotencyKey: `luma:unit_assemble:${finishedLotId}`,
      zohoItemId:     unitZohoItemId,
      quantity:       unitsProduced,
      statusPreview,
      statusReason,
      bomLines,
      payloadPreview: { zohoItemId: unitZohoItemId, quantity: unitsProduced },
    });
  }

  // DISPLAY_ASSEMBLE (sequence 3)
  {
    const qty      = displaysProduced ?? 0;
    const bomLines = bomLinesFor("DISPLAY", qty);
    const bomMissing = bomLines.some((l) => l.issue !== null);
    let statusPreview: ZohoAssemblyStatusPreview;
    let statusReason: string | null = null;
    if (qty <= 0) {
      statusPreview = "SKIPPED";
      statusReason  = "No displays produced";
    } else if (!displayZohoItemId) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "Product has no Zoho item ID for display level";
    } else if (bomMissing) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "One or more display-level BOM materials lack a Zoho item ID";
    } else {
      statusPreview = "READY";
    }
    ops.push({
      opKind:         "DISPLAY_ASSEMBLE",
      opSequence:     3,
      idempotencyKey: `luma:display_assemble:${finishedLotId}`,
      zohoItemId:     displayZohoItemId,
      quantity:       qty,
      statusPreview,
      statusReason,
      bomLines,
      payloadPreview: { zohoItemId: displayZohoItemId, quantity: qty },
    });
  }

  // CASE_ASSEMBLE (sequence 4)
  {
    const qty      = casesProduced ?? 0;
    const bomLines = bomLinesFor("CASE", qty);
    const bomMissing = bomLines.some((l) => l.issue !== null);
    let statusPreview: ZohoAssemblyStatusPreview;
    let statusReason: string | null = null;
    if (qty <= 0) {
      statusPreview = "SKIPPED";
      statusReason  = "No cases produced";
    } else if (!caseZohoItemId) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "Product has no Zoho item ID for case level";
    } else if (bomMissing) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "One or more case-level BOM materials lack a Zoho item ID";
    } else {
      statusPreview = "READY";
    }
    ops.push({
      opKind:         "CASE_ASSEMBLE",
      opSequence:     4,
      idempotencyKey: `luma:case_assemble:${finishedLotId}`,
      zohoItemId:     caseZohoItemId,
      quantity:       qty,
      statusPreview,
      statusReason,
      bomLines,
      payloadPreview: { zohoItemId: caseZohoItemId, quantity: qty },
    });
  }

  // ── Overall status — worst across all non-SKIPPED ops ────────────────────

  const nonSkipped = ops.filter((o) => o.statusPreview !== "SKIPPED");
  let overallStatus: ZohoAssemblyStatusPreview;
  if (nonSkipped.some(
    (o) => o.statusPreview === "NEEDS_MAPPING" || o.statusPreview === "BLOCKED",
  )) {
    overallStatus = "NEEDS_MAPPING";
  } else if (nonSkipped.length === 0) {
    overallStatus = "SKIPPED";
  } else {
    overallStatus = "READY";
  }

  return {
    finishedLotId,
    finishedLotNumber,
    product: product
      ? {
          id:                product.id,
          name:              product.name,
          sku:               product.sku,
          kind:              product.kind,
          zohoItemIdUnit:    product.zohoItemIdUnit    ?? null,
          zohoItemIdDisplay: product.zohoItemIdDisplay ?? null,
          zohoItemIdCase:    product.zohoItemIdCase    ?? null,
        }
      : null,
    ops,
    sourceMethod,
    overallStatus,
    issues,
  };
}

// ─── DB entry point ───────────────────────────────────────────────────────────

const CLOSED_ALLOCATION_STATUSES = ["CLOSED", "DEPLETED"] as const;

type AllocationLedgerRow = {
  inventoryBagId: string;
  consumedQty: number | null;
  tabletTypeId: string | null;
  tabletZohoItemId: string | null;
  tabletName: string | null;
  receivePoLineId: string | null;
  zohoLineItemId: string | null;
  zohoPoId: string | null;
  componentRole: string | null;
};

/** Load closed allocation sessions for Zoho TABLET_RECEIVE planning.
 *  Prefers sessions linked by finished_lot_id; falls back to
 *  finished_lots.workflow_bag_id when lot-scoped rows are absent. */
export async function fetchAllocationLedgerRows(
  finishedLotId: string,
  workflowBagId: string | null,
): Promise<AllocationLedgerRow[]> {
  const baseQuery = () =>
    db
      .select({
        inventoryBagId: rawBagAllocationSessions.inventoryBagId,
        consumedQty: rawBagAllocationSessions.consumedQty,
        tabletTypeId: inventoryBags.tabletTypeId,
        tabletZohoItemId: tabletTypes.zohoItemId,
        tabletName: tabletTypes.name,
        receivePoLineId: receives.poLineId,
        zohoLineItemId: poLines.zohoLineItemId,
        zohoPoId: purchaseOrders.zohoPoId,
        componentRole: rawBagAllocationSessions.componentRole,
      })
      .from(rawBagAllocationSessions)
      .innerJoin(inventoryBags, eq(rawBagAllocationSessions.inventoryBagId, inventoryBags.id))
      .innerJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
      .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
      .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
      .leftJoin(poLines, eq(receives.poLineId, poLines.id))
      .leftJoin(purchaseOrders, eq(rawBagAllocationSessions.poId, purchaseOrders.id));

  const byLotId = await baseQuery().where(
    and(
      eq(rawBagAllocationSessions.finishedLotId, finishedLotId),
      inArray(rawBagAllocationSessions.allocationStatus, [...CLOSED_ALLOCATION_STATUSES]),
    ),
  );
  if (byLotId.length > 0 || !workflowBagId) {
    return byLotId;
  }

  return baseQuery().where(
    and(
      eq(rawBagAllocationSessions.workflowBagId, workflowBagId),
      inArray(rawBagAllocationSessions.allocationStatus, [...CLOSED_ALLOCATION_STATUSES]),
    ),
  );
}

export async function planZohoAssemblyForFinishedLot(
  finishedLotId: string,
): Promise<ZohoAssemblyPlanResult | null> {
  // 1. Load lot + product
  const [lotRow] = await db
    .select({ lot: finishedLots, product: products })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, finishedLotId));
  if (!lotRow) return null;

  const { lot, product } = lotRow;

  // 2. LEDGER path — raw_bag_allocation_sessions
  const ledgerRows = await fetchAllocationLedgerRows(finishedLotId, lot.workflowBagId);

  // 3. FALLBACK path — only fetched when LEDGER is empty
  const fallbackRows = ledgerRows.length > 0
    ? []
    : await db
        .select({
          batchId:          finishedLotInputs.batchId,
          qtyConsumed:      finishedLotInputs.qtyConsumed,
          tabletTypeId:     batches.tabletTypeId,
          tabletName:       tabletTypes.name,
          tabletZohoItemId: tabletTypes.zohoItemId,
        })
        .from(finishedLotInputs)
        .innerJoin(batches,    eq(finishedLotInputs.batchId, batches.id))
        .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
        .where(
          and(
            eq(finishedLotInputs.finishedLotId, finishedLotId),
            eq(batches.kind, "TABLET"),
          ),
        );

  // 4. BOM specs
  const bomRows = product
    ? await db
        .select({
          perScope:           productPackagingSpecs.perScope,
          materialId:         packagingMaterials.id,
          materialName:       packagingMaterials.name,
          materialZohoItemId: packagingMaterials.zohoItemId,
          qtyPerUnit:         productPackagingSpecs.qtyPerUnit,
        })
        .from(productPackagingSpecs)
        .innerJoin(
          packagingMaterials,
          eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
        )
        .where(eq(productPackagingSpecs.productId, product.id))
    : [];

  return computeZohoAssemblyPlan({
    finishedLotId,
    finishedLotNumber: lot.finishedLotNumber,
    unitsProduced:     lot.unitsProduced,
    displaysProduced:  lot.displaysProduced,
    casesProduced:     lot.casesProduced,
    product: product
      ? {
          id:                product.id,
          name:              product.name,
          sku:               product.sku,
          kind:              product.kind,
          zohoItemIdUnit:    product.zohoItemIdUnit    ?? null,
          zohoItemIdDisplay: product.zohoItemIdDisplay ?? null,
          zohoItemIdCase:    product.zohoItemIdCase    ?? null,
        }
      : null,
    ledgerRows: ledgerRows.map((r) => ({
      inventoryBagId:   r.inventoryBagId,
      consumedQty:      r.consumedQty,
      tabletTypeId:     r.tabletTypeId!,
      tabletName:       r.tabletName ?? "",
      tabletZohoItemId: r.tabletZohoItemId ?? null,
      receivePoLineId:  r.receivePoLineId  ?? null,
      zohoLineItemId:   r.zohoLineItemId   ?? null,
      zohoPoId:         r.zohoPoId         ?? null,
      componentRole:    r.componentRole    ?? null,
    })),
    fallbackRows: fallbackRows.map((r) => ({
      ...r,
      tabletTypeId:     r.tabletTypeId     ?? null,
      tabletName:       r.tabletName       ?? null,
      tabletZohoItemId: r.tabletZohoItemId ?? null,
    })),
    bomRows: bomRows.map((r) => ({
      ...r,
      materialZohoItemId: r.materialZohoItemId ?? null,
    })),
  });
}
