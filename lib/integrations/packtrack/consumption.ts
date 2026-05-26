/**
 * Phase A — PackTrack consumption push.
 *
 * Called when a finishedLot transitions to RELEASED.
 * Reports packaging materials consumed so PackTrack can auto-maintain
 * Item.current_stock and daily_usage_rate.
 *
 * Auth: x-luma-packtrack-secret (existing shared secret).
 * Idempotent: re-sending the same finished_lot_id is safe.
 */

const PACKTRACK_CONSUMPTION_URL_ENV = "PACKTRACK_CONSUMPTION_URL";
const PACKTRACK_SECRET_ENV = "LUMA_PACKTRACK_SECRET";

export type ConsumptionMaterial = {
  material_code: string;
  qty_consumed: number;
  packaging_lot_id?: string;
  supplier_lot_number?: string;
};

export type PackTrackConsumptionPayload = {
  source: "LUMA";
  finished_lot_id: string;
  finished_lot_number: string;
  product_sku: string;
  units_produced: number;
  released_at: string; // ISO 8601
  consumed_materials: ConsumptionMaterial[];
};

export type ConsumptionSendResult =
  | { ok: true }
  | { ok: false; reason: string };

export function isConsumptionConfigured(): boolean {
  return !!(
    process.env[PACKTRACK_CONSUMPTION_URL_ENV] &&
    process.env[PACKTRACK_SECRET_ENV]
  );
}

export async function sendConsumptionToPackTrack(
  payload: PackTrackConsumptionPayload,
): Promise<ConsumptionSendResult> {
  if (!isConsumptionConfigured()) {
    return { ok: false, reason: "PACKTRACK_CONSUMPTION_URL or LUMA_PACKTRACK_SECRET not set" };
  }

  const url = process.env[PACKTRACK_CONSUMPTION_URL_ENV]!;
  const secret = process.env[PACKTRACK_SECRET_ENV]!;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-luma-packtrack-secret": secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.replace(secret, "[REDACTED]") };
  }
}
