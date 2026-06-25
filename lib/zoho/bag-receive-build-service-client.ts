// ZOHO-BAG-RECEIVE-BUILD-CLIENT (Z-4) — isolated, read-only client for the
// integration service endpoint:
//
//   POST /zoho/luma/bag-receive/build   (service S-1, capability luma.raw_intake.build)
//
// Equivalence-proof scaffolding ONLY. This module is deliberately NOT wired
// into preview/commit/freeze runtime paths. It exists so dual-run tests can
// compare Luma's local builder output against the service's build response.
//
// Read-only contract (per S-1):
//   - no live Zoho calls
//   - no preview/commit side effects
//   - no idempotency persistence
//   - no audit log writes
//
// Auth reuses the bearer model of the assembly endpoints (Authorization:
// Bearer + X-Brand). The build endpoint has no side effects, so it is NOT
// gated on ZOHO_DRY_RUN_WRITES_ENABLED.

import {
  validateAssemblyServiceConfig,
  buildAssemblyServiceHeaders,
  type AssemblyServiceCallResult,
} from "@/lib/zoho/assembly-service-client";
import { buildBagFinishReceiveIdempotencyKey } from "@/lib/zoho/source-receipt-evidence";
import type { BagFinishReceiveBuildInput } from "@/lib/zoho/bag-finish-receive";

export const BAG_RECEIVE_BUILD_PATH = "/zoho/luma/bag-receive/build";
export const BAG_RECEIVE_BUILD_CAPABILITY = "luma.raw_intake.build";

/** Z-3 domain request shape. Snake_case, domain-level — no Zoho wire fields. */
export type ProposedBagReceiveDomainRequest = {
  inventory_bag_id: string;
  luma_receive_id: string;
  internal_receipt_number: string | null;
  human_lot_number: string | null;
  received_quantity: number;
  quantity_source: string;
  receive_date: string;
  zoho_purchaseorder_id: string;
  zoho_purchaseorder_line_item_id: string;
  zoho_raw_item_id: string;
};

/** Pure mapper: Luma's internal BagFinishReceiveBuildInput → domain request.
 *  This is the only translation needed to call the service build endpoint. */
export function bagFinishReceiveBuildInputToDomainRequest(
  input: BagFinishReceiveBuildInput,
): ProposedBagReceiveDomainRequest {
  return {
    inventory_bag_id: input.inventoryBagId,
    luma_receive_id: input.lumaReceiveId,
    internal_receipt_number: input.internalReceiptNumber,
    human_lot_number: input.humanLotNumber,
    received_quantity: input.receivedQuantity,
    quantity_source: input.quantitySource,
    receive_date: input.receiveDate,
    zoho_purchaseorder_id: input.zohoPoId,
    zoho_purchaseorder_line_item_id: input.zohoLineItemId,
    zoho_raw_item_id: input.zohoTabletItemId,
  };
}

/** Documented S-1 build response shape. */
export type BagReceiveBuildServiceResponse = {
  zoho_purchase_receive_payload: Record<string, unknown>;
  preview_idempotency_key: string;
  commit_idempotency_key: string;
  receive_idempotency_key: string;
  normalized_request: Record<string, unknown>;
  blockers: ReadonlyArray<{ code: string; message: string }>;
  warnings: ReadonlyArray<{ code: string; message: string }>;
  meta: Record<string, unknown>;
};

type FetchLike = typeof fetch;

/** Read-only build call. Bearer-authenticated. Returns the shared
 *  AssemblyServiceCallResult union; callers parse `body` into
 *  BagReceiveBuildServiceResponse via parseBagReceiveBuildResponse. */
export async function callBagReceiveBuildService(
  domain: ProposedBagReceiveDomainRequest,
  opts?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  },
): Promise<AssemblyServiceCallResult> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  const config = validateAssemblyServiceConfig(env);
  if (!config.ok) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message: config.reason,
      guardBlocked: false,
    };
  }

  // Idempotency-Key is sent for request correlation only; the build
  // endpoint does not persist it (read-only). We use the preview
  // namespace so the gateway can correlate a build with the eventual
  // preview without minting a new key kind.
  const headers = buildAssemblyServiceHeaders({
    bearerSecret: config.bearerSecret,
    brand: config.brand,
    idempotencyKey: buildBagFinishReceiveIdempotencyKey(domain.inventory_bag_id),
  });

  const url = `${config.baseUrl}${BAG_RECEIVE_BUILD_PATH}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);

  let r: Response;
  try {
    r = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(domain),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
  } catch (err) {
    clearTimeout(tid);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message: `Network error: ${message}`,
      guardBlocked: false,
    };
  }

  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }

  if (r.status >= 200 && r.status < 300) {
    return { ok: true, httpStatus: r.status, body };
  }
  return {
    ok: false,
    httpStatus: r.status,
    body,
    message: `Zoho Integration Service returned HTTP ${r.status}`,
    guardBlocked: false,
  };
}

/** Best-effort parse of a build response body into the typed shape.
 *  Returns null when required top-level fields are absent. */
export function parseBagReceiveBuildResponse(
  body: unknown,
): BagReceiveBuildServiceResponse | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  // Some gateways wrap payloads under `data`. Accept both.
  const root =
    obj.data && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : obj;

  const payload = root["zoho_purchase_receive_payload"];
  const previewKey = root["preview_idempotency_key"];
  const commitKey = root["commit_idempotency_key"];
  const receiveKey = root["receive_idempotency_key"];
  const normalized = root["normalized_request"];
  if (
    typeof previewKey !== "string" ||
    typeof commitKey !== "string" ||
    typeof receiveKey !== "string" ||
    !payload ||
    typeof payload !== "object" ||
    !normalized ||
    typeof normalized !== "object"
  ) {
    return null;
  }

  return {
    zoho_purchase_receive_payload: payload as Record<string, unknown>,
    preview_idempotency_key: previewKey,
    commit_idempotency_key: commitKey,
    receive_idempotency_key: receiveKey,
    normalized_request: normalized as Record<string, unknown>,
    blockers: parseCodeMessageList(root["blockers"]),
    warnings: parseCodeMessageList(root["warnings"]),
    meta:
      root["meta"] && typeof root["meta"] === "object"
        ? (root["meta"] as Record<string, unknown>)
        : {},
  };
}

function parseCodeMessageList(
  raw: unknown,
): ReadonlyArray<{ code: string; message: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ code: string; message: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const code = typeof o["code"] === "string" ? o["code"] : null;
    const message = typeof o["message"] === "string" ? o["message"] : null;
    if (code && message) out.push({ code, message });
  }
  return out;
}

// ─── Dual-run comparison (pure) ─────────────────────────────────────────────

/** The Luma-side outputs that the dual-run compares against the service. */
export type LumaBagReceiveBuildSnapshot = {
  domain: ProposedBagReceiveDomainRequest;
  /** luma-bag-finish-receive:<inventory_bag_id> (per-bag preview/source namespace). */
  previewIdempotencyKey: string;
  /** rbg-<sha256> commit namespace. */
  commitIdempotencyKey: string;
  /** luma-bag-finish-receive:<inventory_bag_id> (outbound source receipt key). */
  receiveIdempotencyKey: string;
  /** buildRawBagReceiveNotes output. */
  notes: string;
};

export type FieldDiff = {
  field: string;
  luma: unknown;
  service: unknown;
  equal: boolean;
};

export type BagReceiveBuildDiff = {
  /** True when every domain value the service normalized matches Luma's. */
  normalizedRequestMatches: boolean;
  normalizedRequestFieldDiffs: FieldDiff[];
  previewKey: { luma: string; service: string; equal: boolean };
  commitKey: { luma: string; service: string; equal: boolean };
  receiveKey: { luma: string; service: string; equal: boolean };
  notesEqual: boolean;
};

const DOMAIN_VALUE_FIELDS: ReadonlyArray<keyof ProposedBagReceiveDomainRequest> = [
  "inventory_bag_id",
  "luma_receive_id",
  "internal_receipt_number",
  "human_lot_number",
  "received_quantity",
  "quantity_source",
  "receive_date",
  "zoho_purchaseorder_id",
  "zoho_purchaseorder_line_item_id",
  "zoho_raw_item_id",
];

/** Pure diff of Luma's local build against the service build response. */
export function diffBagReceiveBuild(
  luma: LumaBagReceiveBuildSnapshot,
  service: BagReceiveBuildServiceResponse,
): BagReceiveBuildDiff {
  const fieldDiffs: FieldDiff[] = [];
  for (const field of DOMAIN_VALUE_FIELDS) {
    const lumaVal = luma.domain[field];
    const serviceVal = service.normalized_request[field];
    fieldDiffs.push({
      field,
      luma: lumaVal,
      service: serviceVal,
      equal: lumaVal === serviceVal,
    });
  }
  const serviceNotes = extractServiceNotes(service);
  return {
    normalizedRequestMatches: fieldDiffs.every((d) => d.equal),
    normalizedRequestFieldDiffs: fieldDiffs,
    previewKey: {
      luma: luma.previewIdempotencyKey,
      service: service.preview_idempotency_key,
      equal: luma.previewIdempotencyKey === service.preview_idempotency_key,
    },
    commitKey: {
      luma: luma.commitIdempotencyKey,
      service: service.commit_idempotency_key,
      equal: luma.commitIdempotencyKey === service.commit_idempotency_key,
    },
    receiveKey: {
      luma: luma.receiveIdempotencyKey,
      service: service.receive_idempotency_key,
      equal: luma.receiveIdempotencyKey === service.receive_idempotency_key,
    },
    notesEqual: serviceNotes != null && serviceNotes === luma.notes,
  };
}

/** Pull the notes string from the service payload, tolerating either the
 *  zoho payload or the normalized request carrying it. */
export function extractServiceNotes(
  service: BagReceiveBuildServiceResponse,
): string | null {
  const fromPayload = service.zoho_purchase_receive_payload["notes"];
  if (typeof fromPayload === "string") return fromPayload;
  const fromNormalized = service.normalized_request["notes"];
  if (typeof fromNormalized === "string") return fromNormalized;
  return null;
}
