// ZOHO-PRODUCTION-OUTPUT-SERVICE-CLIENT — HTTP commit to shared Zoho service.
// Luma never calls Zoho Books/Inventory directly.

import { PRODUCTION_OUTPUT_COMMIT_PATH } from "@/lib/zoho/luma-production-output-payload";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import {
  isProductionOutputCommitEnabled,
  redactProductionOutputServiceHeaders,
  validateProductionOutputServiceConfig,
} from "@/lib/zoho/production-output-config";

type FetchLike = typeof fetch;

export type ProductionOutputCommitSuccess = {
  ok: true;
  httpStatus: number;
  body: unknown;
  externalReferenceId: string | null;
  idempotencyReplay: boolean | null;
};

export type ProductionOutputCommitFailure = {
  ok: false;
  kind: "config" | "guard" | "service" | "network";
  httpStatus: number | null;
  body: unknown;
  message: string;
  idempotencyReplay: boolean | null;
};

export type ProductionOutputCommitResult =
  | ProductionOutputCommitSuccess
  | ProductionOutputCommitFailure;

function parseExternalReference(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const candidates = [
    obj.external_reference_id,
    obj.externalReferenceId,
    obj.reference_id,
    obj.referenceId,
    obj.zoho_reference_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function parseIdempotencyReplay(
  headers: Headers,
  body: unknown,
): boolean | null {
  const header =
    headers.get("x-idempotency-replay") ??
    headers.get("Idempotency-Replayed") ??
    headers.get("X-Idempotency-Replayed") ??
    headers.get("Idempotency-Replay");
  if (header === "true" || header === "1") return true;
  if (header === "false" || header === "0") return false;
  if (body != null && typeof body === "object") {
    const replay = (body as { idempotency_replay?: unknown }).idempotency_replay;
    if (typeof replay === "boolean") return replay;
  }
  return null;
}

export function buildProductionOutputCommitHeaders(opts: {
  bearerSecret: string;
  brand: string;
  idempotencyKey: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.bearerSecret}`,
    "X-Brand": opts.brand,
    "Idempotency-Key": opts.idempotencyKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Luma-Source": "luma",
  };
}

export async function callProductionOutputCommit(opts: {
  payload: ProductionOutputPreviewPayload;
  idempotencyKey: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<ProductionOutputCommitResult> {
  const config = validateProductionOutputServiceConfig(opts.env ?? process.env);
  if (!config.ok) {
    return {
      ok: false,
      kind: "config",
      httpStatus: null,
      body: null,
      message: config.reason,
      idempotencyReplay: null,
    };
  }

  if (!isProductionOutputCommitEnabled(opts.env ?? process.env)) {
    return {
      ok: false,
      kind: "guard",
      httpStatus: null,
      body: null,
      message:
        "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED is false — live production-output commit is disabled.",
      idempotencyReplay: null,
    };
  }

  const headers = buildProductionOutputCommitHeaders({
    bearerSecret: config.bearerSecret,
    brand: config.brand,
    idempotencyKey: opts.idempotencyKey,
  });

  const url = `${config.baseUrl}${PRODUCTION_OUTPUT_COMMIT_PATH}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 30_000,
  );

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    let body: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    const idempotencyReplay = parseIdempotencyReplay(res.headers, body);

    if (res.ok) {
      return {
        ok: true,
        httpStatus: res.status,
        body,
        externalReferenceId: parseExternalReference(body),
        idempotencyReplay,
      };
    }

    const message =
      body != null &&
      typeof body === "object" &&
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `Zoho production-output commit failed with HTTP ${res.status}.`;

    return {
      ok: false,
      kind: "service",
      httpStatus: res.status,
      body,
      message,
      idempotencyReplay,
    };
  } catch (err) {
    clearTimeout(timeout);
    const message =
      err instanceof Error ? err.message : "Network error calling Zoho service.";
    if (process.env.NODE_ENV !== "test") {
      console.error(
        "[zoho.production-output.commit] network failure",
        redactProductionOutputServiceHeaders(headers),
        message,
      );
    }
    return {
      ok: false,
      kind: "network",
      httpStatus: null,
      body: null,
      message,
      idempotencyReplay: null,
    };
  }
}
