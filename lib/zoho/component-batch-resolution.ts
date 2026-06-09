// ZOHO-PRODUCTION-OUTPUT-V1206 — resolve human lot → Zoho batch_id via shared service.

import {
  redactProductionOutputServiceHeaders,
  validateProductionOutputServiceConfig,
} from "@/lib/zoho/production-output-config";
import {
  buildZohoBatchResolveRequestBody,
  ZOHO_BATCHES_RESOLVE_PATH,
  ZOHO_BATCH_ERROR_BATCH_MATCH_AMBIGUOUS,
  ZOHO_BATCH_ERROR_BATCH_NOT_FOUND,
  type ZohoBatchResolveResponse,
} from "@/lib/zoho/zoho-batch-resolve-contract";

export type BatchResolutionStatus =
  | "UNRESOLVED"
  | "UNIQUE"
  | "MISSING"
  | "AMBIGUOUS"
  | "OPERATOR_SELECTED"
  | "NOT_BATCH_TRACKED";

export type ZohoBatchCandidate = {
  batch_id: string;
  human_lot_number: string;
  item_id: string;
  batch_number?: string;
  available_balance?: number;
};

export type BatchLookupResult =
  | {
      status: "UNIQUE";
      batchId: string;
      batchNumber: string | null;
      availableBalance: number | null;
      candidates: [ZohoBatchCandidate];
    }
  | {
      status: "MISSING";
      batchId: null;
      batchNumber: null;
      availableBalance: null;
      candidates: [];
    }
  | {
      status: "AMBIGUOUS";
      batchId: null;
      batchNumber: null;
      availableBalance: null;
      candidates: ZohoBatchCandidate[];
    };

type FetchLike = typeof fetch;

function readErrorCode(body: Record<string, unknown>): string | null {
  const error = body.error;
  if (error != null && typeof error === "object") {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return null;
}

function parseCandidates(
  raw: unknown,
  itemId: string,
  humanLotNumber: string,
): ZohoBatchCandidate[] {
  const candidates: ZohoBatchCandidate[] = [];
  if (!Array.isArray(raw)) return candidates;
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const batchId = row.batch_id ?? row.batchId ?? row.id;
    if (typeof batchId !== "string" || !batchId.trim()) continue;
    const candidate: ZohoBatchCandidate = {
      batch_id: batchId.trim(),
      human_lot_number: String(
        row.human_lot_number ?? row.humanLotNumber ?? humanLotNumber,
      ),
      item_id: String(row.item_id ?? row.itemId ?? itemId),
    };
    if (typeof row.batch_number === "string") {
      candidate.batch_number = row.batch_number;
    }
    if (typeof row.available_balance === "number") {
      candidate.available_balance = row.available_balance;
    }
    candidates.push(candidate);
  }
  return candidates;
}

function isUniqueResolution(resolution: string, resolved: unknown): boolean {
  if (resolved === true) return true;
  return resolution === "unique";
}

function isMissingResolution(resolution: string, resolved: unknown): boolean {
  if (resolved === false && resolution === "missing") return true;
  return resolution === "missing" || resolution === "not_found";
}

function isAmbiguousResolution(resolution: string, resolved: unknown): boolean {
  if (resolved === false && resolution === "ambiguous") return true;
  return resolution === "ambiguous";
}

/** Normalize Zoho batch resolver HTTP response to internal status. */
export function classifyBatchResolveResponse(
  body: unknown,
  itemId: string,
  humanLotNumber: string,
  httpStatus?: number,
): BatchLookupResult {
  const missingBase = {
    status: "MISSING" as const,
    batchId: null,
    batchNumber: null,
    availableBalance: null,
    candidates: [] as [],
  };

  if (body == null || typeof body !== "object") {
    if (httpStatus === 404) return missingBase;
    return missingBase;
  }

  const obj = body as Record<string, unknown>;
  const resolution = String(obj.resolution ?? obj.status ?? "").toLowerCase();
  const resolved = obj.resolved;
  const errorCode = readErrorCode(obj);

  if (
    httpStatus === 404 ||
    errorCode === ZOHO_BATCH_ERROR_BATCH_NOT_FOUND ||
    isMissingResolution(resolution, resolved)
  ) {
    return missingBase;
  }

  if (
    httpStatus === 422 ||
    errorCode === ZOHO_BATCH_ERROR_BATCH_MATCH_AMBIGUOUS ||
    isAmbiguousResolution(resolution, resolved)
  ) {
    const candidates = parseCandidates(obj.candidates ?? obj.batches, itemId, humanLotNumber);
    return {
      status: "AMBIGUOUS",
      batchId: null,
      batchNumber: null,
      availableBalance: null,
      candidates,
    };
  }

  if (isUniqueResolution(resolution, resolved)) {
    const batchId = obj.batch_id ?? obj.batchId;
    if (typeof batchId === "string" && batchId.trim()) {
      const batchNumber =
        typeof obj.batch_number === "string" ? obj.batch_number : null;
      const availableBalance =
        typeof obj.available_balance === "number" ? obj.available_balance : null;
      return {
        status: "UNIQUE",
        batchId: batchId.trim(),
        batchNumber,
        availableBalance,
        candidates: [
          {
            batch_id: batchId.trim(),
            human_lot_number: String(obj.human_lot_number ?? humanLotNumber),
            item_id: String(obj.item_id ?? itemId),
            ...(batchNumber ? { batch_number: batchNumber } : {}),
            ...(availableBalance != null ? { available_balance: availableBalance } : {}),
          },
        ],
      };
    }
  }

  // Transitional: batch_id without resolved/resolution flags.
  const legacyBatchId = obj.batch_id ?? obj.batchId;
  if (typeof legacyBatchId === "string" && legacyBatchId.trim()) {
    return {
      status: "UNIQUE",
      batchId: legacyBatchId.trim(),
      batchNumber:
        typeof obj.batch_number === "string" ? obj.batch_number : null,
      availableBalance:
        typeof obj.available_balance === "number" ? obj.available_balance : null,
      candidates: [
        {
          batch_id: legacyBatchId.trim(),
          human_lot_number: String(obj.human_lot_number ?? humanLotNumber),
          item_id: String(obj.item_id ?? itemId),
        },
      ],
    };
  }

  return missingBase;
}

/** @deprecated use classifyBatchResolveResponse */
export function classifyBatchLookupResponse(body: unknown): BatchLookupResult {
  const obj = body != null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return classifyBatchResolveResponse(
    body,
    String(obj.item_id ?? ""),
    String(obj.human_lot_number ?? ""),
  );
}

function isClassifiableBatchResolveHttpStatus(status: number): boolean {
  return status === 200 || status === 404 || status === 422;
}

export async function resolveZohoComponentBatch(opts: {
  itemId: string;
  humanLotNumber: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}): Promise<
  | { ok: true; result: BatchLookupResult; raw: ZohoBatchResolveResponse | unknown }
  | { ok: false; kind: "config" | "network" | "service"; message: string }
> {
  const config = validateProductionOutputServiceConfig(opts.env ?? process.env);
  if (!config.ok) {
    return { ok: false, kind: "config", message: config.reason };
  }

  const url = `${config.baseUrl}${ZOHO_BATCHES_RESOLVE_PATH}`;
  const headers = {
    Authorization: `Bearer ${config.bearerSecret}`,
    "X-Brand": config.brand,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Luma-Source": "luma",
  };
  const requestBody = buildZohoBatchResolveRequestBody(
    opts.itemId,
    opts.humanLotNumber,
  );

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    let body: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (isClassifiableBatchResolveHttpStatus(res.status)) {
      return {
        ok: true,
        result: classifyBatchResolveResponse(
          body,
          opts.itemId,
          opts.humanLotNumber,
          res.status,
        ),
        raw: body,
      };
    }

    if (!res.ok) {
      if (process.env.NODE_ENV !== "test") {
        console.error(
          "[zoho.batch.resolve] service error",
          redactProductionOutputServiceHeaders(headers),
          res.status,
        );
      }
      return {
        ok: false,
        kind: "service",
        message: `Batch resolve failed with HTTP ${res.status}.`,
      };
    }

    return {
      ok: true,
      result: classifyBatchResolveResponse(
        body,
        opts.itemId,
        opts.humanLotNumber,
        res.status,
      ),
      raw: body,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Network error during batch resolve.";
    return { ok: false, kind: "network", message };
  }
}

/** @deprecated use resolveZohoComponentBatch */
export async function lookupZohoComponentBatch(opts: {
  itemId: string;
  humanLotNumber: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}): Promise<
  | { ok: true; result: BatchLookupResult }
  | { ok: false; kind: "config" | "network" | "service"; message: string }
> {
  const resolved = await resolveZohoComponentBatch(opts);
  if (!resolved.ok) return resolved;
  return { ok: true, result: resolved.result };
}
