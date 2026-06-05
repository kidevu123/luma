/**
 * v1.20.2 production-output flag-off smoke — preview + commit (no warehouse_id).
 *
 * Run inside staging app container:
 *   docker compose exec -T app npx tsx /app/scripts/zoho-production-output-smoke-v1202.ts
 */

const BASE_URL = (
  process.env.ZOHO_SERVICE_BASE_URL ??
  process.env.ZOHO_INTEGRATION_URL ??
  ""
).replace(/\/+$/, "");
const BEARER = process.env.ZOHO_SERVICE_BEARER_SECRET?.trim() ?? "";
const BRAND = process.env.ZOHO_BRAND?.trim() || "haute_brands";

const PAYLOAD = {
  purchaseorder_id: "5254962000005963030",
  purchaseorder_line_item_id: "5254962000005963033",
  quantity_good: 1,
  receive_date: "2026-06-05",
  unit_composite_item_id: "5254962000003506003",
  unit_assembly_quantity: 1,
  display_assembly_quantity: 0,
  case_assembly_quantity: 0,
  luma_operation_id: "luma-preview-v1202-pink-lemonade",
  quantity_damaged: 0,
  quantity_ripped: 0,
  quantity_loose: 0,
  notes: "v1.20.2 final flag-off smoke — receive qty=1, unit assembly qty=1 only",
};

function headers(idempotencyKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${BEARER}`,
    "X-Brand": BRAND,
    "Idempotency-Key": idempotencyKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Luma-Source": "luma",
  };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stepNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => {
    if (typeof s === "object" && s != null && "step" in s) {
      return String((s as { step: unknown }).step);
    }
    return String(s);
  });
}

function payloadShapesOmitWarehouse(steps: unknown): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.every((s) => {
    if (typeof s !== "object" || s == null || !("payload_shape" in s)) return false;
    const shape = (s as { payload_shape: unknown }).payload_shape;
    if (typeof shape !== "object" || shape == null) return false;
    return !("warehouse_id" in shape);
  });
}

function hasWarningCode(warnings: unknown, code: string): boolean {
  if (!Array.isArray(warnings)) return false;
  return warnings.some(
    (w) =>
      typeof w === "object" &&
      w != null &&
      "code" in w &&
      String((w as { code: unknown }).code) === code,
  );
}

function extractErrorCode(body: unknown): string | null {
  if (body == null || typeof body !== "object" || !("detail" in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail !== "object" || detail == null || !("error" in detail)) return null;
  const err = (detail as { error: unknown }).error;
  if (typeof err !== "object" || err == null || !("code" in err)) return null;
  return String((err as { code: unknown }).code);
}

async function main() {
  if (!BASE_URL || !BEARER) {
    console.log(JSON.stringify({ error: "missing Zoho service URL or bearer" }, null, 2));
    process.exit(1);
  }

  const healthResp = await fetch(`${BASE_URL}/health`);
  const healthBody = await parseBody(healthResp);

  const previewResp = await fetch(`${BASE_URL}/zoho/luma/production-output/preview`, {
    method: "POST",
    headers: headers(`luma-preview-v1202-pink-lemonade-${Date.now()}`),
    body: JSON.stringify(PAYLOAD),
  });
  const previewBody = await parseBody(previewResp);
  const previewObj =
    previewBody != null && typeof previewBody === "object"
      ? (previewBody as Record<string, unknown>)
      : {};
  const steps = previewObj.steps;
  const names = stepNames(steps);
  const warnings = previewObj.warnings ?? null;
  const preflight = previewObj.preflight ?? null;

  const commitResp = await fetch(`${BASE_URL}/zoho/luma/production-output/commit`, {
    method: "POST",
    headers: headers(`luma-commit-flagoff-v1202-pink-lemonade-${Date.now()}`),
    body: JSON.stringify(PAYLOAD),
  });
  const commitBody = await parseBody(commitResp);
  const commitCode = extractErrorCode(commitBody);

  const qtyRemaining =
    preflight != null &&
    typeof preflight === "object" &&
    "quantity_remaining" in preflight
      ? Number((preflight as { quantity_remaining: unknown }).quantity_remaining)
      : null;
  const warehouseSkipped =
    preflight != null &&
    typeof preflight === "object" &&
    "warehouse_validation_skipped" in preflight
      ? Boolean((preflight as { warehouse_validation_skipped: unknown }).warehouse_validation_skipped)
      : false;

  const receiveUnitOnly =
    names.length === 2 &&
    names.includes("receive") &&
    names.includes("unit_assembly") &&
    !names.some((n) => /display|case/.test(n));

  const readyForControlledLiveCommit =
    previewResp.status === 200 &&
    qtyRemaining != null &&
    qtyRemaining >= 1 &&
    hasWarningCode(warnings, "WAREHOUSE_LIST_EMPTY") &&
    warehouseSkipped &&
    receiveUnitOnly &&
    payloadShapesOmitWarehouse(steps) &&
    PAYLOAD.quantity_good === 1 &&
    PAYLOAD.unit_assembly_quantity === 1 &&
    PAYLOAD.display_assembly_quantity === 0 &&
    PAYLOAD.case_assembly_quantity === 0 &&
    !("warehouse_id" in PAYLOAD);

  console.log(
    JSON.stringify(
      {
        service_version:
          healthBody != null &&
          typeof healthBody === "object" &&
          "version" in healthBody
            ? (healthBody as { version: unknown }).version
            : null,
        preview: {
          httpStatus: previewResp.status,
          preflight,
          warnings,
          steps,
          stepNames: names,
          receiveAndUnitAssemblyOnly: receiveUnitOnly,
          payloadShapesOmitWarehouseId: payloadShapesOmitWarehouse(steps),
          errorBody: previewResp.status >= 400 ? previewBody : null,
        },
        commit: {
          httpStatus: commitResp.status,
          errorCode: commitCode,
          errorBody: commitResp.status >= 400 ? commitBody : null,
        },
        safety: {
          liveWriteOccurred: false,
          liveWritesEnabled: false,
          commitBlocked:
            commitResp.status === 403 && commitCode === "LIVE_WRITE_DISABLED",
        },
        readyForControlledLiveCommit,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
