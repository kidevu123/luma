// ZOHO-PRODUCTION-OUTPUT-CONFIG — split persist / preview / commit gates.

export const ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED_ENV =
  "ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED";
export const ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED_ENV =
  "ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED";
export const ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED_ENV =
  "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED";

/** @deprecated Use split flags. Never maps to commit. */
export const ZOHO_PRODUCTION_OUTPUT_ENABLED_ENV =
  "ZOHO_PRODUCTION_OUTPUT_ENABLED";

export const ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE_ENV =
  "ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE";
export const ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED_ENV =
  "ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED";

export type ProductionOutputGateConfig = {
  persistEnabled: boolean;
  previewEnabled: boolean;
  commitEnabled: boolean;
  /** Legacy ZOHO_PRODUCTION_OUTPUT_ENABLED=true was seen (maps persist+preview only). */
  legacyEnabledFlagSeen: boolean;
  invalidCombination: string | null;
};

export type ProductionOutputServiceConfig =
  | {
      ok: true;
      baseUrl: string;
      bearerSecret: string;
      brand: string;
      gates: ProductionOutputGateConfig;
      autoQueueEnabled: boolean;
      legacyAssemblyEnqueueEnabled: boolean;
      /**
       * WAREHOUSE-RESOLUTION-v1.3.0 — Env-level fallback warehouse_id
       * only. The production-output preview resolves warehouse_id
       * via lib/zoho/warehouse-resolution.ts: operator pick > product
       * default > app settings > THIS env fallback > BLOCK. Treat
       * this field as the last source in that chain, NOT the primary.
       */
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

function splitFlagExplicitlySet(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env[ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED_ENV] !== undefined ||
    env[ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED_ENV] !== undefined ||
    env[ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED_ENV] !== undefined
  );
}

/** Resolve persist / preview / commit from env. Preview requires persist. */
export function resolveProductionOutputGateConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionOutputGateConfig {
  const legacy = isTruthyEnv(env, ZOHO_PRODUCTION_OUTPUT_ENABLED_ENV);
  const hasSplit = splitFlagExplicitlySet(env);

  let persistEnabled: boolean;
  let previewEnabled: boolean;
  let commitEnabled: boolean;
  let legacyEnabledFlagSeen = false;

  if (hasSplit) {
    persistEnabled = isTruthyEnv(env, ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED_ENV);
    previewEnabled = isTruthyEnv(env, ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED_ENV);
    commitEnabled = isTruthyEnv(env, ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED_ENV);
  } else if (legacy) {
    legacyEnabledFlagSeen = true;
    persistEnabled = true;
    previewEnabled = true;
    commitEnabled = false;
  } else {
    persistEnabled = false;
    previewEnabled = false;
    commitEnabled = false;
  }

  let invalidCombination: string | null = null;
  if (previewEnabled && !persistEnabled) {
    invalidCombination =
      "ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED requires ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED.";
  }
  if (commitEnabled && !previewEnabled) {
    invalidCombination =
      invalidCombination ??
      "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED requires preview to be enabled first.";
  }

  return {
    persistEnabled,
    previewEnabled,
    commitEnabled,
    legacyEnabledFlagSeen,
    invalidCombination,
  };
}

export function isProductionOutputPersistEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveProductionOutputGateConfig(env).persistEnabled;
}

export function isProductionOutputPreviewEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const gates = resolveProductionOutputGateConfig(env);
  return gates.previewEnabled && gates.persistEnabled && gates.invalidCombination == null;
}

export function isProductionOutputCommitEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const gates = resolveProductionOutputGateConfig(env);
  return (
    gates.commitEnabled &&
    gates.previewEnabled &&
    gates.persistEnabled &&
    gates.invalidCombination == null
  );
}

export function isLegacyAssemblyEnqueueEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isProductionOutputPersistEnabled(env)) {
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

  const gates = resolveProductionOutputGateConfig(env);

  return {
    ok: true,
    baseUrl,
    bearerSecret: rawBearer.trim(),
    brand: present(rawBrand) ?? "haute_brands",
    gates,
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
