// LOT-1E — recall-passport CSV export.
//
// GET handler that re-runs the same getRecallPassport() call the /recall
// page uses, then streams the result as CSV. Customer-safe by default:
// supplier_lot is BLANK unless ?customer_supplier_lot_visible=true is
// passed (the page itself doesn't expose that toggle yet — admins can
// pass it via URL when generating an internal export).

import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  getRecallPassport,
  type RecallSearchInput,
} from "@/lib/production/recall-passport-loaders";
import { buildRecallPassportCsv } from "@/lib/production/finished-lot-labels";

export const dynamic = "force-dynamic";

function parseInput(sp: URLSearchParams): RecallSearchInput | null {
  const kind = sp.get("kind") ?? "";
  switch (kind) {
    case "supplier_lot":
    case "internal_receipt_number":
    case "raw_bag_qr":
    case "finished_lot_trace_code": {
      const value = (sp.get("value") ?? "").trim();
      if (value.length === 0) return null;
      return { kind, value };
    }
    case "product_date_range": {
      const productId = (sp.get("productId") ?? "").trim();
      const fromDate = (sp.get("fromDate") ?? "").trim();
      const toDate = (sp.get("toDate") ?? "").trim();
      if (!productId || !fromDate || !toDate) return null;
      return { kind, productId, fromDate, toDate };
    }
    case "customer_date_range": {
      const customerId = (sp.get("customerId") ?? "").trim();
      const fromDate = (sp.get("fromDate") ?? "").trim();
      const toDate = (sp.get("toDate") ?? "").trim();
      if (!customerId || !fromDate || !toDate) return null;
      return { kind, customerId, fromDate, toDate };
    }
    default:
      return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  await requireSession();
  const url = new URL(req.url);
  const input = parseInput(url.searchParams);
  const supplierVisible =
    url.searchParams.get("customer_supplier_lot_visible") === "true";

  if (!input) {
    return new NextResponse(
      "Missing or invalid search parameters. See /recall for the search-kind contract.",
      { status: 400 },
    );
  }

  const passport = await getRecallPassport(input);
  const csv = buildRecallPassportCsv(passport, {
    customerSupplierLotVisible: supplierVisible,
  });

  const safeValue =
    "value" in input
      ? input.value.slice(0, 40).replace(/[^a-z0-9_-]/gi, "_")
      : input.kind;
  const filename = `recall-${input.kind}-${safeValue}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
