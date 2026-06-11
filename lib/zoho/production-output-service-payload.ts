// Map persisted LUMA consolidated payload to Zoho Integration service body.
// Preview and commit both use this mapper so the Zoho contract cannot drift.

import {
  buildLumaProductionOutputOperationId,
  isConsolidatedLumaProductionOutputPayload,
  type LumaProductionOutputPayload,
} from "@/lib/zoho/luma-production-output-payload";
import {
  firstSourceReceiptPoId,
  firstSourceReceiptPoLineId,
} from "@/lib/zoho/production-output-consolidated-eligibility";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import { mapProductionOutputPreviewQuantities } from "@/lib/zoho/production-output-preview-quantities";
import { buildOutboundSourceReceipts } from "@/lib/zoho/source-receipt-contract";
import { evaluateSourceReceiptEvidenceForProductionOutput } from "@/lib/zoho/source-receipt-evidence";

export type BuildProductionOutputServicePayloadOpts = {
  /** Distinguishes preview vs commit in Zoho notes only; body shape is identical. */
  notes?: string;
};

export const PRODUCTION_OUTPUT_SERVICE_COMMIT_NOTES =
  "Luma consolidated production-output commit";
export const PRODUCTION_OUTPUT_SERVICE_PREVIEW_NOTES =
  "Luma consolidated production-output preview";

/** True when a value is the internal LUMA op body — must never be POSTed to Zoho commit. */
export function isInternalLumaProductionOutputPayloadBody(
  body: unknown,
): body is LumaProductionOutputPayload {
  return isConsolidatedLumaProductionOutputPayload(body);
}

/** Zoho preview/commit endpoints share this request shape. */
export function buildProductionOutputServicePayloadFromLuma(
  payload: LumaProductionOutputPayload,
  opts?: BuildProductionOutputServicePayloadOpts,
): ProductionOutputPreviewPayload {
  const mappedQty = mapProductionOutputPreviewQuantities({
    unitsProduced: payload.output.units_produced,
    displaysProduced: payload.output.displays_produced,
    casesProduced: payload.output.cases_produced,
    looseCards: payload.output.loose_cards,
  });

  const evidence = payload.source_receipt_evidence ?? [];
  const outboundSourceReceipts = buildOutboundSourceReceipts(evidence);
  const receiptGate = evaluateSourceReceiptEvidenceForProductionOutput(evidence);

  const servicePayload: ProductionOutputPreviewPayload = {
    purchaseorder_id: firstSourceReceiptPoId(payload) ?? "",
    purchaseorder_line_item_id: firstSourceReceiptPoLineId(payload) ?? "",
    quantity_good: mappedQty.quantity_good,
    receive_date: payload.production_dates.receive_date,
    warehouse_id: payload.warehouse_id ?? "",
    unit_composite_item_id: payload.product.unit_composite_item_id ?? "",
    unit_assembly_quantity: mappedQty.unit_assembly_quantity,
    luma_operation_id: buildLumaProductionOutputOperationId(
      payload.luma_finished_lot_id,
    ),
    quantity_damaged: payload.output.damaged_packaging ?? 0,
    quantity_ripped: payload.output.ripped_cards ?? 0,
    quantity_loose: mappedQty.quantity_loose,
    display_assembly_quantity: mappedQty.display_assembly_quantity,
    case_assembly_quantity: mappedQty.case_assembly_quantity,
    notes: opts?.notes ?? PRODUCTION_OUTPUT_SERVICE_COMMIT_NOTES,
    component_batches: payload.component_batches,
    source_receipts: outboundSourceReceipts,
    assembly_only: receiptGate.ok ? receiptGate.assemblyOnly : false,
  };

  if (payload.product.display_composite_item_id) {
    servicePayload.display_composite_item_id =
      payload.product.display_composite_item_id;
  }
  if (payload.product.case_composite_item_id) {
    servicePayload.case_composite_item_id = payload.product.case_composite_item_id;
  }
  if (payload.luma_workflow_bag_id) {
    servicePayload.luma_bag_id = payload.luma_workflow_bag_id;
  }
  if (payload.luma_operation_snapshot) {
    servicePayload.luma_operation_snapshot = payload.luma_operation_snapshot;
    servicePayload.verification = { mode: "snapshot" };
  }

  return servicePayload;
}
