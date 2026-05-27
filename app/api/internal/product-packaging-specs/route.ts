/**
 * Phase C/D — Internal BOM API for PackTrack forecasting.
 *
 * Returns all products with their packaging BOM. PackTrack calls this
 * to compute daily material demand from sales velocity.
 *
 * Auth: X-Luma-PackTrack-Secret header.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, productPackagingSpecs, packagingMaterials } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkSecret(req: Request): boolean {
  const expected = process.env.LUMA_PACKTRACK_SECRET ?? "";
  return !!expected && req.headers.get("x-luma-packtrack-secret") === expected;
}

export async function GET(req: Request) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      productSku: products.sku,
      materialCode: packagingMaterials.sku,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
    })
    .from(productPackagingSpecs)
    .innerJoin(products, eq(products.id, productPackagingSpecs.productId))
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, productPackagingSpecs.packagingMaterialId));

  // Group by product
  const grouped: Record<
    string,
    Array<{ material_code: string; qty_per_unit: number; per_scope: string }>
  > = {};
  for (const r of rows) {
    if (!grouped[r.productSku]) grouped[r.productSku] = [];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    grouped[r.productSku]!.push({
      material_code: r.materialCode,
      qty_per_unit: r.qtyPerUnit,
      per_scope: r.perScope,
    });
  }

  const result = Object.entries(grouped).map(([product_sku, components]) => ({
    product_sku,
    components,
  }));

  return NextResponse.json(result);
}
