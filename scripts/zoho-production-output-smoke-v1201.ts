/**
 * v1.20.1 production-output smoke — preview (no warehouse_id) + commit flag-off.
 *
 * Run inside staging app container:
 *   docker compose exec -T app npx tsx /app/scripts/zoho-production-output-smoke-v1201.ts
 */

const BASE_URL = (
  process.env.ZOHO_SERVICE_BASE_URL ??
  process.env.ZOHO_INTEGRATION_URL ??
  ""
).replace(/\/+$/, "");
const BEARER = process.env.ZOHO_SERVICE_BEARER_SECRET?.trim() ?? "";
const BRAND = process.env.ZOHO_BRAND?.trim() || "haute_brands";

const PREVIEW_PAYLOAD = {
  purchaseorder_id: "5254962000005963030",
  purchaseorder_line_item_id: "5254962000005963033",
  quantity_good: 1,
  receive_date: "2026-06-05",
  unit_composite_item_id: "5254962000003506003",
  unit_assembly_quantity: 1,
  display_assembly_quantity: 0,
  case_assembly_quantity: 0,
  luma_operation_id: "luma-preview-v1201-pink-lemonade",
  quantity_damaged: 0,
  quantity_ripped: 0,
  quantity_loose: 0,
  notes: "v1.20.1 preview retest — receive qty=1, unit assembly qty=1 only",
};

const ALT_PREVIEW_PAYLOAD = {
  purchaseorder_id: "5254962000005946455",
  purchaseorder_line_item_id: "5254962000005946458",
  quantity_good: 1,
  receive_date: "2026-06-05",
  unit_composite_item_id: "5254962000006219015",
  unit_assembly_quantity: 1,
  display_assembly_quantity: 0,
  case_assembly_quantity: 0,
  luma_operation_id: "luma-preview-v1201-choco-drift",
  quantity_damaged: 0,
  quantity_ripped: 0,
  quantity_loose: 0,
  notes: "v1.20.1 alternate preview retest — receive qty=1, unit assembly qty=1 only",
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

function payloadShapesOmitWarehouse(steps: unknown): boolean | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return steps.every((s) => {
    if (typeof s !== "object" || s == null || !("payload_shape" in s)) return false;
    const shape = (s as { payload_shape: unknown }).payload_shape;
    if (typeof shape !== "object" || shape == null) return false;
    return !("warehouse_id" in shape);
  });
}

async function preview(payload: Record<string, unknown>, suffix: string) {
  const response = await fetch(`${BASE_URL}/zoho/luma/production-output/preview`, {
    method: "POST",
    headers: headers(`luma-preview-v1201-${suffix}-${Date.now()}`),
    body: JSON.stringify(payload),
  });
  const body = await parseBody(response);
  const obj =
    body != null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const steps = obj.steps;
  const names = stepNames(steps);
  const receiveUnitOnly =
    names.length === 2 &&
    names.includes("receive") &&
    names.includes("unit_assembly") &&
    !names.some((n) => /display|case/.test(n));

  return {
    label: suffix,
    httpStatus: response.status,
    preflight: obj.preflight ?? null,
    warnings: obj.warnings ?? null,
    steps,
    stepNames: names,
    receiveAndUnitAssemblyOnly: receiveUnitOnly,
    payloadShapesOmitWarehouseId: payloadShapesOmitWarehouse(steps),
    errorBody: response.status >= 400 ? body : null,
    fullBodyOnSuccess: response.status >= 200 && response.status < 300 ? body : null,
  };
}

async function commit(payload: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/zoho/luma/production-output/commit`, {
    method: "POST",
    headers: headers(`luma-commit-flagoff-v1201-pink-lemonade-${Date.now()}`),
    body: JSON.stringify(payload),
  });
  const body = await parseBody(response);
  let code: string | null = null;
  if (body != null && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "object" && detail != null && "error" in detail) {
      const err = (detail as { error: unknown }).error;
      if (typeof err === "object" && err != null && "code" in err) {
        code = String((err as { code: unknown }).code);
      }
    }
  }
  return {
    httpStatus: response.status,
    errorCode: code,
    body,
  };
}

async function health() {
  const r = await fetch(`${BASE_URL}/health`);
  const body = await parseBody(r);
  return { status: r.status, body };
}

async function main() {
  if (!BASE_URL || !BEARER) {
    console.log(JSON.stringify({ error: "missing Zoho service URL or bearer" }, null, 2));
    process.exit(1);
  }

  const healthResult = await health();
  let previewResult = await preview(PREVIEW_PAYLOAD, "pink-lemonade");

  if (previewResult.httpStatus !== 200) {
    const alt = await preview(ALT_PREVIEW_PAYLOAD, "choco-drift-alt");
    previewResult = { ...previewResult, alternatePreview: alt };
  }

  const commitResult = await commit(PREVIEW_PAYLOAD);

  console.log(
    JSON.stringify(
      {
        service_health: healthResult,
        preview: previewResult,
        commit: commitResult,
        safety: {
          live_writes_enabled: false,
          commit_blocked: commitResult.httpStatus === 403 && commitResult.errorCode === "LIVE_WRITE_DISABLED",
          no_zoho_write_expected: true,
        },
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
