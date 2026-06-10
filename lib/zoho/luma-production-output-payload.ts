// LUMA-PRODUCTION-OUTPUT-PAYLOAD — consolidated shared-service request body.

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  inventoryBags,
  products,
  rawBagAllocationSessions,
  readBagMetrics,
  receives,
  smallBoxes,
  workflowBags,
} from "@/lib/db/schema";
import { fetchAllocationLedgerRows } from "@/lib/zoho/assembly-planner";
import type { ComponentBatchPayloadEntry } from "@/lib/zoho/production-output-source-allocations";
import type { LumaOperationSnapshot } from "@/lib/zoho/luma-operation-snapshot";
import { resolveProductFamily } from "@/lib/zoho/product-family";
import { stableStringifyProductionOutputPreview } from "@/lib/zoho/production-output-preview";
import type { SourceReceiptEvidence } from "@/lib/zoho/source-receipt-evidence";

export const LUMA_PRODUCTION_OUTPUT_SOURCE = "LUMA" as const;
export const PRODUCTION_OUTPUT_COMMIT_PATH =
  "/zoho/luma/production-output/commit";

export type LumaProductionOutputSourceReceipt = {
  luma_inventory_bag_id: string;
  internal_receipt_number: string | null;
  luma_po_id: string | null;
  zoho_purchaseorder_id: string | null;
  luma_po_line_id: string | null;
  zoho_purchaseorder_line_item_id: string | null;
  tablet_type_id: string;
  tablet_name: string;
  tablet_zoho_item_id: string | null;
  quantity_consumed: number;
};

/** Internal evidence — serialize as canonical `source_receipts` for Zoho. */
export type LumaProductionOutputSourceReceiptEvidence = SourceReceiptEvidence;

export type LumaProductionOutputPayload = {
  source: typeof LUMA_PRODUCTION_OUTPUT_SOURCE;
  luma_finished_lot_id: string;
  luma_workflow_bag_id: string | null;
  finished_lot_number: string;
  trace_code: string;
  product: {
    luma_product_id: string;
    sku: string;
    name: string;
    unit_composite_item_id: string | null;
    display_composite_item_id: string | null;
    case_composite_item_id: string | null;
  };
  source_receipts: LumaProductionOutputSourceReceipt[];
  source_receipt_evidence?: LumaProductionOutputSourceReceiptEvidence[];
  output: {
    units_produced: number;
    displays_produced: number | null;
    cases_produced: number | null;
    damaged_packaging: number | null;
    ripped_cards: number | null;
    loose_cards: number | null;
  };
  production_dates: {
    produced_on: string;
    packed_at: string | null;
    receive_date: string;
  };
  /** v1.20.6 — batch-tracked component consumption for Zoho assembly. */
  component_batches: ComponentBatchPayloadEntry[];
  /** v1.20.6 — persisted operation verification snapshot (from DB only). */
  luma_operation_snapshot?: LumaOperationSnapshot;
  idempotency_key: string;
  warehouse_id?: string;
};

export type LumaProductionOutputMappingBlocker = {
  code: string;
  message: string;
};

export type LumaProductionOutputBuildResult =
  | {
      ok: true;
      payload: LumaProductionOutputPayload;
      requestHash: string;
      metricsState: "HIGH" | "MISSING";
      genealogyState: "HIGH" | "MISSING";
    }
  | {
      ok: false;
      blockers: LumaProductionOutputMappingBlocker[];
    };

export function buildLumaProductionOutputStableCommitIdempotencyKey(
  finishedLotId: string,
): string {
  return `luma-production-output:${finishedLotId}`;
}

export function buildLumaProductionOutputOperationId(
  finishedLotId: string,
): string {
  return `luma-production-output:${finishedLotId}`;
}

export function buildLumaProductionOutputRequestHash(
  payload: LumaProductionOutputPayload,
): string {
  return createHash("sha256")
    .update(stableStringifyProductionOutputPreview(payload))
    .digest("hex");
}

export function isConsolidatedLumaProductionOutputPayload(
  payload: unknown,
): payload is LumaProductionOutputPayload {
  if (payload == null || typeof payload !== "object") return false;
  return (payload as { source?: string }).source === LUMA_PRODUCTION_OUTPUT_SOURCE;
}

type BuildInput = {
  finishedLotId: string;
  workflowBagId: string | null;
  finishedLotNumber: string;
  traceCode: string;
  producedOn: string;
  packedAt: Date | null;
  unitsProduced: number;
  displaysProduced: number | null;
  casesProduced: number | null;
  product: {
    id: string;
    sku: string;
    name: string;
    zohoItemIdUnit: string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase: string | null;
  } | null;
  metrics: {
    damagedPackaging: number | null;
    rippedCards: number | null;
    looseCards: number | null;
  } | null;
  ledgerRows: Array<{
    inventoryBagId: string;
    internalReceiptNumber: string | null;
    consumedQty: number | null;
    tabletTypeId: string | null;
    tabletName: string | null;
    tabletZohoItemId: string | null;
    lumaPoId: string | null;
    lumaPoLineId: string | null;
    zohoPoId: string | null;
    zohoLineItemId: string | null;
  }>;
  componentBatches?: ComponentBatchPayloadEntry[];
  requireComponentBatches?: boolean;
  warehouseId: string | null;
};

export function buildLumaProductionOutputPayloadFromContext(
  input: BuildInput,
): LumaProductionOutputBuildResult {
  const blockers: LumaProductionOutputMappingBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  if (!input.product) add("MISSING_PRODUCT", "Finished lot has no product mapped.");
  if (input.unitsProduced <= 0) {
    add("MISSING_PRODUCED_QUANTITY", "Finished lot has no units produced.");
  }
  if (input.ledgerRows.length === 0) {
    add(
      "MISSING_ALLOCATION_LEDGER",
      "No closed allocation ledger sessions exist for this lot. Live commit is blocked.",
    );
  }

  const displays = input.displaysProduced ?? 0;
  const cases = input.casesProduced ?? 0;
  const unitComposite = input.product?.zohoItemIdUnit?.trim() ?? null;
  const displayComposite = input.product?.zohoItemIdDisplay?.trim() ?? null;
  const caseComposite = input.product?.zohoItemIdCase?.trim() ?? null;

  if (input.product && !unitComposite) {
    add("MISSING_UNIT_COMPOSITE_ITEM_ID", "Product is missing Zoho unit composite item ID.");
  }
  if (displays > 0 && !displayComposite) {
    add(
      "MISSING_DISPLAY_COMPOSITE_ITEM_ID",
      "Displays were produced but product is missing Zoho display composite item ID.",
    );
  }
  if (cases > 0 && !caseComposite) {
    add(
      "MISSING_CASE_COMPOSITE_ITEM_ID",
      "Cases were produced but product is missing Zoho case composite item ID.",
    );
  }

  const sourceReceipts: LumaProductionOutputSourceReceipt[] = [];
  for (const row of input.ledgerRows) {
    const qty = row.consumedQty ?? 0;
    if (qty <= 0) continue;
    if (!row.tabletTypeId || !row.tabletName) {
      add("MISSING_TABLET_TYPE", "Allocation session is missing tablet type.");
      continue;
    }
    if (!row.tabletZohoItemId) {
      add(
        "MISSING_TABLET_ZOHO_ITEM_ID",
        `Tablet type ${row.tabletName} is missing Zoho item ID.`,
      );
    }
    if (!row.zohoPoId) {
      add(
        "MISSING_ZOHO_PO_ID",
        `Source bag ${row.internalReceiptNumber ?? row.inventoryBagId} is missing Zoho PO ID.`,
      );
    }
    if (!row.zohoLineItemId) {
      add(
        "MISSING_ZOHO_PO_LINE_ITEM_ID",
        `Source bag ${row.internalReceiptNumber ?? row.inventoryBagId} is missing Zoho PO line item ID.`,
      );
    }
    sourceReceipts.push({
      luma_inventory_bag_id: row.inventoryBagId,
      internal_receipt_number: row.internalReceiptNumber,
      luma_po_id: row.lumaPoId,
      zoho_purchaseorder_id: row.zohoPoId,
      luma_po_line_id: row.lumaPoLineId,
      zoho_purchaseorder_line_item_id: row.zohoLineItemId,
      tablet_type_id: row.tabletTypeId,
      tablet_name: row.tabletName,
      tablet_zoho_item_id: row.tabletZohoItemId,
      quantity_consumed: qty,
    });
  }

  if (input.ledgerRows.length > 0 && sourceReceipts.length === 0) {
    add(
      "MISSING_CONSUMED_QUANTITY",
      "Allocation sessions exist but no positive consumed quantity was recorded.",
    );
  }

  const componentBatches = input.componentBatches ?? [];
  if (input.requireComponentBatches === true && input.ledgerRows.length > 0 && componentBatches.length === 0) {
    add(
      "MISSING_COMPONENT_BATCHES",
      "Batch-tracked component_batches are required but no resolved Zoho batch IDs were provided.",
    );
  }

  const metricsState: "HIGH" | "MISSING" =
    input.metrics != null && input.workflowBagId != null ? "HIGH" : "MISSING";
  const genealogyState: "HIGH" | "MISSING" =
    sourceReceipts.length > 0 ? "HIGH" : "MISSING";

  if (blockers.length > 0 || !input.product) {
    return { ok: false, blockers };
  }

  const producedOn = String(input.producedOn).slice(0, 10);
  const payload: LumaProductionOutputPayload = {
    source: LUMA_PRODUCTION_OUTPUT_SOURCE,
    luma_finished_lot_id: input.finishedLotId,
    luma_workflow_bag_id: input.workflowBagId,
    finished_lot_number: input.finishedLotNumber,
    trace_code: input.traceCode,
    product: {
      luma_product_id: input.product.id,
      sku: input.product.sku,
      name: input.product.name,
      unit_composite_item_id: unitComposite,
      display_composite_item_id: displayComposite,
      case_composite_item_id: caseComposite,
    },
    source_receipts: sourceReceipts,
    component_batches: componentBatches,
    output: {
      units_produced: input.unitsProduced,
      displays_produced: input.displaysProduced,
      cases_produced: input.casesProduced,
      damaged_packaging: input.metrics?.damagedPackaging ?? null,
      ripped_cards: input.metrics?.rippedCards ?? null,
      loose_cards: input.metrics?.looseCards ?? null,
    },
    production_dates: {
      produced_on: producedOn,
      packed_at: input.packedAt?.toISOString() ?? null,
      receive_date: producedOn,
    },
    idempotency_key: buildLumaProductionOutputStableCommitIdempotencyKey(
      input.finishedLotId,
    ),
  };

  if (input.warehouseId) payload.warehouse_id = input.warehouseId;

  return {
    ok: true,
    payload,
    requestHash: buildLumaProductionOutputRequestHash(payload),
    metricsState,
    genealogyState,
  };
}

export async function loadAndBuildLumaProductionOutputPayload(
  finishedLotId: string,
  opts?: {
    warehouseId?: string | null;
    componentBatches?: ComponentBatchPayloadEntry[];
  },
): Promise<LumaProductionOutputBuildResult & { finishedLotId: string }> {
  const [lotRow] = await db
    .select({ lot: finishedLots, product: products })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, finishedLotId))
    .limit(1);

  if (!lotRow) {
    return {
      finishedLotId,
      ok: false,
      blockers: [{ code: "FINISHED_LOT_MISSING", message: "Finished lot not found." }],
    };
  }

  const { lot, product } = lotRow;
  const ledgerBase = await fetchAllocationLedgerRows(
    finishedLotId,
    lot.workflowBagId,
  );

  const bagIds = [...new Set(ledgerBase.map((r) => r.inventoryBagId))];
  const receiptByBag = new Map<string, string | null>();
  const poMetaByBag = new Map<
    string,
    { lumaPoId: string | null; lumaPoLineId: string | null }
  >();

  if (bagIds.length > 0) {
    const bagRows = await db
      .select({
        id: inventoryBags.id,
        internalReceiptNumber: inventoryBags.internalReceiptNumber,
        receivePoLineId: receives.poLineId,
        receivePoId: receives.poId,
      })
      .from(inventoryBags)
      .innerJoin(smallBoxes, eq(inventoryBags.smallBoxId, smallBoxes.id))
      .innerJoin(receives, eq(smallBoxes.receiveId, receives.id))
      .where(inArray(inventoryBags.id, bagIds));

    for (const row of bagRows) {
      receiptByBag.set(row.id, row.internalReceiptNumber);
      poMetaByBag.set(row.id, {
        lumaPoId: row.receivePoId,
        lumaPoLineId: row.receivePoLineId,
      });
    }
  }

  const sessionPoRows =
    bagIds.length > 0
      ? await db
          .select({
            inventoryBagId: rawBagAllocationSessions.inventoryBagId,
            poId: rawBagAllocationSessions.poId,
          })
          .from(rawBagAllocationSessions)
          .where(
            and(
              inArray(rawBagAllocationSessions.inventoryBagId, bagIds),
              eq(rawBagAllocationSessions.finishedLotId, finishedLotId),
            ),
          )
      : [];

  const sessionPoByBag = new Map<string, string | null>();
  for (const row of sessionPoRows) {
    sessionPoByBag.set(row.inventoryBagId, row.poId);
  }

  let metrics: BuildInput["metrics"] = null;
  if (lot.workflowBagId) {
    const [metricsRow] = await db
      .select({
        damagedPackaging: readBagMetrics.damagedPackaging,
        rippedCards: readBagMetrics.rippedCards,
        looseCards: readBagMetrics.looseCards,
      })
      .from(readBagMetrics)
      .where(eq(readBagMetrics.workflowBagId, lot.workflowBagId))
      .limit(1);
    metrics = metricsRow ?? null;
  }

  const ledgerRows = ledgerBase.map((row) => {
    const poMeta = poMetaByBag.get(row.inventoryBagId);
    const sessionPoId = sessionPoByBag.get(row.inventoryBagId);
    return {
      inventoryBagId: row.inventoryBagId,
      internalReceiptNumber: receiptByBag.get(row.inventoryBagId) ?? null,
      consumedQty: row.consumedQty,
      tabletTypeId: row.tabletTypeId,
      tabletName: row.tabletName,
      tabletZohoItemId: row.tabletZohoItemId,
      lumaPoId: sessionPoId ?? poMeta?.lumaPoId ?? null,
      lumaPoLineId: poMeta?.lumaPoLineId ?? row.receivePoLineId,
      zohoPoId: row.zohoPoId,
      zohoLineItemId: row.zohoLineItemId,
    };
  });

  const built = buildLumaProductionOutputPayloadFromContext({
    finishedLotId,
    workflowBagId: lot.workflowBagId,
    finishedLotNumber: lot.finishedLotNumber,
    traceCode: lot.traceCode ?? lot.finishedLotNumber,
    producedOn: String(lot.producedOn),
    packedAt: lot.packedAt,
    unitsProduced: lot.unitsProduced ?? 0,
    displaysProduced: lot.displaysProduced,
    casesProduced: lot.casesProduced,
    product: product
      ? {
          id: product.id,
          sku: product.sku,
          name: product.name,
          zohoItemIdUnit: product.zohoItemIdUnit,
          zohoItemIdDisplay: product.zohoItemIdDisplay,
          zohoItemIdCase: product.zohoItemIdCase,
        }
      : null,
    metrics,
    ledgerRows,
    componentBatches: opts?.componentBatches ?? [],
    requireComponentBatches: product?.kind === "VARIETY",
    warehouseId: opts?.warehouseId ?? null,
  });

  return { finishedLotId, ...built };
}
