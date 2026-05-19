// ZOHO-ASSY-2 — Read-only dry-run planner for Zoho assembly operations.
//
// Returns a full plan (with status previews + payload shapes) without
// writing anything to the DB or calling Zoho.
//
// Source resolution — two paths:
//
//   LEDGER:   raw_bag_allocation_sessions (preferred)
//     inventory_bag → small_box → receive → po_line → zoho_line_item_id
//     allocation_session.po_id → purchase_order → zoho_po_id
//
//   FALLBACK: finished_lot_inputs → batches (when no allocation sessions)
//     Cannot resolve po_line; all TABLET_RECEIVE ops will be NEEDS_MAPPING.
//
//   NONE:     No tablet source records found at all.

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

// ─── Types ────────────────────────────────────────────────────────────────────

export type ZohoAssemblyStatusPreview = "READY" | "NEEDS_MAPPING" | "SKIPPED" | "BLOCKED";

export type BomIssue = {
  materialId:   string;
  materialName: string;
  zohoItemId:   string | null;
  issue:        string;
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
  opKind:        "UNIT_ASSEMBLE" | "DISPLAY_ASSEMBLE" | "CASE_ASSEMBLE";
  opSequence:    2 | 3 | 4;
  idempotencyKey: string;
  zohoItemId:    string | null;
  quantity:      number;
  statusPreview: ZohoAssemblyStatusPreview;
  statusReason:  string | null;
  bomIssues:     BomIssue[];
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

// ─── Planner ──────────────────────────────────────────────────────────────────

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
  const issues: string[] = [];
  const ops: PlanOp[] = [];

  // 2. Source resolution — LEDGER path via raw_bag_allocation_sessions
  const ledgerRows = await db
    .select({
      inventoryBagId:  rawBagAllocationSessions.inventoryBagId,
      poId:            rawBagAllocationSessions.poId,
      componentRole:   rawBagAllocationSessions.componentRole,
      consumedQty:     rawBagAllocationSessions.consumedQty,
      tabletTypeId:    inventoryBags.tabletTypeId,
      tabletZohoItemId: tabletTypes.zohoItemId,
      tabletName:      tabletTypes.name,
      receivePoLineId: receives.poLineId,
      zohoLineItemId:  poLines.zohoLineItemId,
      zohoPoId:        purchaseOrders.zohoPoId,
    })
    .from(rawBagAllocationSessions)
    .innerJoin(inventoryBags,   eq(rawBagAllocationSessions.inventoryBagId, inventoryBags.id))
    .innerJoin(tabletTypes,     eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .innerJoin(smallBoxes,      eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives,        eq(smallBoxes.receiveId, receives.id))
    .leftJoin(poLines,          eq(receives.poLineId, poLines.id))
    .leftJoin(purchaseOrders,   eq(rawBagAllocationSessions.poId, purchaseOrders.id))
    .where(
      and(
        eq(rawBagAllocationSessions.finishedLotId, finishedLotId),
        inArray(rawBagAllocationSessions.allocationStatus, ["CLOSED", "DEPLETED"]),
      ),
    );

  let sourceMethod: "LEDGER" | "FALLBACK" | "NONE";

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
  } else {
    // FALLBACK path via finished_lot_inputs
    const fallbackRows = await db
      .select({
        batchId:         finishedLotInputs.batchId,
        qtyConsumed:     finishedLotInputs.qtyConsumed,
        tabletTypeId:    batches.tabletTypeId,
        tabletName:      tabletTypes.name,
        tabletZohoItemId: tabletTypes.zohoItemId,
      })
      .from(finishedLotInputs)
      .innerJoin(batches,      eq(finishedLotInputs.batchId, batches.id))
      .leftJoin(tabletTypes,   eq(batches.tabletTypeId, tabletTypes.id))
      .where(
        and(
          eq(finishedLotInputs.finishedLotId, finishedLotId),
          eq(batches.kind, "TABLET"),
        ),
      );

    if (fallbackRows.length > 0) {
      sourceMethod = "FALLBACK";
      issues.push(
        "Source resolution fell back to batch genealogy — no closed allocation sessions found. " +
        "PO line details are unavailable; all TABLET_RECEIVE ops require manual mapping before enqueue.",
      );
      for (const fi of fallbackRows) {
        if (!fi.tabletTypeId) continue;
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
  }

  // 3. BOM specs for assembly-op issue detection
  const bomSpecs = product
    ? await db
        .select({
          perScope:          productPackagingSpecs.perScope,
          materialId:        packagingMaterials.id,
          materialName:      packagingMaterials.name,
          materialZohoItemId: packagingMaterials.zohoItemId,
        })
        .from(productPackagingSpecs)
        .innerJoin(
          packagingMaterials,
          eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
        )
        .where(eq(productPackagingSpecs.productId, product.id))
    : [];

  function bomIssuesFor(scope: string): BomIssue[] {
    return bomSpecs
      .filter((s) => s.perScope === scope && !s.materialZohoItemId)
      .map((s) => ({
        materialId:   s.materialId,
        materialName: s.materialName,
        zohoItemId:   s.materialZohoItemId,
        issue:        "Missing Zoho item ID on packaging material",
      }));
  }

  // 4. Assembly ops — UNIT / DISPLAY / CASE
  const unitsProduced    = lot.unitsProduced;
  const displaysProduced = lot.displaysProduced;
  const casesProduced    = lot.casesProduced;

  const unitZohoItemId    = product?.zohoItemIdUnit    ?? null;
  const displayZohoItemId = product?.zohoItemIdDisplay ?? null;
  const caseZohoItemId    = product?.zohoItemIdCase    ?? null;

  // UNIT_ASSEMBLE
  {
    const bomIssues   = bomIssuesFor("UNIT");
    let statusPreview: ZohoAssemblyStatusPreview;
    let statusReason: string | null = null;
    if (unitsProduced <= 0) {
      statusPreview = "SKIPPED";
      statusReason  = "No units produced";
    } else if (!unitZohoItemId) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "Product has no Zoho item ID for unit level";
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
      bomIssues,
      payloadPreview: { zohoItemId: unitZohoItemId, quantity: unitsProduced },
    });
  }

  // DISPLAY_ASSEMBLE
  {
    const bomIssues   = bomIssuesFor("DISPLAY");
    let statusPreview: ZohoAssemblyStatusPreview;
    let statusReason: string | null = null;
    if (!displaysProduced || displaysProduced <= 0) {
      statusPreview = "SKIPPED";
      statusReason  = "No displays produced";
    } else if (!displayZohoItemId) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "Product has no Zoho item ID for display level";
    } else {
      statusPreview = "READY";
    }
    const qty = displaysProduced ?? 0;
    ops.push({
      opKind:         "DISPLAY_ASSEMBLE",
      opSequence:     3,
      idempotencyKey: `luma:display_assemble:${finishedLotId}`,
      zohoItemId:     displayZohoItemId,
      quantity:       qty,
      statusPreview,
      statusReason,
      bomIssues,
      payloadPreview: { zohoItemId: displayZohoItemId, quantity: qty },
    });
  }

  // CASE_ASSEMBLE
  {
    const bomIssues   = bomIssuesFor("CASE");
    let statusPreview: ZohoAssemblyStatusPreview;
    let statusReason: string | null = null;
    if (!casesProduced || casesProduced <= 0) {
      statusPreview = "SKIPPED";
      statusReason  = "No cases produced";
    } else if (!caseZohoItemId) {
      statusPreview = "NEEDS_MAPPING";
      statusReason  = "Product has no Zoho item ID for case level";
    } else {
      statusPreview = "READY";
    }
    const qty = casesProduced ?? 0;
    ops.push({
      opKind:         "CASE_ASSEMBLE",
      opSequence:     4,
      idempotencyKey: `luma:case_assemble:${finishedLotId}`,
      zohoItemId:     caseZohoItemId,
      quantity:       qty,
      statusPreview,
      statusReason,
      bomIssues,
      payloadPreview: { zohoItemId: caseZohoItemId, quantity: qty },
    });
  }

  // 5. Overall status — worst across all non-SKIPPED ops
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
    finishedLotNumber: lot.finishedLotNumber,
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
