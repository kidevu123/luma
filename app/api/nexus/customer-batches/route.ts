// COMMERCIAL-TRACE-6 — Nexus read-only: customer → confirmed batches.
//
// GET /api/nexus/customer-batches?nexus_customer_id=… (or customer_code=…)
//                                &product_sku=…&date_from=…&date_to=…
//                                &active_only=true
//
// Auth: Authorization: Bearer <NEXUS_LOOKUP_TOKEN | NEXUS_CSR_LOOKUP_TOKEN>.
// Returns only confirmed allocations linked to shipment_finished_lots
// for this customer. Never leaks other customers' batches. No full
// catalog walk — the DB layer's join is anchored on
// shipment_finished_lots.customer_id.

import { NextResponse } from "next/server";
import {
  authenticateNexusLookupRequest,
  buildCustomerBatchesResponse,
  resolveNexusLookupScope,
  type NexusLookupError,
} from "@/lib/integrations/nexus/lookup";
import { loadConfirmedBatchesForCustomer } from "@/lib/db/queries/nexus-lookups";

export const dynamic = "force-dynamic";

function errorBody(err: NexusLookupError) {
  return {
    error: { code: err.code, message: err.message },
    schema_version: "1.0" as const,
    source: "LUMA" as const,
  };
}

export async function GET(request: Request) {
  const auth = authenticateNexusLookupRequest(request);
  if (!auth.ok) {
    return NextResponse.json(errorBody(auth.error), {
      status: auth.error.httpStatus,
    });
  }
  const scope = resolveNexusLookupScope(request, auth.scope);

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return NextResponse.json(
      errorBody({
        kind: "INVALID_REQUEST",
        httpStatus: 400,
        code: "INVALID_REQUEST",
        message: "Could not parse request URL.",
      }),
      { status: 400 },
    );
  }

  const nexusCustomerId = url.searchParams.get("nexus_customer_id")?.trim() ?? "";
  const customerCode = url.searchParams.get("customer_code")?.trim() ?? "";
  if (nexusCustomerId.length === 0 && customerCode.length === 0) {
    return NextResponse.json(
      errorBody({
        kind: "INVALID_REQUEST",
        httpStatus: 400,
        code: "INVALID_REQUEST",
        message:
          "Provide nexus_customer_id or customer_code as a query parameter.",
      }),
      { status: 400 },
    );
  }

  const productSku = url.searchParams.get("product_sku");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const activeOnly = url.searchParams.get("active_only") === "true";

  try {
    const result = await loadConfirmedBatchesForCustomer({
      nexusCustomerId,
      customerCode,
      productSku,
      dateFrom,
      dateTo,
      activeOnly,
    });
    if (result.kind === "NOT_FOUND") {
      return NextResponse.json(
        errorBody({
          kind: "NOT_FOUND",
          httpStatus: 404,
          code: "NOT_FOUND",
          message: result.message,
        }),
        { status: 404 },
      );
    }
    const body = buildCustomerBatchesResponse({
      scope,
      customer: {
        customer_code: result.customer.customer_code,
        nexus_customer_id: result.customer.nexus_customer_id,
      },
      filters: {
        product_sku: productSku ?? null,
        date_from: dateFrom ?? null,
        date_to: dateTo ?? null,
        active_only: activeOnly,
      },
      batches: result.batches,
      warnings: result.warnings,
    });
    return NextResponse.json(body, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      errorBody({
        kind: "SERVER_ERROR",
        httpStatus: 500,
        code: "SERVER_ERROR",
        message: "Unexpected server error.",
      }),
      { status: 500 },
    );
  }
}

export async function POST() {
  return methodNotAllowed();
}
export async function PUT() {
  return methodNotAllowed();
}
export async function PATCH() {
  return methodNotAllowed();
}
export async function DELETE() {
  return methodNotAllowed();
}

function methodNotAllowed() {
  return NextResponse.json(
    {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Only GET is supported on this endpoint.",
      },
      schema_version: "1.0",
      source: "LUMA",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
