/**
 * Phase B — Zoho manufacture order creation.
 *
 * Called when a finishedLot transitions to RELEASED.
 * Creates a Zoho Manufacture Order to convert packaging material stock
 * into finished goods in Zoho's inventory.
 *
 * Auth: X-Internal-Token + X-Brand headers (same as all Zoho gateway calls).
 * Never throws — returns {ok, reason} so failures don't block lot release.
 *
 * NOTE: The gateway currently operates in dry_run mode only
 * (ENABLE_LIVE_INVENTORY_WRITES=false). In dry-run mode the gateway validates
 * and records idempotency but does not write to Zoho. The response contains
 * `dry_run: true` and a `would_call` preview.  A successful dry_run is still
 * recorded as ok=true so that Luma tracks the attempt; the manufacture_order_id
 * will be empty until live writes are enabled.
 */

type BomItem = {
  item_id: string;  // Zoho item ID of the packaging material
  quantity: number;
};

export type ManufactureOrderPayload = {
  composite_item_id: string;    // Zoho item ID of the finished product
  quantity_to_manufacture: number;
  manufacture_date: string;     // YYYY-MM-DD
  bill_of_materials: BomItem[];
  luma_finished_lot_id?: string;
};

export type ManufactureOrderResult =
  | { ok: true; manufacture_order_id: string; manufacture_order_number: string; dry_run: boolean }
  | { ok: false; reason: string };

export function isManufacturingConfigured(): boolean {
  return !!(
    process.env.ZOHO_INTEGRATION_URL &&
    process.env.ZOHO_INTEGRATION_SECRET &&
    process.env.ZOHO_BRAND
  );
}

export async function createManufactureOrder(
  payload: ManufactureOrderPayload,
): Promise<ManufactureOrderResult> {
  if (!isManufacturingConfigured()) {
    return { ok: false, reason: "Zoho gateway not configured" };
  }
  if (payload.bill_of_materials.length === 0) {
    return { ok: false, reason: "No BOM items — all packaging materials missing zohoItemId" };
  }

  const base = process.env.ZOHO_INTEGRATION_URL!.replace(/\/$/, "");
  const secret = process.env.ZOHO_INTEGRATION_SECRET!;
  const brand = process.env.ZOHO_BRAND!;

  // Idempotency key: stable per finished lot + composite item
  const idempotencyKey = `mfg-${payload.luma_finished_lot_id ?? payload.composite_item_id}-${payload.manufacture_date}`;

  // Luma operation ID: stable identifier for audit trail
  const lumaOperationId = `luma-mfg-${payload.luma_finished_lot_id ?? payload.composite_item_id}`;

  const requestBody = {
    dry_run: true, // Gateway is dry-run only until ENABLE_LIVE_INVENTORY_WRITES is enabled
    luma_operation_id: lumaOperationId,
    composite_item_id: payload.composite_item_id,
    quantity_to_manufacture: payload.quantity_to_manufacture,
    manufacture_date: payload.manufacture_date,
    bill_of_materials: payload.bill_of_materials,
    ...(payload.luma_finished_lot_id
      ? { luma_finished_lot_id: payload.luma_finished_lot_id }
      : {}),
  };

  try {
    const res = await fetch(`${base}/zoho/manufacturing_orders/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": secret,
        "X-Brand": brand,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (!res.ok) {
      const errDetail = body.error as Record<string, unknown> | undefined;
      const errMsg = String(errDetail?.message ?? body.error ?? res.statusText).slice(0, 200);
      return { ok: false, reason: `HTTP ${res.status}: ${errMsg}` };
    }

    // Dry-run response: { dry_run: true, would_call: {...}, meta: {...} }
    // Live response (future): { ok: true, manufacture_order_id: "...", manufacture_order_number: "..." }
    const isDryRun = body.dry_run === true;
    const orderId = String(body.manufacture_order_id ?? "");
    const orderNumber = String(body.manufacture_order_number ?? "");

    return {
      ok: true,
      manufacture_order_id: orderId,
      manufacture_order_number: orderNumber,
      dry_run: isDryRun,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.replace(secret, "[REDACTED]") };
  }
}
