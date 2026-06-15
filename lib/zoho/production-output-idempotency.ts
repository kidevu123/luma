// ZOHO-PRODUCTION-OUTPUT-IDEMPOTENCY — preview vs commit keys + gateway error parsing.

import { createHash } from "node:crypto";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import {
  buildProductionOutputPreviewRequestHash,
  stableStringifyProductionOutputPreview,
} from "@/lib/zoho/production-output-preview";
import {
  buildLumaProductionOutputStableCommitIdempotencyKey,
} from "@/lib/zoho/luma-production-output-payload";
import type { ProductionOutputCommitFailure } from "@/lib/zoho/production-output-service-client";

/** Preview keys must never share the commit key namespace. */
export const PRODUCTION_OUTPUT_PREVIEW_IDEMPOTENCY_PREFIX =
  "luma-production-output-preview:" as const;

export const PRODUCTION_OUTPUT_COMMIT_IDEMPOTENCY_PREFIX =
  "luma-production-output:" as const;

export type ZohoIdempotencyErrorCode =
  | "ZOHO_IDEMPOTENCY_CONFLICT"
  | "ZOHO_IDEMPOTENCY_IN_PROGRESS"
  | "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS"
  | "UNKNOWN";

export function buildProductionOutputPreviewIdempotencyKeyV2(
  finishedLotId: string,
  payload: ProductionOutputPreviewPayload,
): string {
  const hash = buildProductionOutputPreviewRequestHash(payload).slice(0, 16);
  return `${PRODUCTION_OUTPUT_PREVIEW_IDEMPOTENCY_PREFIX}${finishedLotId}:${hash}`;
}

export function assertPreviewCommitIdempotencyKeysDistinct(
  finishedLotId: string,
  previewKey: string,
): void {
  const commitKey = buildLumaProductionOutputStableCommitIdempotencyKey(finishedLotId);
  if (previewKey === commitKey) {
    throw new Error(
      "Preview idempotency key must not equal the stable commit idempotency key.",
    );
  }
  if (previewKey.startsWith(PRODUCTION_OUTPUT_COMMIT_IDEMPOTENCY_PREFIX)) {
    throw new Error(
      "Preview idempotency key must not use the commit key prefix.",
    );
  }
}

export function hashProductionOutputServicePayload(
  payload: ProductionOutputPreviewPayload,
): string {
  return createHash("sha256")
    .update(stableStringifyProductionOutputPreview(payload))
    .digest("hex");
}

function digErrorCode(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const detail = obj.detail;
  if (detail != null && typeof detail === "object") {
    const err = (detail as { error?: unknown }).error;
    if (err != null && typeof err === "object") {
      const code = (err as { code?: unknown; internal_code?: unknown }).code
        ?? (err as { internal_code?: unknown }).internal_code;
      if (typeof code === "string" && code.trim()) return code.trim();
    }
    if (Array.isArray(detail)) {
      for (const item of detail) {
        if (item != null && typeof item === "object") {
          const code = (item as { code?: unknown }).code;
          if (typeof code === "string" && code.trim()) return code.trim();
        }
      }
    }
  }
  const top = obj.code ?? obj.error_code ?? obj.internal_code;
  if (typeof top === "string" && top.trim()) return top.trim();
  return null;
}

export function parseZohoGatewayErrorCode(body: unknown): ZohoIdempotencyErrorCode {
  const raw = digErrorCode(body);
  if (raw === "ZOHO_IDEMPOTENCY_CONFLICT") return "ZOHO_IDEMPOTENCY_CONFLICT";
  if (raw === "ZOHO_IDEMPOTENCY_IN_PROGRESS") return "ZOHO_IDEMPOTENCY_IN_PROGRESS";
  if (raw === "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS") {
    return "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS";
  }
  return "UNKNOWN";
}

export function isZohoCommitSuccessBody(body: unknown): boolean {
  if (body == null || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  if (obj.committed === true) return true;
  const steps = obj.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some(
    (s) =>
      s != null &&
      typeof s === "object" &&
      (s as { status?: string }).status === "succeeded" &&
      typeof (s as { zoho_entity_id?: string }).zoho_entity_id === "string",
  );
}

/** True when a safe idempotency replay may resolve an ambiguous gateway failure. */
export function shouldAttemptProductionOutputIdempotencyReplay(
  failure: ProductionOutputCommitFailure,
): boolean {
  if (failure.ok) return false;
  if (failure.kind === "config" || failure.kind === "guard") return false;
  if (failure.kind === "network") return true;
  if (failure.httpStatus == null) return false;
  if (failure.httpStatus >= 500) return true;
  const code = parseZohoGatewayErrorCode(failure.body);
  if (code === "ZOHO_IDEMPOTENCY_IN_PROGRESS") return true;
  if (code === "ZOHO_IDEMPOTENCY_CONFLICT") return true;
  if (code === "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS") return false;
  if (failure.idempotencyReplay === true) return true;
  return false;
}

export function idempotencyReplayIndicatesSucceededCommit(
  failure: ProductionOutputCommitFailure,
): boolean {
  if (failure.ok) return true;
  return (
    failure.idempotencyReplay === true && isZohoCommitSuccessBody(failure.body)
  );
}
