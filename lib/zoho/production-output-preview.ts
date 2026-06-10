import { createHash } from "node:crypto";
import { isProductionOutputPreviewEnabled } from "@/lib/zoho/production-output-config";
import { mapProductionOutputPreviewQuantities } from "@/lib/zoho/production-output-preview-quantities";

export const PRODUCTION_OUTPUT_PREVIEW_PATH =
  "/zoho/luma/production-output/preview";

export type ProductionOutputPreviewPayload = {
  purchaseorder_id: string;
  purchaseorder_line_item_id: string;
  quantity_good: number;
  receive_date: string;
  warehouse_id: string;
  unit_composite_item_id: string;
  unit_assembly_quantity: number;
  luma_operation_id: string;
  quantity_damaged: number;
  quantity_ripped: number;
  quantity_loose: number;
  display_assembly_quantity: number;
  case_assembly_quantity: number;
  display_composite_item_id?: string;
  case_composite_item_id?: string;
  luma_bag_id?: string;
  luma_workflow_session_id?: string;
  notes?: string;
  component_batches?: Array<{
    item_id: string;
    source_bag_id: string;
    human_lot_number: string;
    batches: Array<{ batch_id: string; out_quantity: number }>;
  }>;
  luma_operation_snapshot?: {
    luma_operation_id: string;
    status: "finalized";
    finalized_at: string;
    /** Luma internal products.id UUID. */
    product_id: string;
    product_family: string;
    finished_sku: string;
    /** Zoho finished-good unit composite item ID. */
    unit_composite_item_id: string;
    workflow_bag_id: string;
    finished_lot_id: string;
    source_allocations: Array<{
      source_bag_id: string;
      item_id: string;
      human_lot_number: string;
      quantity: number;
    }>;
  };
  verification?: { mode: "snapshot" };
  /** When true, Zoho Integration skips purchase receive (raw intake already received). */
  assembly_only?: boolean;
  /** Canonical Zoho Integration v1.20.8 field — not source_receipt_evidence. */
  source_receipts?: Array<{
    source_bag_id: string;
    purchaseorder_id: string | null;
    purchaseorder_line_item_id: string | null;
    raw_item_id: string | null;
    zoho_purchase_receive_id: string | null;
    received_quantity: number | null;
    receive_status: string;
    reconciliation_status: string;
    received_at: string | null;
    receive_idempotency_key: string;
  }>;
};

export type ProductionOutputPreviewBuildInput = {
  finishedLotId: string;
  workflowBagId: string | null;
  producedOn: string;
  unitsProduced: number;
  displaysProduced: number | null;
  casesProduced: number | null;
  product: {
    zohoItemIdUnit: string | null;
    zohoItemIdDisplay: string | null;
    zohoItemIdCase: string | null;
  } | null;
  metrics?: {
    damagedPackaging: number | null;
    rippedCards: number | null;
    looseCards: number | null;
  } | null;
  mapping: {
    purchaseorderId: string;
    purchaseorderLineItemId: string;
    warehouseId: string;
    notes?: string | null;
  };
};

export type ProductionOutputPreviewBlocker = {
  field: string;
  message: string;
};

export type ProductionOutputDataQualityState = "HIGH" | "LOW" | "MISSING";

export type ProductionOutputPreviewBuildResult =
  | { ok: true; payload: ProductionOutputPreviewPayload }
  | { ok: false; blockers: ProductionOutputPreviewBlocker[] };

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function buildProductionOutputOperationId(
  finishedLotId: string,
): string {
  return `luma-production-output-preview:${finishedLotId}`;
}

export function buildProductionOutputPreviewPayload(
  input: ProductionOutputPreviewBuildInput,
): ProductionOutputPreviewBuildResult {
  const blockers: ProductionOutputPreviewBlocker[] = [];
  const purchaseorderId = present(input.mapping.purchaseorderId);
  const purchaseorderLineItemId = present(
    input.mapping.purchaseorderLineItemId,
  );
  const warehouseId = present(input.mapping.warehouseId);
  const unitCompositeItemId = present(input.product?.zohoItemIdUnit);
  const displayCompositeItemId = present(input.product?.zohoItemIdDisplay);
  const caseCompositeItemId = present(input.product?.zohoItemIdCase);
  const displayAssemblyQuantity = input.displaysProduced ?? 0;
  const caseAssemblyQuantity = input.casesProduced ?? 0;
  const notes = present(input.mapping.notes);

  if (!purchaseorderId) {
    blockers.push({
      field: "purchaseorder_id",
      message: "Enter the Zoho purchase order ID for the finished output.",
    });
  }
  if (!purchaseorderLineItemId) {
    blockers.push({
      field: "purchaseorder_line_item_id",
      message: "Enter the Zoho PO line item ID for the finished output.",
    });
  }
  if (!warehouseId) {
    blockers.push({
      field: "warehouse_id",
      message:
        "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered.",
    });
  }
  if (!unitCompositeItemId) {
    blockers.push({
      field: "unit_composite_item_id",
      message: "Product is missing Zoho unit composite item ID.",
    });
  }
  if (displayAssemblyQuantity > 0 && !displayCompositeItemId) {
    blockers.push({
      field: "display_composite_item_id",
      message: "Product is missing Zoho display composite item ID.",
    });
  }
  if (caseAssemblyQuantity > 0 && !caseCompositeItemId) {
    blockers.push({
      field: "case_composite_item_id",
      message: "Product is missing Zoho case composite item ID.",
    });
  }
  if (notes && notes.length > 1000) {
    blockers.push({
      field: "notes",
      message: "Notes must be 1000 characters or fewer.",
    });
  }

  if (blockers.length > 0) return { ok: false, blockers };

  const mappedQty = mapProductionOutputPreviewQuantities({
    unitsProduced: input.unitsProduced,
    displaysProduced: displayAssemblyQuantity,
    casesProduced: caseAssemblyQuantity,
    looseCards: input.metrics?.looseCards ?? null,
  });

  const payload: ProductionOutputPreviewPayload = {
    purchaseorder_id: purchaseorderId as string,
    purchaseorder_line_item_id: purchaseorderLineItemId as string,
    quantity_good: mappedQty.quantity_good,
    receive_date: input.producedOn,
    warehouse_id: warehouseId as string,
    unit_composite_item_id: unitCompositeItemId as string,
    unit_assembly_quantity: mappedQty.unit_assembly_quantity,
    luma_operation_id: buildProductionOutputOperationId(input.finishedLotId),
    quantity_damaged: input.metrics?.damagedPackaging ?? 0,
    quantity_ripped: input.metrics?.rippedCards ?? 0,
    quantity_loose: mappedQty.quantity_loose,
    display_assembly_quantity: mappedQty.display_assembly_quantity,
    case_assembly_quantity: mappedQty.case_assembly_quantity,
  };

  if (displayAssemblyQuantity > 0 && displayCompositeItemId) {
    payload.display_composite_item_id = displayCompositeItemId;
  }
  if (caseAssemblyQuantity > 0 && caseCompositeItemId) {
    payload.case_composite_item_id = caseCompositeItemId;
  }
  if (input.workflowBagId) {
    payload.luma_bag_id = input.workflowBagId;
    payload.luma_workflow_session_id = input.workflowBagId;
  }
  if (notes) payload.notes = notes;

  return { ok: true, payload };
}

export function stableStringifyProductionOutputPreview(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyProductionOutputPreview(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringifyProductionOutputPreview(obj[key])}`,
    )
    .join(",")}}`;
}

export function buildProductionOutputPreviewRequestHash(
  payload: ProductionOutputPreviewPayload,
): string {
  return createHash("sha256")
    .update(stableStringifyProductionOutputPreview(payload))
    .digest("hex");
}

export function buildProductionOutputPreviewIdempotencyKey(
  finishedLotId: string,
  payload: ProductionOutputPreviewPayload,
): string {
  const hash = buildProductionOutputPreviewRequestHash(payload).slice(0, 16);
  return `luma-production-output-preview-${finishedLotId}-${hash}`;
}

export function classifyProductionOutputMetricsState(input: {
  workflowBagId: string | null;
  metrics:
    | {
        damagedPackaging: number | null;
        rippedCards: number | null;
        looseCards: number | null;
      }
    | null
    | undefined;
}): ProductionOutputDataQualityState {
  return input.workflowBagId && input.metrics ? "HIGH" : "MISSING";
}

export function classifyProductionOutputGenealogyState(input: {
  workflowBagId: string | null;
  rawBagLinkCount: number;
  highConfidenceRawBagLinkCount: number;
}): ProductionOutputDataQualityState {
  if (input.workflowBagId && input.highConfidenceRawBagLinkCount > 0)
    return "HIGH";
  if (input.workflowBagId || input.rawBagLinkCount > 0) return "LOW";
  return "MISSING";
}

export type ProductionOutputPreviewConfig =
  | {
      ok: true;
      baseUrl: string;
      bearerSecret: string;
      brand: string;
      defaultWarehouseId: string | null;
    }
  | { ok: false; reason: string };

export function validateProductionOutputPreviewConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionOutputPreviewConfig {
  const rawUrl = env["ZOHO_SERVICE_BASE_URL"] ?? env["ZOHO_INTEGRATION_URL"];
  const rawBearer = env["ZOHO_SERVICE_BEARER_SECRET"];
  const rawBrand = env["ZOHO_BRAND"];
  const rawWarehouseId = env["ZOHO_WAREHOUSE_ID"];

  if (!rawUrl || rawUrl.trim().length === 0) {
    return {
      ok: false,
      reason:
        "ZOHO_SERVICE_BASE_URL (or ZOHO_INTEGRATION_URL) is not configured.",
    };
  }
  const baseUrl = rawUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: `ZOHO_SERVICE_BASE_URL must use http: or https: (got ${parsed.protocol}).`,
      };
    }
  } catch {
    return { ok: false, reason: "ZOHO_SERVICE_BASE_URL is not a valid URL." };
  }

  if (!rawBearer || rawBearer.trim().length === 0) {
    return {
      ok: false,
      reason: "ZOHO_SERVICE_BEARER_SECRET is not configured.",
    };
  }

  if (!isProductionOutputPreviewEnabled(env)) {
    return {
      ok: false,
      reason:
        "ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED is false (or preview/persist gate combination is invalid).",
    };
  }

  return {
    ok: true,
    baseUrl,
    bearerSecret: rawBearer.trim(),
    brand: present(rawBrand) ?? "haute_brands",
    defaultWarehouseId: present(rawWarehouseId),
  };
}

export function buildProductionOutputPreviewHeaders(opts: {
  bearerSecret: string;
  brand: string;
  idempotencyKey: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.bearerSecret}`,
    "X-Brand": opts.brand,
    "Idempotency-Key": opts.idempotencyKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

type FetchLike = typeof fetch;

export type ProductionOutputPreviewCallResult =
  | {
      ok: true;
      httpStatus: number;
      body: unknown;
      idempotencyReplay: boolean | null;
    }
  | {
      ok: false;
      httpStatus: number | null;
      body: unknown;
      message: string;
      idempotencyReplay: boolean | null;
    };

export async function callProductionOutputPreview(opts: {
  payload: ProductionOutputPreviewPayload;
  idempotencyKey: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<ProductionOutputPreviewCallResult> {
  const config = validateProductionOutputPreviewConfig(opts.env ?? process.env);
  if (!config.ok) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message: config.reason,
      idempotencyReplay: null,
    };
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  let response: Response;

  try {
    response = await (opts.fetchImpl ?? fetch)(
      `${config.baseUrl}${PRODUCTION_OUTPUT_PREVIEW_PATH}`,
      {
        method: "POST",
        headers: buildProductionOutputPreviewHeaders({
          bearerSecret: config.bearerSecret,
          brand: config.brand,
          idempotencyKey: opts.idempotencyKey,
        }),
        body: JSON.stringify(opts.payload),
        signal: ctrl.signal,
      },
    );
    clearTimeout(timeout);
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message: `Network error: ${message.replace(config.bearerSecret, "[REDACTED]")}`,
      idempotencyReplay: null,
    };
  }

  const idempotencyReplay = parseReplayHeader(response.headers);
  const body = await parseResponseBody(response);

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, httpStatus: response.status, body, idempotencyReplay };
  }

  return {
    ok: false,
    httpStatus: response.status,
    body,
    message: productionOutputPreviewStatusMessage(response.status),
    idempotencyReplay,
  };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseReplayHeader(headers: Headers): boolean | null {
  const value =
    headers.get("Idempotency-Replayed") ??
    headers.get("X-Idempotency-Replayed") ??
    headers.get("Idempotency-Replay");
  if (value == null) return null;
  return ["1", "true", "yes", "replayed"].includes(value.toLowerCase());
}

export function productionOutputPreviewStatusMessage(status: number): string {
  if (status === 400 || status === 422) {
    return `Zoho preview validation returned HTTP ${status}. Check the PO, PO line, warehouse, item mappings, or remaining PO quantity.`;
  }
  if (status === 401 || status === 403) {
    return `Zoho preview auth/capability issue: HTTP ${status}.`;
  }
  if (status === 409) {
    return "Zoho preview idempotency conflict: the same key was already used with a different payload.";
  }
  return `Zoho Integration Service returned HTTP ${status}.`;
}
