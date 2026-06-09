// ZOHO-V1206 — Choco Drift preview preflight for packaging + raw tablet stock.

import {
  CHOCO_DRIFT_PACKAGING_ITEM_ID,
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  deriveChocoDriftBomConsumption,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";

export type ChocoDriftPreflightBlocker = {
  code:
    | "PACKAGING_STOCK_INSUFFICIENT"
    | "RAW_TABLET_STOCK_INSUFFICIENT"
    | "COMPONENT_PREFLIGHT_FAILED"
    | "RECEIVE_BLOCKED_BY_PREFLIGHT";
  message: string;
};

export type ChocoDriftPreflightComponent = {
  item_id: string;
  required: number;
  available: number;
  sufficient: boolean;
};

function readComponentsArray(previewResponse: unknown): ChocoDriftPreflightComponent[] {
  if (previewResponse == null || typeof previewResponse !== "object") return [];
  const obj = previewResponse as Record<string, unknown>;
  const candidates = [
    obj.components,
    (obj.preflight as Record<string, unknown> | undefined)?.components,
    (obj.verification as Record<string, unknown> | undefined)?.components,
  ];
  const out: ChocoDriftPreflightComponent[] = [];
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue;
    for (const row of raw) {
      if (row == null || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const itemId = item.item_id ?? item.itemId;
      if (typeof itemId !== "string") continue;
      const required = Number(item.required ?? item.quantity_required ?? item.need);
      const available = Number(item.available ?? item.quantity_available ?? item.stock);
      const sufficient =
        typeof item.sufficient === "boolean"
          ? item.sufficient
          : Number.isFinite(required) &&
            Number.isFinite(available) &&
            available >= required;
      if (!Number.isFinite(required) || !Number.isFinite(available)) continue;
      out.push({ item_id: itemId, required, available, sufficient });
    }
  }
  return out;
}

function readTopLevelStockError(previewResponse: unknown): string | null {
  if (previewResponse == null || typeof previewResponse !== "object") return null;
  const obj = previewResponse as Record<string, unknown>;
  const code = String(obj.code ?? obj.error_code ?? "").toUpperCase();
  const message = String(obj.message ?? obj.error ?? "");
  if (
    code.includes("PACKAGING") ||
    code.includes("BLISTER") ||
    code.includes("5277428")
  ) {
    return code || message;
  }
  if (
    code.includes("RAW") ||
    code.includes("TABLET") ||
    code.includes("5946408") ||
    code.includes("INSUFFICIENT")
  ) {
    return code || message;
  }
  return null;
}

export function evaluateChocoDriftPreviewPreflight(input: {
  sku: string;
  unitAssemblyQuantity: number;
  previewHttpStatus: number | null;
  previewResponse: unknown;
}): { ok: boolean; blockers: ChocoDriftPreflightBlocker[] } {
  if (!isChocoDriftSku(input.sku)) {
    return { ok: true, blockers: [] };
  }

  const blockers: ChocoDriftPreflightBlocker[] = [];
  const add = (code: ChocoDriftPreflightBlocker["code"], message: string) =>
    blockers.push({ code, message });

  const expected = deriveChocoDriftBomConsumption(input.unitAssemblyQuantity);
  const packagingRequired =
    expected.find((c) => c.item_id === CHOCO_DRIFT_PACKAGING_ITEM_ID)?.quantity_consumed ?? 0;
  const rawRequired =
    expected.find((c) => c.item_id === CHOCO_DRIFT_RAW_TABLET_ITEM_ID)?.quantity_consumed ?? 0;

  if (input.previewHttpStatus != null && input.previewHttpStatus >= 400) {
    const stockErr = readTopLevelStockError(input.previewResponse);
    if (stockErr) {
      add(
        "COMPONENT_PREFLIGHT_FAILED",
        `Preview blocked before receive/assembly: ${stockErr}`,
      );
      add("RECEIVE_BLOCKED_BY_PREFLIGHT", "No purchase receive or assembly write may proceed.");
    }
  }

  const components = readComponentsArray(input.previewResponse);
  const packaging = components.find((c) => c.item_id === CHOCO_DRIFT_PACKAGING_ITEM_ID);
  const rawTablet = components.find((c) => c.item_id === CHOCO_DRIFT_RAW_TABLET_ITEM_ID);

  if (packaging && (!packaging.sufficient || packaging.available < packagingRequired)) {
    add(
      "PACKAGING_STOCK_INSUFFICIENT",
      `Packaging item ${CHOCO_DRIFT_PACKAGING_ITEM_ID} requires ${packagingRequired} but only ${packaging.available} available.`,
    );
    add("RECEIVE_BLOCKED_BY_PREFLIGHT", "No purchase receive or assembly write may proceed.");
  }

  if (rawTablet && (!rawTablet.sufficient || rawTablet.available < rawRequired)) {
    add(
      "RAW_TABLET_STOCK_INSUFFICIENT",
      `Raw tablet item ${CHOCO_DRIFT_RAW_TABLET_ITEM_ID} requires ${rawRequired} but only ${rawTablet.available} available.`,
    );
    add("RECEIVE_BLOCKED_BY_PREFLIGHT", "No purchase receive or assembly write may proceed.");
  }

  const writesAllowed =
    input.previewResponse != null &&
    typeof input.previewResponse === "object" &&
    (input.previewResponse as Record<string, unknown>).writes_allowed === false;
  if (writesAllowed && blockers.length === 0) {
    const err = readTopLevelStockError(input.previewResponse);
    if (err) {
      add("COMPONENT_PREFLIGHT_FAILED", `Preview returned writes_allowed=false: ${err}`);
      add("RECEIVE_BLOCKED_BY_PREFLIGHT", "No purchase receive or assembly write may proceed.");
    }
  }

  return { ok: blockers.length === 0, blockers };
}
