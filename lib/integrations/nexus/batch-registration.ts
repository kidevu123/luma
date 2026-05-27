/**
 * Phase E — Automatic Nexus batch registration on finishedLot RELEASED.
 *
 * Every production batch is registered in Nexus so complaint agents
 * can select from real production data instead of free-text guessing.
 *
 * This is separate from lib/integrations/nexus/finished-lots.ts,
 * which handles customer-shipment-specific traceability.
 *
 * Never throws — returns { ok, reason } so failures never block lot release.
 *
 * Required env vars:
 *   NEXUS_URL          e.g. http://192.168.1.203
 *   LUMA_NEXUS_SECRET  shared secret, must match /opt/nexus-resolve/.env on LXC 119
 */

type PackagingInput = {
  material_code: string;
  material_name: string;
  supplier_lot_number: string;
};

export type BatchRegistrationPayload = {
  lot_number: string;
  product_sku: string;
  product_description: string;
  produced_on: string; // YYYY-MM-DD
  units_produced: number;
  luma_finished_lot_id: string;
  packaging_inputs: PackagingInput[];
};

export type BatchRegistrationResult =
  | { ok: true; batch_id: number; created: boolean }
  | { ok: false; reason: string };

/**
 * Returns true only when both required env vars are set.
 * Called before attempting registration so the fire-and-forget block can
 * short-circuit without making a network call.
 */
export function isBatchRegistrationConfigured(): boolean {
  return !!(process.env.NEXUS_URL && process.env.LUMA_NEXUS_SECRET);
}

/**
 * POSTs the payload to Nexus /api/batches/import.
 * Never throws — all errors are captured and returned as { ok: false, reason }.
 */
export async function registerBatchInNexus(
  payload: BatchRegistrationPayload,
): Promise<BatchRegistrationResult> {
  if (!isBatchRegistrationConfigured()) {
    return {
      ok: false,
      reason: "Nexus not configured (missing NEXUS_URL or LUMA_NEXUS_SECRET)",
    };
  }

  const base = process.env.NEXUS_URL!.replace(/\/$/, "");
  const secret = process.env.LUMA_NEXUS_SECRET!;

  try {
    const res = await fetch(`${base}/api/batches/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Luma-Nexus-Secret": secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      return {
        ok: false,
        reason: `HTTP ${res.status}: ${String(body.detail ?? res.statusText).slice(0, 200)}`,
      };
    }

    return {
      ok: true,
      batch_id: Number(body.batch_id),
      created: Boolean(body.created),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Redact the secret in case it appears in an error message
    return { ok: false, reason: msg.replace(secret, "[REDACTED]") };
  }
}
