// PRODUCT-MAP-3 — Read-only audit of product Zoho assembly readiness.
// Prints a grouped summary of all products by Zoho readiness level,
// plus BOM packaging materials that are missing Zoho item IDs.
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/audit-product-zoho-readiness.ts
//
// Read-only. No DB writes. No Zoho calls.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  classifyProductZohoReadiness,
  zohoReadinessReasonLabel,
} from "@/lib/zoho/product-zoho-readiness";

const {
  products,
  productAllowedTablets,
  productPackagingSpecs,
  packagingMaterials,
} = schema;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Error: DATABASE_URL env var is required");
    process.exit(1);
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const [allProducts, allTabletMappings, allBomRows] = await Promise.all([
    db.select().from(products).orderBy(asc(products.name)),
    db
      .select({ productId: productAllowedTablets.productId })
      .from(productAllowedTablets),
    db
      .select({
        productId: productPackagingSpecs.productId,
        materialName: packagingMaterials.name,
        materialZohoItemId: packagingMaterials.zohoItemId,
      })
      .from(productPackagingSpecs)
      .innerJoin(
        packagingMaterials,
        eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
      ),
  ]);

  // Count tablet mappings per product
  const tabletCountByProduct = new Map<string, number>();
  for (const row of allTabletMappings) {
    tabletCountByProduct.set(
      row.productId,
      (tabletCountByProduct.get(row.productId) ?? 0) + 1,
    );
  }

  // Collect BOM materials missing Zoho IDs
  const bomIssuesByProduct = new Map<string, string[]>();
  for (const row of allBomRows) {
    if (!row.materialZohoItemId) {
      const existing = bomIssuesByProduct.get(row.productId) ?? [];
      existing.push(row.materialName);
      bomIssuesByProduct.set(row.productId, existing);
    }
  }

  type Bucket = {
    id: string;
    name: string;
    sku: string;
    kind: string;
    reasons: string[];
  };
  const ready: Bucket[] = [];
  const partial: Bucket[] = [];
  const missing: Bucket[] = [];
  const inactive: Bucket[] = [];
  const missingTabletMapping: string[] = [];

  function formatProductLine(b: Bucket): string {
    return `${b.name} (${b.sku}) · ${b.kind} · ${b.id}`;
  }

  for (const product of allProducts) {
    const result = classifyProductZohoReadiness({
      isActive: product.isActive,
      zohoItemIdUnit: product.zohoItemIdUnit ?? null,
      zohoItemIdDisplay: product.zohoItemIdDisplay ?? null,
      zohoItemIdCase: product.zohoItemIdCase ?? null,
      unitsPerDisplay: product.unitsPerDisplay ?? null,
      displaysPerCase: product.displaysPerCase ?? null,
    });

    const bucket: Bucket = {
      id: product.id,
      name: product.name,
      sku: product.sku,
      kind: product.kind,
      reasons: result.reasons.map(zohoReadinessReasonLabel),
    };

    switch (result.level) {
      case "ready":   ready.push(bucket);   break;
      case "partial": partial.push(bucket); break;
      case "missing": missing.push(bucket); break;
      case "inactive": inactive.push(bucket); break;
    }

    const tabletCount = tabletCountByProduct.get(product.id) ?? 0;
    if (product.isActive && tabletCount === 0) {
      missingTabletMapping.push(
        `${product.name} (${product.sku}) · ${product.kind} · ${product.id}`,
      );
    }
  }

  const active = allProducts.filter((p) => p.isActive);

  console.log("\n=== Product Zoho Readiness Audit ===\n");
  console.log(`Total products : ${allProducts.length}`);
  console.log(`Active         : ${active.length}`);
  console.log(`  Ready        : ${ready.length}`);
  console.log(`  Partial      : ${partial.length}`);
  console.log(`  Missing      : ${missing.length}`);
  console.log(`Inactive       : ${inactive.length}`);

  if (ready.length > 0) {
    console.log("\n--- Zoho ready ---");
    for (const b of ready) console.log(`  • ${formatProductLine(b)}`);
  }

  if (partial.length > 0) {
    console.log("\n--- Zoho mapping incomplete ---");
    for (const b of partial) {
      console.log(`  • ${formatProductLine(b)}`);
      for (const r of b.reasons) console.log(`      – ${r}`);
    }
  }

  if (missing.length > 0) {
    console.log("\n--- Zoho IDs missing ---");
    for (const b of missing) {
      console.log(`  • ${formatProductLine(b)}`);
      for (const r of b.reasons) console.log(`      – ${r}`);
    }
  }

  if (inactive.length > 0) {
    console.log("\n--- Inactive products ---");
    for (const b of inactive) console.log(`  • ${formatProductLine(b)}`);
  }

  if (missingTabletMapping.length > 0) {
    console.log("\n--- Missing tablet mapping (floor readiness — separate concern) ---");
    for (const label of missingTabletMapping) console.log(`  • ${label}`);
  }

  const bomProductIds = [...bomIssuesByProduct.keys()];
  if (bomProductIds.length > 0) {
    console.log("\n--- BOM materials missing Zoho item ID ---");
    for (const [productId, materials] of bomIssuesByProduct) {
      const p = allProducts.find((x) => x.id === productId);
      const label = p ? `${p.name} (${p.sku})` : productId;
      console.log(`  • ${label}: ${materials.join(", ")}`);
    }
  }

  if (partial.length === 0 && missing.length === 0 && bomProductIds.length === 0) {
    console.log("\n✓ All active products are Zoho-ready.");
  }

  console.log(
    "\nRun this script before enabling Zoho dry-run or live writes.\n",
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
