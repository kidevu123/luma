/**
 * One-shot controlled live commit — v1.20.2 Pink Lemonade.
 * Do not retry. Idempotency key is fixed.
 */

const BASE_URL = (
  process.env.ZOHO_SERVICE_BASE_URL ??
  process.env.ZOHO_INTEGRATION_URL ??
  ""
).replace(/\/+$/, "");
const BEARER = process.env.ZOHO_SERVICE_BEARER_SECRET?.trim() ?? "";
const BRAND = process.env.ZOHO_BRAND?.trim() || "haute_brands";
const IDEMPOTENCY_KEY = "luma-live-v1202-pink-lemonade-001";

const PAYLOAD = {
  purchaseorder_id: "5254962000005963030",
  purchaseorder_line_item_id: "5254962000005963033",
  quantity_good: 1,
  receive_date: "2026-06-05",
  unit_composite_item_id: "5254962000003506003",
  unit_assembly_quantity: 1,
  display_assembly_quantity: 0,
  case_assembly_quantity: 0,
  luma_operation_id: "luma-live-v1202-pink-lemonade-001",
  quantity_damaged: 0,
  quantity_ripped: 0,
  quantity_loose: 0,
  notes:
    "Controlled first live Zoho test: receive qty=1 and unit assembly qty=1 only",
};

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function dig(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

async function main() {
  if (!BASE_URL || !BEARER) {
    console.log(JSON.stringify({ error: "missing Zoho service URL or bearer" }, null, 2));
    process.exit(1);
  }

  const response = await fetch(`${BASE_URL}/zoho/luma/production-output/commit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "X-Brand": BRAND,
      "Idempotency-Key": IDEMPOTENCY_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Luma-Source": "luma",
    },
    body: JSON.stringify(PAYLOAD),
  });

  const body = await parseBody(response);

  const receiveId =
    dig(body, "receive_id") ??
    dig(body, "results", "receive", "receive_id") ??
    dig(body, "steps", "receive", "receive_id") ??
    null;

  const bundleId =
    dig(body, "bundle_id") ??
    dig(body, "results", "unit_assembly", "bundle_id") ??
    dig(body, "steps", "unit_assembly", "bundle_id") ??
    null;

  // Walk common nested shapes for step results
  let receiveIdResolved: unknown = receiveId;
  let bundleIdResolved: unknown = bundleId;
  if (body != null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const stepResults = b.step_results ?? b.results ?? b.steps_executed;
    if (Array.isArray(stepResults)) {
      for (const s of stepResults) {
        if (typeof s !== "object" || s == null) continue;
        const step = s as Record<string, unknown>;
        const name = String(step.step ?? step.name ?? "");
        const ref = step.reference_id ?? step.receive_id ?? step.bundle_id ?? step.zoho_id;
        if (name === "receive" && ref) receiveIdResolved = ref;
        if (name === "unit_assembly" && ref) bundleIdResolved = ref;
        if (step.step === "receive" && step.receive_id)
          receiveIdResolved = step.receive_id;
        if (step.step === "unit_assembly" && step.bundle_id)
          bundleIdResolved = step.bundle_id;
      }
    }
  }

  const partialFailure = Boolean(
    dig(body, "partial_failure") ?? dig(body, "partialFailure"),
  );
  const humanReviewRequired = Boolean(
    dig(body, "human_review_required") ?? dig(body, "humanReviewRequired"),
  );

  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  const detail = dig(body, "detail");
  if (detail != null && typeof detail === "object") {
    const err = dig(detail, "error");
    if (err != null && typeof err === "object") {
      errorCode = String((err as Record<string, unknown>).code ?? "") || null;
      errorMessage =
        String((err as Record<string, unknown>).message ?? "") || null;
    }
  }
  if (!errorCode && body != null && typeof body === "object") {
    errorCode = String((body as Record<string, unknown>).code ?? "") || null;
    errorMessage =
      String((body as Record<string, unknown>).message ?? "") || null;
  }

  console.log(
    JSON.stringify(
      {
        httpStatus: response.status,
        idempotencyKey: IDEMPOTENCY_KEY,
        responseBody: body,
        receive_id: receiveIdResolved ?? null,
        bundle_id: bundleIdResolved ?? null,
        partial_failure: partialFailure,
        human_review_required: humanReviewRequired,
        error_code: errorCode,
        error_message: errorMessage,
        retry_performed: false,
        attempts: 1,
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
