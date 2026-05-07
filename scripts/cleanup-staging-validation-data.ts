// Phase VALIDATION-1 — Staging QA cleanup.
//
// Removes records prefixed QA_TEST_* (or marked staging_validation
// in payload). Legacy data is untouched.
//
// Usage:
//   ALLOW_STAGING_QA_DATA=true tsx scripts/cleanup-staging-validation-data.ts
//   ALLOW_STAGING_QA_DATA=true tsx scripts/cleanup-staging-validation-data.ts --dry-run
//
// Order matters — we delete from the leaves of the FK graph upward:
// allocation events → sessions → consumption events → ledger →
// child rows → parent rows → tablet_types / products / packaging_materials.
//
// This script is intentionally narrow. Anything not prefixed
// QA_TEST_ is left alone. Re-running is idempotent.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

function refuseInProduction() {
  const envSaysProd = process.env.NODE_ENV === "production";
  const allowOverride = process.env.ALLOW_STAGING_QA_DATA === "true";
  if (envSaysProd && !allowOverride) {
    console.error(
      "[cleanup-staging-validation] Refusing to run: NODE_ENV=production and ALLOW_STAGING_QA_DATA != 'true'.",
    );
    process.exit(2);
  }
}

async function main() {
  refuseInProduction();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const dryRun = process.argv.includes("--dry-run");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  console.log(
    `[cleanup-staging-validation] ${dryRun ? "DRY-RUN" : "LIVE"} — removing QA_TEST_* records`,
  );

  // The cleanup is keyed by:
  //   1. tablet_types.sku LIKE 'QA_TEST_%'
  //   2. products.sku LIKE 'QA_TEST_%'
  //   3. packaging_materials.sku LIKE 'QA_TEST_%'
  //   4. purchase_orders.po_number LIKE 'QA_TEST_%'
  // Their FK chains pull the rest down.

  if (dryRun) {
    const counts = await db.execute<{
      tablet_types: number;
      products: number;
      packaging_materials: number;
      purchase_orders: number;
      inventory_bags: number;
      packaging_lots: number;
      items: number;
      raw_bag_allocation_events: number;
      raw_bag_allocation_sessions: number;
      product_component_requirements: number;
      product_route_assignments: number;
      product_packaging_specs: number;
      blister_material_standards: number;
      raw_item_weight_standards: number;
      item_conversions: number;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM tablet_types WHERE sku LIKE 'QA_TEST_%')                                                  AS tablet_types,
        (SELECT COUNT(*)::int FROM products WHERE sku LIKE 'QA_TEST_%')                                                       AS products,
        (SELECT COUNT(*)::int FROM packaging_materials WHERE sku LIKE 'QA_TEST_%')                                            AS packaging_materials,
        (SELECT COUNT(*)::int FROM purchase_orders WHERE po_number LIKE 'QA_TEST_%')                                          AS purchase_orders,
        (SELECT COUNT(*)::int FROM inventory_bags WHERE small_box_id IN (
          SELECT sb.id FROM small_boxes sb JOIN receives r ON r.id=sb.receive_id JOIN purchase_orders po ON po.id=r.po_id WHERE po.po_number LIKE 'QA_TEST_%'
        ))                                                                                                                    AS inventory_bags,
        (SELECT COUNT(*)::int FROM packaging_lots pl JOIN packaging_materials pm ON pm.id=pl.packaging_material_id WHERE pm.sku LIKE 'QA_TEST_%') AS packaging_lots,
        (SELECT COUNT(*)::int FROM items WHERE item_code LIKE 'TT:QA_TEST_%' OR item_code LIKE 'PROD:QA_TEST_%' OR item_code LIKE 'PM:QA_TEST_%') AS items,
        (SELECT COUNT(*)::int FROM raw_bag_allocation_events e JOIN inventory_bags ib ON ib.id=e.inventory_bag_id JOIN small_boxes sb ON sb.id=ib.small_box_id JOIN receives r ON r.id=sb.receive_id JOIN purchase_orders po ON po.id=r.po_id WHERE po.po_number LIKE 'QA_TEST_%') AS raw_bag_allocation_events,
        (SELECT COUNT(*)::int FROM raw_bag_allocation_sessions s JOIN inventory_bags ib ON ib.id=s.inventory_bag_id JOIN small_boxes sb ON sb.id=ib.small_box_id JOIN receives r ON r.id=sb.receive_id JOIN purchase_orders po ON po.id=r.po_id WHERE po.po_number LIKE 'QA_TEST_%') AS raw_bag_allocation_sessions,
        (SELECT COUNT(*)::int FROM product_component_requirements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')) AS product_component_requirements,
        (SELECT COUNT(*)::int FROM product_route_assignments WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')) AS product_route_assignments,
        (SELECT COUNT(*)::int FROM product_packaging_specs WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')) AS product_packaging_specs,
        (SELECT COUNT(*)::int FROM blister_material_standards WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')) AS blister_material_standards,
        (SELECT COUNT(*)::int FROM raw_item_weight_standards WHERE tablet_type_id IN (SELECT id FROM tablet_types WHERE sku LIKE 'QA_TEST_%')) AS raw_item_weight_standards,
        (SELECT COUNT(*)::int FROM item_conversions WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')) AS item_conversions
    `);
    const c = (counts as unknown as Array<Record<string, number>>)[0]!;
    console.log("[cleanup-staging-validation] dry-run counts:");
    for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(36)} ${v}`);
    await client.end();
    return;
  }

  // Order: leaves first.
  await db.execute(sql`
    -- Material consumption events tied to QA bags / lots / products
    DELETE FROM material_inventory_events
    WHERE packaging_lot_id IN (
      SELECT pl.id FROM packaging_lots pl
      JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
      WHERE pm.sku LIKE 'QA_TEST_%'
    )
    OR product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    -- Raw bag allocation events
    DELETE FROM raw_bag_allocation_events
    WHERE inventory_bag_id IN (
      SELECT ib.id FROM inventory_bags ib
      JOIN small_boxes sb ON sb.id = ib.small_box_id
      JOIN receives r ON r.id = sb.receive_id
      JOIN purchase_orders po ON po.id = r.po_id
      WHERE po.po_number LIKE 'QA_TEST_%'
    )
    OR product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM raw_bag_allocation_sessions
    WHERE inventory_bag_id IN (
      SELECT ib.id FROM inventory_bags ib
      JOIN small_boxes sb ON sb.id = ib.small_box_id
      JOIN receives r ON r.id = sb.receive_id
      JOIN purchase_orders po ON po.id = r.po_id
      WHERE po.po_number LIKE 'QA_TEST_%'
    )
    OR product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM product_component_requirements
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM item_conversions
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM product_route_assignments
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM product_packaging_specs
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
       OR packaging_material_id IN (SELECT id FROM packaging_materials WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM blister_material_standards
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
       OR packaging_material_id IN (SELECT id FROM packaging_materials WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM raw_item_weight_standards
    WHERE tablet_type_id IN (SELECT id FROM tablet_types WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM packaging_lots
    WHERE packaging_material_id IN (SELECT id FROM packaging_materials WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM inventory_bags
    WHERE small_box_id IN (
      SELECT sb.id FROM small_boxes sb
      JOIN receives r ON r.id = sb.receive_id
      JOIN purchase_orders po ON po.id = r.po_id
      WHERE po.po_number LIKE 'QA_TEST_%'
    )
  `);

  await db.execute(sql`
    DELETE FROM small_boxes
    WHERE receive_id IN (SELECT r.id FROM receives r JOIN purchase_orders po ON po.id = r.po_id WHERE po.po_number LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM receives
    WHERE po_id IN (SELECT id FROM purchase_orders WHERE po_number LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM purchase_orders WHERE po_number LIKE 'QA_TEST_%'
  `);

  // External mappings tied to QA materials/products.
  await db.execute(sql`
    DELETE FROM external_item_mappings
    WHERE luma_item_id IN (SELECT id FROM items WHERE item_code LIKE 'TT:QA_TEST_%' OR item_code LIKE 'PROD:QA_TEST_%' OR item_code LIKE 'PM:QA_TEST_%')
       OR luma_product_id IN (SELECT id FROM products WHERE sku LIKE 'QA_TEST_%')
       OR material_item_id IN (SELECT id FROM packaging_materials WHERE sku LIKE 'QA_TEST_%')
  `);

  await db.execute(sql`
    DELETE FROM items
    WHERE item_code LIKE 'TT:QA_TEST_%'
       OR item_code LIKE 'PROD:QA_TEST_%'
       OR item_code LIKE 'PM:QA_TEST_%'
  `);

  await db.execute(sql`
    DELETE FROM packaging_materials WHERE sku LIKE 'QA_TEST_%'
  `);

  await db.execute(sql`
    DELETE FROM products WHERE sku LIKE 'QA_TEST_%'
  `);

  await db.execute(sql`
    DELETE FROM tablet_types WHERE sku LIKE 'QA_TEST_%'
  `);

  console.log("[cleanup-staging-validation] done.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
