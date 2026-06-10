// ZOHO-BAG-FINISH-RECEIVE-CLIENT — Luma bag-finish receive preview/commit endpoints.

import {
  buildAssemblyServiceHeaders,
  type AssemblyServiceCallResult,
  validateAssemblyServiceConfig,
} from "@/lib/zoho/assembly-service-client";

export const ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED_ENV =
  "ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED";

export function isBagFinishReceiveCommitEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED_ENV] === "true";
}

type FetchLike = typeof fetch;

export type BagFinishReceiveRequest = {
  source_bag_id: string;
  internal_receipt_number: string | null;
  purchaseorder_id: string;
  purchaseorder_line_item_id: string;
  raw_item_id: string;
  human_lot_number: string | null;
  received_quantity: number;
  receive_date: string;
  idempotency_key: string;
};

export type BagFinishReceiveClientPath =
  | "/zoho/luma/bag-receive/preview"
  | "/zoho/luma/bag-receive/commit";

async function postBagFinishReceive(opts: {
  path: BagFinishReceiveClientPath;
  payload: BagFinishReceiveRequest;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Preview always allowed when dry-run gate is on; commit requires explicit opt-in. */
  requireLiveWriteGate?: boolean;
}): Promise<AssemblyServiceCallResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

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

  const isPreview = opts.path.endsWith("/preview");
  if (!isPreview && !config.dryRunEnabled) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message:
        "Dry-run writes are disabled. Set ZOHO_DRY_RUN_WRITES_ENABLED=true to enable.",
      guardBlocked: true,
    };
  }

  if (opts.requireLiveWriteGate && !isPreview) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message:
        "Bag-finish receive commit is not authorized. Live Zoho receive commit requires PM approval.",
      guardBlocked: true,
    };
  }

  const headers = buildAssemblyServiceHeaders({
    bearerSecret: config.bearerSecret,
    brand: config.brand,
    idempotencyKey: opts.payload.idempotency_key,
  });

  const url = `${config.baseUrl}${opts.path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);

  let r: Response;
  try {
    r = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.payload),
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

export async function callBagFinishReceivePreview(
  payload: BagFinishReceiveRequest,
  opts?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  },
): Promise<AssemblyServiceCallResult> {
  return postBagFinishReceive({
    path: "/zoho/luma/bag-receive/preview",
    payload,
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

export async function callBagFinishReceiveCommit(
  payload: BagFinishReceiveRequest,
  opts?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  },
): Promise<AssemblyServiceCallResult> {
  const env = opts?.env ?? process.env;
  return postBagFinishReceive({
    path: "/zoho/luma/bag-receive/commit",
    payload,
    requireLiveWriteGate: !isBagFinishReceiveCommitEnabled(env),
    env,
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
