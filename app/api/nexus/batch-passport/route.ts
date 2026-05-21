// COMMERCIAL-TRACE-6 — Nexus read-only: batch passport.
//
// GET /api/nexus/batch-passport?trace_code=…  (or shipment_finished_lot_id=…)
//                              &nexus_customer_id=…  (customer-scope ownership check)
//                              &scope=customer       (CSR can preview customer scope)
//
// Auth: Authorization: Bearer <NEXUS_LOOKUP_TOKEN | NEXUS_CSR_LOOKUP_TOKEN>.
// Customer-scope responses hide supplier_lot, internal_receipt,
// raw_bag_qr, operator, machine, and full QC history. CSR scope may
// see them when they exist (the underlying recall passport loader is
// the data source). Missing links surface as plain-text warnings; we
// never invent data to fill gaps.

import { NextResponse } from "next/server";
import {
  authenticateNexusLookupRequest,
  buildBatchPassportResponse,
  resolveNexusLookupScope,
  type NexusLookupError,
  type NexusPassportRow,
} from "@/lib/integrations/nexus/lookup";
import { loadBatchPassportForNexus } from "@/lib/db/queries/nexus-lookups";

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

  const traceCode = url.searchParams.get("trace_code");
  const sflId = url.searchParams.get("shipment_finished_lot_id");
  if (
    (!traceCode || traceCode.trim().length === 0) &&
    (!sflId || sflId.trim().length === 0)
  ) {
    return NextResponse.json(
      errorBody({
        kind: "INVALID_REQUEST",
        httpStatus: 400,
        code: "INVALID_REQUEST",
        message:
          "Provide trace_code or shipment_finished_lot_id as a query parameter.",
      }),
      { status: 400 },
    );
  }
  const askedCustomerId = url.searchParams.get("nexus_customer_id");

  try {
    const result = await loadBatchPassportForNexus({
      traceCode,
      shipmentFinishedLotId: sflId,
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

    // Customer-scope ownership check. Required when the caller is on
    // customer scope and supplied an identifier. CSR scope skips the
    // check (operations / recall investigations need full reach).
    if (scope === "customer" && askedCustomerId && askedCustomerId.trim().length > 0) {
      if (result.passport.customer.nexus_id !== askedCustomerId.trim()) {
        return NextResponse.json(
          errorBody({
            kind: "CUSTOMER_SCOPE_MISMATCH",
            httpStatus: 422,
            code: "CUSTOMER_SCOPE_MISMATCH",
            message:
              "Requested batch is not linked to the supplied nexus_customer_id.",
          }),
          { status: 422 },
        );
      }
    }

    // Compose the row shape. The customer-scope path keeps only the
    // safe whitelist (enforced again by sanitizeNexusPassportForScope
    // in buildBatchPassportResponse).
    const passport: NexusPassportRow = {
      trace_code: result.passport.trace_code,
      finished_lot_id: result.passport.finished_lot_id,
      shipment_finished_lot_id: result.passport.shipment_finished_lot_id,
      product_name: result.passport.product_name,
      product_sku: result.passport.product_sku,
      packed_at: result.passport.packed_at,
      shipped_at: result.passport.shipped_at,
      quantity: result.passport.quantity,
      unit: result.passport.unit,
      warnings: result.passport.warnings,
      missing_links: result.passport.missing_links,
      // CSR-only fields — included in source for CSR scope, stripped
      // by the sanitizer for customer scope.
      supplier_lots: result.passport.supplier_lots,
      raw_bag_receipts: result.passport.raw_bag_receipts,
      raw_bag_qrs: result.passport.raw_bag_qrs,
      pos: result.passport.pos,
      operators: result.passport.operators,
      machines: result.passport.machines,
      qc_events: result.passport.qc_events,
      packaging_lots: result.passport.packaging_lots,
    };

    const body = buildBatchPassportResponse({ scope, passport });
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
