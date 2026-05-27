/**
 * Phase C — Luma Zoho sales webhook.
 *
 * Receives sales confirmation from Zoho and links the sale to the
 * most recent RELEASED finished lot for the product. Creates a
 * finished_lot_sales row (idempotent on finished_lot_id + zoho_order_id).
 *
 * Auth: X-Zoho-Webhook-Secret header.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { finishedLots, finishedLotSales, products } from "@/lib/db/schema";
import { eq, desc, and } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkSecret(req: Request): boolean {
  const expected = process.env.ZOHO_WEBHOOK_SECRET ?? "";
  return !!expected && req.headers.get("x-zoho-webhook-secret") === expected;
}

export async function POST(req: Request) {
  if (!checkSecret(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON" }, { status: 400 });
  }

  const { zoho_order_id, product_sku, qty_sold, sold_at } = body as {
    zoho_order_id?: string;
    product_sku?: string;
    qty_sold?: number;
    sold_at?: string;
  };

  if (!zoho_order_id || !product_sku || !qty_sold || !sold_at) {
    return NextResponse.json(
      { ok: false, error: "Missing: zoho_order_id, product_sku, qty_sold, sold_at" },
      { status: 400 },
    );
  }

  // Find the product
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.sku, product_sku))
    .limit(1);

  if (!product) {
    return NextResponse.json({ ok: true, linked_lot: null, reason: "product not found" });
  }

  // Find most recent RELEASED finished lot for this product
  const [lot] = await db
    .select({ id: finishedLots.id, finishedLotNumber: finishedLots.finishedLotNumber })
    .from(finishedLots)
    .where(and(eq(finishedLots.productId, product.id), eq(finishedLots.status, "RELEASED")))
    .orderBy(desc(finishedLots.producedOn))
    .limit(1);

  if (!lot) {
    return NextResponse.json({ ok: true, linked_lot: null, reason: "no RELEASED lot found" });
  }

  // Insert idempotently — conflict on (finished_lot_id, zoho_order_id) is fine
  await db
    .insert(finishedLotSales)
    .values({
      finishedLotId: lot.id,
      zohoOrderId: zoho_order_id,
      productSku: product_sku,
      qtySold: qty_sold,
      soldAt: new Date(sold_at),
    })
    .onConflictDoNothing();

  return NextResponse.json({ ok: true, linked_lot: lot.finishedLotNumber });
}
