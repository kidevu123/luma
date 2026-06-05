// ZOHO-PRODUCTION-OUTPUT-CONFIG — feature flags and env validation for
// consolidated production-output commits via the shared Zoho service.

export const ZOHO_PRODUCTION_OUTPUT_ENABLED_ENV =
  "ZOHO_PRODUCTION_OUTPUT_ENABLED";
export const ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE_ENV =
  "ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE";
export const ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED_ENV =
  "ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED";

export type ProductionOutputServiceConfig =
  | {
      ok: true;
      baseUrl: string;
      bearerSecret: string;
      brand: string;
      productionOutputEnabled: boolean;
      autoQueueEnabled: boolean;
      legacyAssemblyEnqueueEnabled: boolean;
      defaultWarehouseId: string | null;
    }
  | { ok: false; reason: string };

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function isTruthyEnv(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  return env[key] === "true";
}

/** Consolidated production-output path replaces live legacy assembly enqueue. */
export function isConsolidatedProductionOutputEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthyEnv(env, ZOHO_PRODUCTION_OUTPUT_ENABLED_ENV);
}

export function isLegacyAssemblyEnqueueEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isConsolidatedProductionOutputEnabled(env)) {
    return isTruthyEnv(env, ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED_ENV);
  }
  return true;
}

export function validateProductionOutputServiceConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionOutputServiceConfig {
  const rawUrl = env["ZOHO_SERVICE_BASE_URL"] ?? env["ZOHO_INTEGRATION_URL"];
  const rawBearer = env["ZOHO_SERVICE_BEARER_SECRET"];
  const rawBrand = env["ZOHO_BRAND"];
  const rawWarehouseId = env["ZOHO_WAREHOUSE_ID"];

  if (!rawUrl || rawUrl.trim().length === 0) {
    return {
      ok: false,
      reason:
        "ZOHO_SERVICE_BASE_URL (or ZOHO_INTEGRATION_URL) is not configured.",
    };
  }
  const baseUrl = rawUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: `ZOHO_SERVICE_BASE_URL must use http: or https: (got ${parsed.protocol}).`,
      };
    }
  } catch {
    return { ok: false, reason: "ZOHO_SERVICE_BASE_URL is not a valid URL." };
  }

  if (!rawBearer || rawBearer.trim().length === 0) {
    return {
      ok: false,
      reason: "ZOHO_SERVICE_BEARER_SECRET is not configured.",
    };
  }

  return {
    ok: true,
    baseUrl,
    bearerSecret: rawBearer.trim(),
    brand: present(rawBrand) ?? "haute_brands",
    productionOutputEnabled: isConsolidatedProductionOutputEnabled(env),
    autoQueueEnabled: isTruthyEnv(env, ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE_ENV),
    legacyAssemblyEnqueueEnabled: isLegacyAssemblyEnqueueEnabled(env),
    defaultWarehouseId: present(rawWarehouseId),
  };
}

export function redactProductionOutputServiceHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out = { ...headers };
  if (out.Authorization) out.Authorization = "Bearer [REDACTED]";
  return out;
}
