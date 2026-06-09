// ZOHO-V1206 — canonical batch resolution contract (Zoho Integration).

/** Preferred resolver: human lot → Zoho batch_id. */
export const ZOHO_BATCHES_RESOLVE_PATH = "/zoho/items/batches/resolve";

/** List batches for an item (diagnostics / operator UI). */
export const zohoItemBatchesPath = (itemId: string): string =>
  `/zoho/items/${encodeURIComponent(itemId)}/batches`;

export const ZOHO_BATCH_ERROR_BATCH_NOT_FOUND = "BATCH_NOT_FOUND";
export const ZOHO_BATCH_ERROR_BATCH_MATCH_AMBIGUOUS = "BATCH_MATCH_AMBIGUOUS";

export type ZohoBatchResolveRequest = {
  item_id: string;
  human_lot_number: string;
};

/** Canonical success body (HTTP 200). */
export type ZohoBatchResolveSuccessResponse = {
  resolved: true;
  resolution: "unique";
  batch_id: string;
  batch_number: string;
  available_balance: number;
  item_id?: string;
  human_lot_number?: string;
};

/** Canonical missing body (HTTP 404). */
export type ZohoBatchResolveMissingResponse = {
  resolved: false;
  resolution: "missing";
  error?: { code: typeof ZOHO_BATCH_ERROR_BATCH_NOT_FOUND; message?: string };
  item_id?: string;
  human_lot_number?: string;
};

/** Canonical ambiguous body (HTTP 422). */
export type ZohoBatchResolveAmbiguousResponse = {
  resolved: false;
  resolution: "ambiguous";
  error?: { code: typeof ZOHO_BATCH_ERROR_BATCH_MATCH_AMBIGUOUS; message?: string };
  candidates: Array<{
    batch_id: string;
    batch_number?: string;
    human_lot_number?: string;
    item_id?: string;
    available_balance?: number;
  }>;
  item_id?: string;
  human_lot_number?: string;
};

/** Transitional shapes omit `resolved` but keep `resolution`. */
export type ZohoBatchResolveResponse =
  | ZohoBatchResolveSuccessResponse
  | ZohoBatchResolveMissingResponse
  | ZohoBatchResolveAmbiguousResponse
  | {
      resolution: "unique";
      batch_id: string;
      item_id?: string;
      human_lot_number?: string;
    };

export function buildZohoBatchResolveRequestBody(
  itemId: string,
  humanLotNumber: string,
): ZohoBatchResolveRequest {
  return {
    item_id: itemId.trim(),
    human_lot_number: humanLotNumber.trim(),
  };
}
