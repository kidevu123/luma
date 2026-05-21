// PT-7E — Luma → PackTrack shortage recommendation outbound client.
//
// This module is the *only* place that contains an HTTP call to
// PackTrack. The send action in
// app/(admin)/material-alerts/actions.ts gates every row through PT-7B
// (sendable_to_packtrack, confidence != MISSING) and PT-7D (acknowledged,
// not dismissed) before calling sendRecommendationToPackTrack.
//
// Strict rules baked in here:
//   - recommendation_id is the idempotency key. PackTrack must treat
//     duplicate POSTs with the same id as a no-op.
//   - No automatic sends. Every send is operator-triggered from the UI.
//   - No PO creation from Luma. PackTrack creates the PO after owner
//     approval on its own surface.
//   - MISSING-confidence rows cannot be sent (double-checked here in
//     addition to the action's pre-flight).
//   - Secrets are never logged. Errors include status code + body
//     snippet but never the secret header.
//   - Missing env returns NOT_CONFIGURED — UI can disable the button
//     and the action can short-circuit.

import type {
  ShortageConfidence,
  ShortageSeverity,
  ShortageSignal,
} from "@/lib/production/packtrack-shortage";

// ─── Env / config ──────────────────────────────────────────────────────

export const PACKTRACK_RECOMMENDATION_URL_ENV =
  "PACKTRACK_RECOMMENDATION_URL";
export const PACKTRACK_RECOMMENDATION_SECRET_ENV =
  "PACKTRACK_RECOMMENDATION_SECRET";

export type RecommendationConfigStatus = {
  configured: boolean;
  endpointConfigured: boolean;
  secretConfigured: boolean;
  /** When configured=false, lists which env var(s) are missing. */
  missing: string[];
};

/** Inspect env vars (no logging, no secret leakage). Returns a small
 *  status object the UI can render and the action can short-circuit on. */
export function validatePackTrackRecommendationConfig(
  env: { url?: string | undefined; secret?: string | undefined } = {
    ...(process.env[PACKTRACK_RECOMMENDATION_URL_ENV] != null
      ? { url: process.env[PACKTRACK_RECOMMENDATION_URL_ENV] }
      : {}),
    ...(process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV] != null
      ? { secret: process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV] }
      : {}),
  },
): RecommendationConfigStatus {
  const endpointConfigured =
    typeof env.url === "string" && env.url.trim().length > 0;
  const secretConfigured =
    typeof env.secret === "string" && env.secret.trim().length > 0;
  const missing: string[] = [];
  if (!endpointConfigured) missing.push(PACKTRACK_RECOMMENDATION_URL_ENV);
  if (!secretConfigured) missing.push(PACKTRACK_RECOMMENDATION_SECRET_ENV);
  return {
    configured: endpointConfigured && secretConfigured,
    endpointConfigured,
    secretConfigured,
    missing,
  };
}

// ─── Payload contract ─────────────────────────────────────────────────

export type RecommendationPayloadInput = {
  recommendationId: string;
  materialCode: string | null;
  materialName: string;
  productSku: string | null;
  productName: string | null;
  compatibilityRole: string | null;
  currentOnHand: number | null;
  acceptedInventory: number | null;
  projectedDemand: number | null;
  projectedShortageQuantity: number | null;
  recommendedOrderQuantity: number | null;
  neededByDate: string | null;
  confidence: ShortageConfidence;
  severity: ShortageSeverity;
  reason: string;
  sourceSignals: ShortageSignal[];
  recommendedSupplierHint: string | null;
  generatedAt: Date;
};

/** Wire-shape payload posted to PackTrack. schema_version is bumped
 *  if the contract ever changes; PackTrack is expected to be tolerant
 *  of unknown fields per the standard webhook discipline. */
export type PackTrackRecommendationPayload = {
  schema_version: "1.0";
  source: "LUMA";
  recommendation_id: string;
  material_code: string | null;
  material_name: string;
  product_code: string | null;
  product_name: string | null;
  compatibility_role: string | null;
  current_on_hand: number | null;
  accepted_inventory: number | null;
  projected_demand: number | null;
  projected_shortage_quantity: number | null;
  recommended_order_quantity: number | null;
  needed_by_date: string | null;
  confidence: ShortageConfidence;
  severity: ShortageSeverity;
  reason: string;
  supporting_signals: ShortageSignal[];
  recommended_supplier_hint: string | null;
  generated_at: string;
  luma_links: {
    /** Best-effort deep link back into Luma for the operator who is
     *  reviewing on PackTrack's side. Filled in when APP_URL is set. */
    material_alerts?: string;
  };
};

export function buildPackTrackRecommendationPayload(
  row: RecommendationPayloadInput,
  opts: { appBaseUrl?: string | null } = {},
): PackTrackRecommendationPayload {
  const luma_links: PackTrackRecommendationPayload["luma_links"] = {};
  if (opts.appBaseUrl && opts.appBaseUrl.trim().length > 0) {
    luma_links.material_alerts =
      opts.appBaseUrl.replace(/\/+$/, "") + "/material-alerts";
  }

  return {
    schema_version: "1.0",
    source: "LUMA",
    recommendation_id: row.recommendationId,
    material_code: row.materialCode,
    material_name: row.materialName,
    product_code: row.productSku,
    product_name: row.productName,
    compatibility_role: row.compatibilityRole,
    current_on_hand: row.currentOnHand,
    accepted_inventory: row.acceptedInventory,
    projected_demand: row.projectedDemand,
    projected_shortage_quantity: row.projectedShortageQuantity,
    recommended_order_quantity: row.recommendedOrderQuantity,
    needed_by_date: row.neededByDate,
    confidence: row.confidence,
    severity: row.severity,
    reason: row.reason,
    supporting_signals: row.sourceSignals,
    recommended_supplier_hint: row.recommendedSupplierHint,
    generated_at: row.generatedAt.toISOString(),
    luma_links,
  };
}

// ─── Send ─────────────────────────────────────────────────────────────

export type SendResult =
  | {
      ok: true;
      /** ISO timestamp of when the send succeeded (Luma clock). */
      sentAt: string;
      status: number;
      mapped: MappedRecommendationResponse;
      rawBody: unknown;
    }
  | {
      ok: false;
      reason: string;
      code:
        | "NOT_CONFIGURED"
        | "BLOCKED_BY_CONFIDENCE"
        | "BLOCKED_BY_QUANTITY"
        | "HTTP_ERROR"
        | "NETWORK_ERROR"
        | "INVALID_RESPONSE";
      status?: number;
      /** Best-effort response body for debugging — already trimmed and
       *  with anything that looks like a secret stripped (defense in
       *  depth; the secret never leaves Luma). */
      bodySnippet?: string;
    };

/** Maps a PackTrack response body into the small shape we surface in
 *  the recommendation row's last_sent_response. Tolerant of unknown
 *  shapes: anything PackTrack sends that doesn't fit gets preserved
 *  under `raw`. */
export type MappedRecommendationResponse = {
  packtrack_recommendation_id?: string | null;
  status?: string | null;
  message?: string | null;
  raw?: unknown;
};

export function mapPackTrackRecommendationResponse(
  body: unknown,
): MappedRecommendationResponse {
  if (body == null || typeof body !== "object") {
    return { raw: body };
  }
  const b = body as Record<string, unknown>;
  const out: MappedRecommendationResponse = {};
  if (typeof b.recommendation_id === "string") {
    out.packtrack_recommendation_id = b.recommendation_id;
  } else if (typeof b.id === "string") {
    out.packtrack_recommendation_id = b.id;
  }
  if (typeof b.status === "string") out.status = b.status;
  if (typeof b.message === "string") out.message = b.message;
  out.raw = body;
  return out;
}

type FetchLike = typeof fetch;

/** Post a single recommendation to PackTrack. Caller is responsible
 *  for ensuring the row passes all gates *before* invoking this — the
 *  client double-checks confidence and quantity defensively. */
export async function sendRecommendationToPackTrack(
  row: RecommendationPayloadInput,
  opts: {
    /** Override the default process.env-driven config. Tests use this. */
    config?: { url: string; secret: string };
    /** Override fetch for tests. */
    fetchImpl?: FetchLike;
    appBaseUrl?: string | null;
    /** Defaults to 10s. PackTrack's recommendation inbox should be
     *  cheap — we don't expect long calls. */
    timeoutMs?: number;
  } = {},
): Promise<SendResult> {
  // Defense-in-depth gate: never send MISSING-confidence even if a caller
  // forgot the action-level check.
  if (row.confidence === "MISSING") {
    return {
      ok: false,
      code: "BLOCKED_BY_CONFIDENCE",
      reason: "MISSING confidence rows must not be sent to PackTrack.",
    };
  }
  if (
    row.recommendedOrderQuantity == null ||
    row.recommendedOrderQuantity <= 0
  ) {
    return {
      ok: false,
      code: "BLOCKED_BY_QUANTITY",
      reason:
        "recommended_order_quantity must be > 0 to send to PackTrack.",
    };
  }

  const configFromArg = opts.config;
  const status = configFromArg
    ? { configured: true, endpointConfigured: true, secretConfigured: true, missing: [] }
    : validatePackTrackRecommendationConfig();
  if (!status.configured) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      reason: `PackTrack handoff not configured: missing ${status.missing.join(
        ", ",
      )}.`,
    };
  }
  const url = configFromArg
    ? configFromArg.url
    : (process.env[PACKTRACK_RECOMMENDATION_URL_ENV] ?? "");
  const secret = configFromArg
    ? configFromArg.secret
    : (process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV] ?? "");

  const payload = buildPackTrackRecommendationPayload(
    row,
    opts.appBaseUrl !== undefined ? { appBaseUrl: opts.appBaseUrl } : {},
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 10_000,
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-luma-packtrack-secret": secret,
        "x-luma-recommendation-id": row.recommendationId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const message =
      err instanceof Error ? err.message : "Unknown network error";
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: `Network error contacting PackTrack: ${stripSecret(
        message,
        secret,
      )}`,
    };
  }
  clearTimeout(timeout);

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // ignore; bodyText stays empty
  }
  const bodySnippet = stripSecret(bodyText.slice(0, 500), secret);

  if (!response.ok) {
    return {
      ok: false,
      code: "HTTP_ERROR",
      status: response.status,
      bodySnippet,
      reason: `PackTrack responded HTTP ${response.status}.`,
    };
  }

  let parsed: unknown = null;
  if (bodyText.length > 0) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        status: response.status,
        bodySnippet,
        reason:
          "PackTrack response was not valid JSON. Treating as failure.",
      };
    }
  }

  return {
    ok: true,
    status: response.status,
    sentAt: new Date().toISOString(),
    mapped: mapPackTrackRecommendationResponse(parsed),
    rawBody: parsed,
  };
}

// ─── Internals ────────────────────────────────────────────────────────

/** Defensive: never echo the secret back, even if PackTrack's error
 *  message includes it for some reason. */
function stripSecret(s: string, secret: string): string {
  if (!secret) return s;
  return s.split(secret).join("[REDACTED]");
}
