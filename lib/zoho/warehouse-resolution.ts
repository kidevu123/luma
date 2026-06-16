// WAREHOUSE-RESOLUTION-v1.3.0 — Pure helper that picks a Zoho
// warehouse_id from four candidate sources (or blocks).
//
// Sources, in precedence order:
//
//   1. operator   — explicit pick on the production-output preview
//                   form (the highest-priority last-mile override)
//   2. product    — products.zoho_default_warehouse_id; per-product
//                   override for brands that ship to different
//                   warehouses (HauteRaz vs BlueRaz vs Sweet Trip)
//   3. appSettings — zoho_credentials.warehouse_id; the app-wide
//                   default, set on /settings/zoho
//   4. env        — process.env.ZOHO_WAREHOUSE_ID; kept as a
//                   fallback so LXC-level operators can still set
//                   one without DB access, but no longer the
//                   primary source
//
// Returns {ok:true, warehouseId, source} on hit, {ok:false, reason}
// on miss with an operator-actionable error string. The error string
// is what the preview surface should display verbatim.
//
// This module is pure (no I/O, no DB, no env reads). Callers gather
// candidates from their respective stores and pass them in. That
// keeps the helper trivially testable and the precedence rule pinned
// in one place.

export const WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE =
  "No warehouse configured. Set one in Zoho settings or choose a warehouse on the preview form.";

export type WarehouseResolutionSource =
  | "operator"
  | "product"
  | "appSettings"
  | "env";

export type WarehouseResolutionInput = {
  /** Operator's explicit pick on the preview form. May be empty. */
  operatorOverride?: string | null | undefined;
  /** products.zoho_default_warehouse_id for the lot's product. */
  productWarehouseId?: string | null | undefined;
  /** zoho_credentials.warehouse_id (the app-level default). */
  appSettingsWarehouseId?: string | null | undefined;
  /** process.env.ZOHO_WAREHOUSE_ID. */
  envWarehouseId?: string | null | undefined;
};

export type WarehouseResolutionResult =
  | { ok: true; warehouseId: string; source: WarehouseResolutionSource }
  | { ok: false; reason: string };

function present(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the production-output warehouse_id given four candidate
 * sources. Precedence:
 *
 *   operator > product > appSettings > env > BLOCKED
 *
 * Each candidate is treated as "present" only if it's a non-empty
 * trimmed string. NULL / undefined / "" / "   " all fall through.
 */
export function resolveProductionOutputWarehouseId(
  input: WarehouseResolutionInput,
): WarehouseResolutionResult {
  const operator = present(input.operatorOverride);
  if (operator) {
    return { ok: true, warehouseId: operator, source: "operator" };
  }

  const product = present(input.productWarehouseId);
  if (product) {
    return { ok: true, warehouseId: product, source: "product" };
  }

  const appSettings = present(input.appSettingsWarehouseId);
  if (appSettings) {
    return { ok: true, warehouseId: appSettings, source: "appSettings" };
  }

  const env = present(input.envWarehouseId);
  if (env) {
    return { ok: true, warehouseId: env, source: "env" };
  }

  return { ok: false, reason: WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE };
}

/**
 * Short human-readable label for a resolved source. Used inline on
 * the preview form so the operator can see at a glance whether the
 * pre-filled value came from product config, app settings, or env.
 */
export function describeWarehouseSource(
  source: WarehouseResolutionSource,
): string {
  switch (source) {
    case "operator":
      return "Operator pick";
    case "product":
      return "Product default";
    case "appSettings":
      return "Zoho settings default";
    case "env":
      return "Environment fallback";
  }
}
