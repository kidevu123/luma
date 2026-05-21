// COMMERCIAL-TRACE-6 — Nexus read-only: invoice → confirmed batches.
//
// GET /api/nexus/invoice-batches?invoice_number=…&nexus_customer_id=…
//                              &customer_code=…&product_sku=…
//
// Auth: Authorization: Bearer <NEXUS_LOOKUP_TOKEN | NEXUS_CSR_LOOKUP_TOKEN>.
// Returns: confirmed finished-lot allocations for the invoice, filtered
// by the resolved customer scope. Customer-scope responses NEVER
// include supplier lot, internal receipt, raw bag QR, operator, or
// machine details (enforced by sanitizeNexusBatchForScope).

import { NextResponse } from "next/server";
import {
  authenticateNexusLookupRequest,
  buildInvoiceBatchesResponse,
  resolveNexusLookupScope,
  type NexusLookupError,
} from "@/lib/integrations/nexus/lookup";
import { loadConfirmedBatchesForInvoice } from "@/lib/db/queries/nexus-lookups";

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

  const invoiceNumber = url.searchParams.get("invoice_number")?.trim() ?? "";
  if (invoiceNumber.length === 0) {
    return NextResponse.json(
      errorBody({
        kind: "INVALID_REQUEST",
        httpStatus: 400,
        code: "INVALID_REQUEST",
        message: "invoice_number query parameter is required.",
      }),
      { status: 400 },
    );
  }
  const nexusCustomerId = url.searchParams.get("nexus_customer_id");
  const customerCode = url.searchParams.get("customer_code");
  const productSku = url.searchParams.get("product_sku");

  // Customer-scope callers SHOULD supply at least one customer identifier.
  // We don't hard-block — the DB layer enforces ownership when one is
  // present — but for customer scope we add a warning when neither is
  // supplied.
  const warnings: string[] = [];
  if (scope === "customer" && !nexusCustomerId && !customerCode) {
    warnings.push(
      "Customer-scope request did not include nexus_customer_id or customer_code; results may include any customer's confirmed batches that match this invoice. Pass an identifier to scope the response.",
    );
  }

  try {
    const result = await loadConfirmedBatchesForInvoice({
      invoiceNumber,
      nexusCustomerId,
      customerCode,
      productSku,
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
    if (result.kind === "CUSTOMER_SCOPE_MISMATCH") {
      return NextResponse.json(
        errorBody({
          kind: "CUSTOMER_SCOPE_MISMATCH",
          httpStatus: 422,
          code: "CUSTOMER_SCOPE_MISMATCH",
          message: result.message,
        }),
        { status: 422 },
      );
    }
    const body = buildInvoiceBatchesResponse({
      scope,
      invoice: {
        invoice_number: result.invoice.invoice_number,
        invoice_date: result.invoice.invoice_date,
        customer_code: result.invoice.customer_code,
        nexus_customer_id: result.invoice.nexus_customer_id,
      },
      batches: result.batches,
      warnings: [...warnings, ...result.warnings],
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

// Method guard for everything else — returns 405 without leaking
// schema details.
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
