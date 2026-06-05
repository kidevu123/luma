/**
 * Authenticated smoke for Zoho production-output preview + commit (flag off).
 *
 * Run inside the staging app container:
 *   docker compose exec -T app npx tsx /app/scripts/zoho-production-output-smoke.ts
 *
 * Never prints bearer secrets. Does not enable live writes.
 */

import { callProductionOutputPreview } from "@/lib/zoho/production-output-preview";
import {
  getInventoryPurchaseOrder,
  listWarehouses,
} from "@/lib/zoho/inventory-service-client";

const LIVE_TEST = {
  poNumber: "PO-00239",
  purchaseorder_id: "5254962000005963030",
  purchaseorder_line_item_id: "5254962000005963033",
  tablet_name: "FX MIT - Pink Lemonade",
  tablet_zoho_item_id: "5254962000004758364",
  product_sku: "tt-product-36",
  product_name: "Hyroxi MIT A - Variety Pack",
  unit_composite_item_id: "5254962000003506003",
  qty_ordered_luma: 12000,
  qty_received_zoho_cached: 0,
  qty_remaining_zoho_cached: 12000,
} as const;

function redactBody(body: unknown): unknown {
  if (body == null || typeof body !== "object") return body;
  const clone = structuredClone(body) as Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    if (/secret|token|bearer|authorization/i.test(key)) {
      clone[key] = "[REDACTED]";
    }
  }
  return clone;
}

function summarizePlannedSteps(body: unknown): string[] {
  if (body == null || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const candidates = [
    obj.steps,
    obj.planned_steps,
    obj.plannedSteps,
    (obj.preflight as Record<string, unknown> | undefined)?.planned_steps,
    (obj.data as Record<string, unknown> | undefined)?.planned_steps,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.map((s) => {
        if (typeof s === "string") return s;
        if (typeof s === "object" && s != null && "step" in s) {
          return String((s as { step: unknown }).step);
        }
        return JSON.stringify(s);
      });
    }
  }
  return [];
}

async function callCommitFlagOff(payload: Record<string, unknown>): Promise<{
  httpStatus: number | null;
  body: unknown;
}> {
  const rawUrl =
    process.env.ZOHO_SERVICE_BASE_URL ?? process.env.ZOHO_INTEGRATION_URL;
  const bearer = process.env.ZOHO_SERVICE_BEARER_SECRET?.trim();
  const brand = process.env.ZOHO_BRAND?.trim() || "haute_brands";
  if (!rawUrl || !bearer) {
    return { httpStatus: null, body: { error: "missing Zoho service config" } };
  }
  const baseUrl = rawUrl.replace(/\/+$/, "");
  const idempotencyKey = `luma-commit-smoke-${Date.now()}`;
  const response = await fetch(
    `${baseUrl}/zoho/luma/production-output/commit`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Brand": brand,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Luma-Source": "luma",
      },
      body: JSON.stringify(payload),
    },
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => null);
  }
  return { httpStatus: response.status, body };
}

async function main() {
  const runId = `luma-live-test-smoke-2026-06-02-po00239-pink`;
  const receiveDate = "2026-06-02";

  console.log("=== Zoho production-output smoke (live writes OFF) ===");
  console.log(
    JSON.stringify(
      {
        zoho_service_url:
          process.env.ZOHO_INTEGRATION_URL ??
          process.env.ZOHO_SERVICE_BASE_URL ??
          null,
        zoho_brand: process.env.ZOHO_BRAND ?? "haute_brands",
        zoho_warehouse_env: process.env.ZOHO_WAREHOUSE_ID?.trim() || null,
        bearer_configured: Boolean(
          process.env.ZOHO_SERVICE_BEARER_SECRET?.trim(),
        ),
        enable_live_inventory_writes: process.env.ENABLE_LIVE_INVENTORY_WRITES ?? null,
      },
      null,
      2,
    ),
  );

  const warehouses = await listWarehouses();
  if (!warehouses.ok) {
    console.log(
      JSON.stringify(
        { step: "warehouses", ok: false, message: warehouses.message, httpStatus: warehouses.httpStatus, body: redactBody(warehouses.body) },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const activeWarehouses = warehouses.data.filter((w) => w.warehouse_id);
  const warehouseId =
    process.env.ZOHO_WAREHOUSE_ID?.trim() ||
    activeWarehouses[0]?.warehouse_id ||
    null;
  console.log(
    JSON.stringify(
      {
        step: "warehouses",
        ok: true,
        count: activeWarehouses.length,
        selected_warehouse_id: warehouseId,
        warehouses: activeWarehouses.map((w) => ({
          id: w.warehouse_id,
          name: w.warehouse_name,
        })),
      },
      null,
      2,
    ),
  );
  if (!warehouseId) {
    console.error(
      "BLOCKER: no warehouse_id available. Set ZOHO_WAREHOUSE_ID in /etc/luma/.env or ensure /zoho/warehouses/list returns the active warehouse.",
    );
    process.exit(1);
  }

  const poDetail = await getInventoryPurchaseOrder(LIVE_TEST.purchaseorder_id);
  if (!poDetail.ok) {
    console.log(
      JSON.stringify(
        { step: "po_detail", ok: false, message: poDetail.message, httpStatus: poDetail.httpStatus, body: redactBody(poDetail.body) },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const line = poDetail.data.line_items.find(
    (l) => l.line_item_id === LIVE_TEST.purchaseorder_line_item_id,
  );
  console.log(
    JSON.stringify(
      {
        step: "po_detail",
        ok: true,
        purchaseorder_number: poDetail.data.purchaseorder_number,
        status: poDetail.data.status,
        received_status: poDetail.data.received_status,
        line: line
          ? {
              line_item_id: line.line_item_id,
              item_id: line.item_id,
              name: line.name,
              quantity_ordered: line.quantity_ordered,
              quantity_received: line.quantity_received,
              quantity_remaining: line.quantity_remaining,
              status: line.status,
            }
          : null,
      },
      null,
      2,
    ),
  );
  if (!line) {
    console.error("BLOCKER: PO line not found in Zoho PO detail");
    process.exit(1);
  }
  if (line.quantity_remaining < 1) {
    console.error(
      `BLOCKER: quantity_remaining=${line.quantity_remaining} (< 1)`,
    );
    process.exit(1);
  }
  if (line.item_id !== LIVE_TEST.tablet_zoho_item_id) {
    console.warn(
      JSON.stringify({
        warning: "tablet_zoho_item_id mismatch vs Luma mapping",
        zoho_item_id: line.item_id,
        luma_tablet_zoho_item_id: LIVE_TEST.tablet_zoho_item_id,
      }),
    );
  }

  const payload = {
    purchaseorder_id: LIVE_TEST.purchaseorder_id,
    purchaseorder_line_item_id: LIVE_TEST.purchaseorder_line_item_id,
    quantity_good: 1,
    receive_date: receiveDate,
    warehouse_id: warehouseId,
    unit_composite_item_id: LIVE_TEST.unit_composite_item_id,
    unit_assembly_quantity: 1,
    display_assembly_quantity: 0,
    case_assembly_quantity: 0,
    luma_operation_id: runId,
    quantity_damaged: 0,
    quantity_ripped: 0,
    quantity_loose: 0,
    notes:
      "Controlled first live Zoho test: receive qty=1 and unit assembly qty=1 only",
  };

  console.log(
    JSON.stringify({ step: "live_test_payload", payload }, null, 2),
  );

  const previewKey = `luma-preview-smoke-${Date.now()}`;
  const preview = await callProductionOutputPreview({
    payload,
    idempotencyKey: previewKey,
  });
  const plannedSteps = summarizePlannedSteps(preview.body);
  console.log(
    JSON.stringify(
      {
        step: "preview",
        httpStatus: preview.httpStatus,
        ok: preview.ok,
        message: preview.ok ? null : preview.message,
        planned_steps: plannedSteps,
        receive_and_unit_only:
          plannedSteps.length > 0
            ? plannedSteps.every(
                (s) =>
                  !/display|case/i.test(s) &&
                  (/receive|unit/i.test(s) || s.length > 0),
              ) && !plannedSteps.some((s) => /display|case/i.test(s))
            : null,
        body: redactBody(preview.body),
      },
      null,
      2,
    ),
  );

  const commit = await callCommitFlagOff(payload);
  const commitCode =
    commit.body != null &&
    typeof commit.body === "object" &&
    "code" in commit.body
      ? String((commit.body as { code: unknown }).code)
      : null;
  console.log(
    JSON.stringify(
      {
        step: "commit_flag_off",
        httpStatus: commit.httpStatus,
        expected_live_write_disabled: commit.httpStatus === 403 && commitCode === "LIVE_WRITE_DISABLED",
        code: commitCode,
        body: redactBody(commit.body),
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
