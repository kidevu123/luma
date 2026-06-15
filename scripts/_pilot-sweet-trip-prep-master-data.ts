#!/usr/bin/env npx tsx
// Pilot #2 — scoped Sweet Trip master-data prep (single product + tablet type only).
//
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/_pilot-sweet-trip-prep-master-data.ts
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/_pilot-sweet-trip-prep-master-data.ts --apply

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, tabletTypes } from "@/lib/db/schema";
import {
  SWEET_TRIP_PRODUCT_ID,
  SWEET_TRIP_PRODUCT_FAMILY,
  SWEET_TRIP_UNIT_COMPOSITE_ITEM_ID,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";

/** Same value as FIX Relax 1ct — MIT B Choco has null; pilot checklist requires a value. */
const DEFAULT_SHELF_LIFE_DAYS = 730;

const SWEET_TRIP_TABLET_TYPE_ID = "b441f6d4-4937-41db-ab48-c68afc65c324";

async function main() {
  const allow =
    process.env.ALLOW_STAGING_QA_DATA === "true" ||
    process.env.ALLOW_STAGING_QA_DATA === "1";
  if (!allow) {
    console.error("[sweet-trip-prep] Refusing: set ALLOW_STAGING_QA_DATA=true");
    process.exit(2);
  }

  const apply = process.argv.includes("--apply");

  const [productBefore] = await db
    .select({
      id: products.id,
      name: products.name,
      productFamily: products.productFamily,
      zohoItemIdUnit: products.zohoItemIdUnit,
      defaultShelfLifeDays: products.defaultShelfLifeDays,
    })
    .from(products)
    .where(eq(products.id, SWEET_TRIP_PRODUCT_ID))
    .limit(1);

  const [tabletBefore] = await db
    .select({
      id: tabletTypes.id,
      name: tabletTypes.name,
      productFamily: tabletTypes.productFamily,
    })
    .from(tabletTypes)
    .where(eq(tabletTypes.id, SWEET_TRIP_TABLET_TYPE_ID))
    .limit(1);

  if (!productBefore) {
    console.error("[sweet-trip-prep] Product not found:", SWEET_TRIP_PRODUCT_ID);
    process.exit(1);
  }
  if (!tabletBefore) {
    console.error("[sweet-trip-prep] Tablet type not found:", SWEET_TRIP_TABLET_TYPE_ID);
    process.exit(1);
  }

  const productPatch = {
    productFamily: SWEET_TRIP_PRODUCT_FAMILY,
    zohoItemIdUnit: SWEET_TRIP_UNIT_COMPOSITE_ITEM_ID,
    defaultShelfLifeDays:
      productBefore.defaultShelfLifeDays ?? DEFAULT_SHELF_LIFE_DAYS,
  };

  const tabletPatch = {
    productFamily: SWEET_TRIP_PRODUCT_FAMILY,
  };

  console.log(
    JSON.stringify(
      {
        step: "dry_run",
        apply,
        productBefore,
        tabletBefore,
        productPatch,
        tabletPatch,
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log("[sweet-trip-prep] Dry run only — pass --apply to write.");
    return;
  }

  await db
    .update(products)
    .set(productPatch)
    .where(eq(products.id, SWEET_TRIP_PRODUCT_ID));

  await db
    .update(tabletTypes)
    .set(tabletPatch)
    .where(eq(tabletTypes.id, SWEET_TRIP_TABLET_TYPE_ID));

  const [productAfter] = await db
    .select({
      productFamily: products.productFamily,
      zohoItemIdUnit: products.zohoItemIdUnit,
      defaultShelfLifeDays: products.defaultShelfLifeDays,
    })
    .from(products)
    .where(eq(products.id, SWEET_TRIP_PRODUCT_ID))
    .limit(1);

  const [tabletAfter] = await db
    .select({ productFamily: tabletTypes.productFamily })
    .from(tabletTypes)
    .where(eq(tabletTypes.id, SWEET_TRIP_TABLET_TYPE_ID))
    .limit(1);

  console.log(
    JSON.stringify({ step: "applied", productAfter, tabletAfter }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
