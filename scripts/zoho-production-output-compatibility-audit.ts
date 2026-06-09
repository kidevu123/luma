#!/usr/bin/env npx tsx
/**
 * Read-only product compatibility audit for Zoho production-output v1.20.6.
 * Does not write to Zoho or mutate production data.
 */

import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import {
  productAllowedTablets,
  products,
  tabletTypes,
} from "../lib/db/schema";
import { resolveProductFamily } from "../lib/zoho/product-family";
import { classifyProductZohoReadiness } from "../lib/zoho/product-zoho-readiness";

type AuditClass =
  | "ready_once_v1206_deploys"
  | "needs_source_bag_allocation"
  | "needs_zoho_batch_resolution"
  | "needs_product_mapping"
  | "needs_po_family_mapping"
  | "variety_pack_complexity"
  | "unsuitable_first_pilot";

async function main() {
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      kind: products.kind,
      zohoItemIdUnit: products.zohoItemIdUnit,
      zohoItemIdDisplay: products.zohoItemIdDisplay,
      zohoItemIdCase: products.zohoItemIdCase,
      productFamily: products.productFamily,
      isActive: products.isActive,
    })
    .from(products)
    .where(eq(products.isActive, true));

  const allowed = await db
    .select({
      productId: productAllowedTablets.productId,
      tabletTypeId: productAllowedTablets.tabletTypeId,
      isPrimary: productAllowedTablets.isPrimary,
      tabletName: tabletTypes.name,
      tabletZohoItemId: tabletTypes.zohoItemId,
    })
    .from(productAllowedTablets)
    .innerJoin(tabletTypes, eq(productAllowedTablets.tabletTypeId, tabletTypes.id));

  const allowedByProduct = new Map<string, typeof allowed>();
  for (const row of allowed) {
    const list = allowedByProduct.get(row.productId) ?? [];
    list.push(row);
    allowedByProduct.set(row.productId, list);
  }

  const report: Array<{
    sku: string;
    name: string;
    kind: string;
    family: string;
    classification: AuditClass;
    reasons: string[];
  }> = [];

  for (const p of rows) {
    const reasons: string[] = [];
    let classification: AuditClass = "ready_once_v1206_deploys";

    const family = resolveProductFamily({
      persistedFamily: p.productFamily,
      name: p.name,
    });
    if (family === "UNKNOWN") {
      classification = "needs_po_family_mapping";
      reasons.push("product_family unresolved");
    }

    const readiness = classifyProductZohoReadiness({
      zohoItemIdUnit: p.zohoItemIdUnit,
      zohoItemIdDisplay: p.zohoItemIdDisplay,
      zohoItemIdCase: p.zohoItemIdCase,
      kind: p.kind,
    });
    if (readiness.level !== "READY") {
      classification = "needs_product_mapping";
      reasons.push(`zoho mapping: ${readiness.label}`);
    }

    const tablets = allowedByProduct.get(p.id) ?? [];
    if (p.kind !== "VARIETY" && tablets.length === 0) {
      classification = "needs_source_bag_allocation";
      reasons.push("no allowed tablet types mapped");
    }

    if (p.kind === "VARIETY") {
      classification = "variety_pack_complexity";
      reasons.push("variety pack requires multi-bag allocation + component_batches");
    }

    if (
      p.zohoItemIdDisplay != null ||
      p.zohoItemIdCase != null
    ) {
      if (classification === "ready_once_v1206_deploys") {
        classification = "unsuitable_first_pilot";
      }
      reasons.push("display/case composites present — defer for first pilot");
    }

    if (
      classification === "ready_once_v1206_deploys" &&
      p.kind === "CARD"
    ) {
      reasons.push("single-SKU card candidate after allocation ledger wired");
    }

    report.push({
      sku: p.sku,
      name: p.name,
      kind: p.kind,
      family,
      classification,
      reasons,
    });
  }

  const byClass = new Map<AuditClass, number>();
  for (const row of report) {
    byClass.set(row.classification, (byClass.get(row.classification) ?? 0) + 1);
  }

  console.log(
    JSON.stringify(
      {
        audited_at: new Date().toISOString(),
        active_products: report.length,
        summary: Object.fromEntries(byClass),
        products: report.sort((a, b) => a.classification.localeCompare(b.classification)),
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
