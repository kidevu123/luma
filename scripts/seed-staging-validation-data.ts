// Phase VALIDATION-1 — Staging QA seed.
//
// Creates a self-contained set of QA_TEST_-prefixed records so the
// validation lab at /workflow-validation can exercise every workflow
// without polluting legacy data.
//
// Usage:
//   ALLOW_STAGING_QA_DATA=true tsx scripts/seed-staging-validation-data.ts
//   ALLOW_STAGING_QA_DATA=true tsx scripts/seed-staging-validation-data.ts --rotate-tokens
//   ALLOW_STAGING_QA_DATA=true tsx scripts/seed-staging-validation-data.ts --dry-run
//
// Safety gates:
//   • Refuses to run when NODE_ENV === "production" AND
//     ALLOW_STAGING_QA_DATA is not "true". On staging where NODE_ENV
//     defaults to "production" (Next.js convention) the env var must
//     be set explicitly.
//   • All records are prefixed QA_TEST_ on every text column where
//     uniqueness allows; rows that share a uniqueness scope with
//     legacy data are tagged in payload jsonb with
//     `staging_validation: true`.
//   • Re-running is idempotent — every insert uses ON CONFLICT or
//     a pre-check.
//
// Cleanup:
//   ALLOW_STAGING_QA_DATA=true tsx scripts/cleanup-staging-validation-data.ts

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql, and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

const QA_PREFIX = "QA_TEST_";
const QA_VENDOR = "QA_TEST_Supplier_Acme";
const QA_PO_NUMBER = "QA_TEST_PO_VAL_0001";

function refuseInProduction() {
  const envSaysProd = process.env.NODE_ENV === "production";
  const allowOverride = process.env.ALLOW_STAGING_QA_DATA === "true";
  if (envSaysProd && !allowOverride) {
    console.error(
      "[seed-staging-validation] Refusing to run: NODE_ENV=production and ALLOW_STAGING_QA_DATA != 'true'.",
    );
    console.error(
      "[seed-staging-validation] Set ALLOW_STAGING_QA_DATA=true to override on staging.",
    );
    process.exit(2);
  }
}

async function main() {
  refuseInProduction();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const dryRun = process.argv.includes("--dry-run");
  const rotateTokens = process.argv.includes("--rotate-tokens");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  console.log(
    `[seed-staging-validation] ${dryRun ? "DRY-RUN" : "LIVE"} — seeding QA_TEST_* records`,
  );

  let counts = {
    tablet_types: 0,
    products: 0,
    packaging_materials: 0,
    purchase_orders: 0,
    receives: 0,
    small_boxes: 0,
    inventory_bags: 0,
    packaging_lots: 0,
    items: 0,
    item_conversions: 0,
    product_packaging_specs: 0,
    blister_material_standards: 0,
    raw_item_weight_standards: 0,
    product_component_requirements: 0,
    product_route_assignments: 0,
    stations_rotated: 0,
  };

  if (dryRun) {
    console.log(
      "[seed-staging-validation] dry-run: skipping inserts. Re-run without --dry-run to apply.",
    );
    await client.end();
    return;
  }

  // ── Tablet types (raw items) ──
  // Three flavors so variety pack workflows can verify multi-component
  // reconciliation.
  const tabletTypeIds = await ensureTabletTypes(db);
  counts.tablet_types = Object.keys(tabletTypeIds).length;

  // ── Products ──
  const productIds = await ensureProducts(db);
  counts.products = productIds.size;

  // ── Packaging materials ──
  const materialIds = await ensurePackagingMaterials(db);
  counts.packaging_materials = materialIds.size;

  // ── Items registry backfill ──
  const itemIds = await ensureItems(db, tabletTypeIds, productIds, materialIds);
  counts.items = itemIds.size;

  // ── Production routes already seeded by migration 0013 ──
  // ── Product → route assignments ──
  counts.product_route_assignments = await ensureProductRouteAssignments(db, productIds);

  // ── Item conversions for the card and bottle products ──
  counts.item_conversions = await ensureItemConversions(db, productIds, itemIds, tabletTypeIds);

  // ── Packaging BOM ──
  counts.product_packaging_specs = await ensurePackagingBom(db, productIds, materialIds);

  // ── Blister material standards ──
  counts.blister_material_standards = await ensureBlisterStandards(
    db,
    productIds,
    materialIds,
  );

  // ── Raw item weight standard ──
  counts.raw_item_weight_standards = await ensureRawWeightStandard(db, tabletTypeIds);

  // ── Variety-pack component requirements ──
  counts.product_component_requirements = await ensureComponentRequirements(
    db,
    productIds,
    itemIds,
    tabletTypeIds,
  );

  // ── PO + receives + small boxes + inventory bags ──
  const { poId, receiveId, smallBoxId } = await ensurePoChain(db);
  counts.purchase_orders = poId ? 1 : 0;
  counts.receives = receiveId ? 1 : 0;
  counts.small_boxes = smallBoxId ? 1 : 0;
  counts.inventory_bags = await ensureInventoryBags(
    db,
    smallBoxId,
    tabletTypeIds,
  );

  // ── Roll lots (PVC + foil) ──
  counts.packaging_lots = await ensureRollLots(db, materialIds, poId);

  // ── Optional: rotate QA station tokens to UUID format ──
  if (rotateTokens) {
    counts.stations_rotated = await rotateQaStationTokens(db);
  }

  console.log("[seed-staging-validation] done. Counts:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(36)} ${v}`);
  }
  if (!rotateTokens) {
    console.log(
      "[seed-staging-validation] Tip: pass --rotate-tokens to rotate staging station tokens to UUID format so the new floor mutation actions accept them.",
    );
  }

  await client.end();
}

// ─── Helpers — every one is idempotent ─────────────────────────

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function ensureTabletTypes(db: Db): Promise<{
  flavorA: string;
  flavorB: string;
  flavorC: string;
  bulk: string;
}> {
  const skus = [
    { sku: "QA_TEST_RAW_FLAVOR_A", name: "QA Test Tablet — Flavor A" },
    { sku: "QA_TEST_RAW_FLAVOR_B", name: "QA Test Tablet — Flavor B" },
    { sku: "QA_TEST_RAW_FLAVOR_C", name: "QA Test Tablet — Flavor C" },
    { sku: "QA_TEST_RAW_BULK_X", name: "QA Test Tablet — Bulk X" },
  ];
  const out: Record<string, string> = {};
  for (const t of skus) {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM tablet_types WHERE sku = ${t.sku} LIMIT 1
    `);
    const list = existing as unknown as Array<{ id: string }>;
    if (list[0]) {
      out[t.sku] = list[0].id;
      continue;
    }
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO tablet_types (sku, name, default_mg_per_tablet, is_active)
      VALUES (${t.sku}, ${t.name}, 500, true)
      RETURNING id::text
    `);
    const ins = inserted as unknown as Array<{ id: string }>;
    out[t.sku] = ins[0]!.id;
  }
  return {
    flavorA: out["QA_TEST_RAW_FLAVOR_A"]!,
    flavorB: out["QA_TEST_RAW_FLAVOR_B"]!,
    flavorC: out["QA_TEST_RAW_FLAVOR_C"]!,
    bulk: out["QA_TEST_RAW_BULK_X"]!,
  };
}

async function ensureProducts(db: Db): Promise<Map<string, string>> {
  const products = [
    { sku: "QA_TEST_CARD_A", name: "QA Test Card Product A", kind: "CARD" },
    { sku: "QA_TEST_BOTTLE_A", name: "QA Test Bottle Product A", kind: "BOTTLE" },
    { sku: "QA_TEST_VARIETY_3PK", name: "QA Test Variety 3-Pack", kind: "VARIETY" },
  ];
  const out = new Map<string, string>();
  for (const p of products) {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM products WHERE sku = ${p.sku} LIMIT 1
    `);
    const list = existing as unknown as Array<{ id: string }>;
    if (list[0]) {
      out.set(p.sku, list[0].id);
      continue;
    }
    const ins = await db.execute<{ id: string }>(sql`
      INSERT INTO products (sku, name, kind, tablets_per_unit, units_per_display, displays_per_case, is_active)
      VALUES (${p.sku}, ${p.name}, ${p.kind}::product_kind, 20, 12, 24, true)
      RETURNING id::text
    `);
    out.set(p.sku, (ins as unknown as Array<{ id: string }>)[0]!.id);
  }
  return out;
}

async function ensurePackagingMaterials(db: Db): Promise<Map<string, string>> {
  const mats = [
    { sku: "QA_TEST_DISPLAY_BOX", name: "QA Display box (12)", kind: "DISPLAY", uom: "each" },
    { sku: "QA_TEST_MASTER_CASE", name: "QA Master case (24-disp)", kind: "CASE", uom: "each" },
    { sku: "QA_TEST_PVC_ROLL", name: "QA PVC roll", kind: "PVC_ROLL", uom: "roll" },
    { sku: "QA_TEST_FOIL_ROLL", name: "QA Foil roll", kind: "FOIL_ROLL", uom: "roll" },
    { sku: "QA_TEST_BOTTLE", name: "QA Bottle 30ct", kind: "BOTTLE", uom: "each" },
    { sku: "QA_TEST_CAP", name: "QA Cap", kind: "CAP", uom: "each" },
    { sku: "QA_TEST_LABEL", name: "QA Label", kind: "LABEL", uom: "each" },
    { sku: "QA_TEST_INDUCTION_SEAL", name: "QA Induction seal", kind: "INDUCTION_SEAL", uom: "each" },
  ];
  const out = new Map<string, string>();
  for (const m of mats) {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM packaging_materials WHERE sku = ${m.sku} LIMIT 1
    `);
    const list = existing as unknown as Array<{ id: string }>;
    if (list[0]) {
      out.set(m.sku, list[0].id);
      continue;
    }
    const ins = await db.execute<{ id: string }>(sql`
      INSERT INTO packaging_materials (sku, name, kind, uom, par_level, is_active)
      VALUES (${m.sku}, ${m.name}, ${m.kind}::packaging_material_kind, ${m.uom}, 100, true)
      RETURNING id::text
    `);
    out.set(m.sku, (ins as unknown as Array<{ id: string }>)[0]!.id);
  }
  return out;
}

async function ensureItems(
  db: Db,
  tabletTypeIds: { flavorA: string; flavorB: string; flavorC: string; bulk: string },
  productIds: Map<string, string>,
  materialIds: Map<string, string>,
): Promise<Map<string, string>> {
  // For each tablet type / product / packaging material, ensure an
  // items row exists. The 0014 backfill only ran once at migration
  // time; new master rows added after must be reflected here.
  const out = new Map<string, string>();
  const upsertItem = async (
    code: string,
    name: string,
    category: string,
    uom: string,
    sourceKind: "TABLET_TYPE" | "PRODUCT" | "PACKAGING_MATERIAL" | "STANDALONE",
    sourceId: string | null,
  ) => {
    if (sourceKind !== "STANDALONE" && sourceId) {
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id::text FROM items WHERE source_kind = ${sourceKind} AND source_id = ${sourceId} LIMIT 1
      `);
      const list = existing as unknown as Array<{ id: string }>;
      if (list[0]) {
        out.set(code, list[0].id);
        return;
      }
    } else {
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id::text FROM items WHERE item_code = ${code} LIMIT 1
      `);
      const list = existing as unknown as Array<{ id: string }>;
      if (list[0]) {
        out.set(code, list[0].id);
        return;
      }
    }
    const ins = await db.execute<{ id: string }>(sql`
      INSERT INTO items (item_code, name, item_category, default_unit_of_measure, source_kind, source_id, is_active)
      VALUES (${code}, ${name}, ${category}, ${uom}, ${sourceKind}, ${sourceId}, true)
      ON CONFLICT (item_code) DO NOTHING
      RETURNING id::text
    `);
    const insList = ins as unknown as Array<{ id: string }>;
    if (insList[0]) out.set(code, insList[0].id);
  };

  await upsertItem("TT:QA_TEST_RAW_FLAVOR_A", "QA Flavor A", "RAW_MATERIAL", "tablets", "TABLET_TYPE", tabletTypeIds.flavorA);
  await upsertItem("TT:QA_TEST_RAW_FLAVOR_B", "QA Flavor B", "RAW_MATERIAL", "tablets", "TABLET_TYPE", tabletTypeIds.flavorB);
  await upsertItem("TT:QA_TEST_RAW_FLAVOR_C", "QA Flavor C", "RAW_MATERIAL", "tablets", "TABLET_TYPE", tabletTypeIds.flavorC);
  await upsertItem("TT:QA_TEST_RAW_BULK_X", "QA Bulk X", "RAW_MATERIAL", "tablets", "TABLET_TYPE", tabletTypeIds.bulk);

  for (const [sku, id] of productIds.entries()) {
    await upsertItem(
      `PROD:${sku}`,
      sku,
      "FINISHED_GOOD",
      sku.includes("BOTTLE") ? "bottles" : sku.includes("VARIETY") ? "units" : "cards",
      "PRODUCT",
      id,
    );
  }
  for (const [sku, id] of materialIds.entries()) {
    await upsertItem(`PM:${sku}`, sku, "PACKAGING_MATERIAL", "each", "PACKAGING_MATERIAL", id);
  }
  return out;
}

async function ensureProductRouteAssignments(
  db: Db,
  productIds: Map<string, string>,
): Promise<number> {
  const cardId = productIds.get("QA_TEST_CARD_A")!;
  const bottleId = productIds.get("QA_TEST_BOTTLE_A")!;
  const varietyId = productIds.get("QA_TEST_VARIETY_3PK")!;
  type RouteRow = { id: string; code: string };
  const routes = await db.execute<RouteRow>(sql`
    SELECT id::text, code FROM production_routes WHERE code IN ('CARD_BLISTER','BOTTLE')
  `);
  const r = routes as unknown as RouteRow[];
  const cardRoute = r.find((x) => x.code === "CARD_BLISTER")?.id;
  const bottleRoute = r.find((x) => x.code === "BOTTLE")?.id;
  if (!cardRoute || !bottleRoute) return 0;
  let count = 0;
  for (const [pid, rid] of [
    [cardId, cardRoute],
    [bottleId, bottleRoute],
    [varietyId, cardRoute], // variety pack uses card route by default
  ] as const) {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM product_route_assignments
      WHERE product_id = ${pid} AND route_id = ${rid} AND is_active = true
      LIMIT 1
    `);
    const list = existing as unknown as Array<{ id: string }>;
    if (list[0]) {
      count++;
      continue;
    }
    await db.execute(sql`
      INSERT INTO product_route_assignments (product_id, route_id, is_default, is_active)
      VALUES (${pid}, ${rid}, true, true)
    `);
    count++;
  }
  return count;
}

async function ensureItemConversions(
  db: Db,
  productIds: Map<string, string>,
  itemIds: Map<string, string>,
  tabletTypeIds: { flavorA: string; flavorB: string; flavorC: string; bulk: string },
): Promise<number> {
  void tabletTypeIds;
  // For card product: case → display (24), display → card (12), card → tablets (20).
  // For bottle product: case → display (24), display → bottle (12), bottle → tablets (30).
  let count = 0;
  const insert = async (
    productSku: string,
    parentItem: string,
    childItem: string,
    parentQty: number,
    childQty: number,
    parentLevel: string,
    childLevel: string,
    parentUom: string,
    childUom: string,
  ) => {
    const productId = productIds.get(productSku);
    const parentId = itemIds.get(parentItem);
    const childId = itemIds.get(childItem);
    if (!productId || !parentId || !childId) return;
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM item_conversions
      WHERE product_id = ${productId}
        AND parent_item_id = ${parentId}
        AND child_item_id = ${childId}
        AND is_active = true
        AND effective_to IS NULL
      LIMIT 1
    `);
    if ((existing as unknown as Array<unknown>).length > 0) {
      count++;
      return;
    }
    await db.execute(sql`
      INSERT INTO item_conversions (
        product_id, parent_item_id, child_item_id,
        parent_quantity, parent_unit_of_measure, parent_pack_level,
        child_quantity, child_unit_of_measure, child_pack_level,
        is_active
      ) VALUES (
        ${productId}, ${parentId}, ${childId},
        ${parentQty}, ${parentUom}, ${parentLevel},
        ${childQty}, ${childUom}, ${childLevel},
        true
      )
    `);
    count++;
  };

  await insert("QA_TEST_CARD_A", "PROD:QA_TEST_CARD_A", "TT:QA_TEST_RAW_BULK_X",
    1, 20 * 12 * 24, "CASE", "RAW", "cases", "tablets");
  await insert("QA_TEST_BOTTLE_A", "PROD:QA_TEST_BOTTLE_A", "TT:QA_TEST_RAW_BULK_X",
    1, 30 * 12 * 24, "CASE", "RAW", "cases", "tablets");

  return count;
}

async function ensurePackagingBom(
  db: Db,
  productIds: Map<string, string>,
  materialIds: Map<string, string>,
): Promise<number> {
  let count = 0;
  const upsert = async (productSku: string, materialSku: string, qty: number, scope: string) => {
    const productId = productIds.get(productSku);
    const materialId = materialIds.get(materialSku);
    if (!productId || !materialId) return;
    await db.execute(sql`
      INSERT INTO product_packaging_specs (product_id, packaging_material_id, qty_per_unit, per_scope, waste_allowance_percent)
      VALUES (${productId}, ${materialId}, ${qty}, ${scope}, 0)
      ON CONFLICT (product_id, packaging_material_id, per_scope) DO NOTHING
    `);
    count++;
  };
  await upsert("QA_TEST_CARD_A", "QA_TEST_DISPLAY_BOX", 1, "DISPLAY");
  await upsert("QA_TEST_CARD_A", "QA_TEST_MASTER_CASE", 1, "CASE");
  await upsert("QA_TEST_BOTTLE_A", "QA_TEST_BOTTLE", 1, "UNIT");
  await upsert("QA_TEST_BOTTLE_A", "QA_TEST_CAP", 1, "UNIT");
  await upsert("QA_TEST_BOTTLE_A", "QA_TEST_LABEL", 1, "UNIT");
  await upsert("QA_TEST_BOTTLE_A", "QA_TEST_INDUCTION_SEAL", 1, "UNIT");
  await upsert("QA_TEST_BOTTLE_A", "QA_TEST_DISPLAY_BOX", 1, "DISPLAY");
  await upsert("QA_TEST_BOTTLE_A", "QA_TEST_MASTER_CASE", 1, "CASE");
  return count;
}

async function ensureBlisterStandards(
  db: Db,
  productIds: Map<string, string>,
  materialIds: Map<string, string>,
): Promise<number> {
  let count = 0;
  const cardId = productIds.get("QA_TEST_CARD_A");
  const pvcId = materialIds.get("QA_TEST_PVC_ROLL");
  const foilId = materialIds.get("QA_TEST_FOIL_ROLL");
  if (!cardId) return 0;
  const upsert = async (materialId: string | undefined, role: string, gramsPerBlister: number) => {
    if (!materialId) return;
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM blister_material_standards
      WHERE product_id = ${cardId} AND packaging_material_id = ${materialId} AND material_role = ${role} AND is_active = true
      LIMIT 1
    `);
    if ((existing as unknown as Array<unknown>).length > 0) {
      count++;
      return;
    }
    await db.execute(sql`
      INSERT INTO blister_material_standards
        (product_id, packaging_material_id, material_role, expected_grams_per_blister, setup_waste_grams, changeover_waste_grams, effective_from, is_active)
      VALUES (${cardId}, ${materialId}, ${role}, ${gramsPerBlister}, 50, 25, CURRENT_DATE, true)
    `);
    count++;
  };
  await upsert(pvcId, "PVC", 4.2);
  await upsert(foilId, "FOIL", 2.0);
  return count;
}

async function ensureRawWeightStandard(
  db: Db,
  tabletTypeIds: { flavorA: string; flavorB: string; flavorC: string; bulk: string },
): Promise<number> {
  let count = 0;
  const upsert = async (tabletTypeId: string, gramsPerUnit: number) => {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM raw_item_weight_standards
      WHERE tablet_type_id = ${tabletTypeId} AND is_active = true AND effective_to IS NULL
      LIMIT 1
    `);
    if ((existing as unknown as Array<unknown>).length > 0) {
      count++;
      return;
    }
    await db.execute(sql`
      INSERT INTO raw_item_weight_standards
        (tablet_type_id, sample_source, standard_unit_weight, weight_unit, confidence, effective_from, is_active, notes)
      VALUES (${tabletTypeId}, 'QA_TEST_seed', ${gramsPerUnit}, 'g', 'MEDIUM', CURRENT_DATE, true, 'Seeded by staging validation script.')
    `);
    count++;
  };
  await upsert(tabletTypeIds.bulk, 0.5);
  await upsert(tabletTypeIds.flavorA, 0.5);
  await upsert(tabletTypeIds.flavorB, 0.5);
  await upsert(tabletTypeIds.flavorC, 0.5);
  return count;
}

async function ensureComponentRequirements(
  db: Db,
  productIds: Map<string, string>,
  itemIds: Map<string, string>,
  _tabletTypeIds: { flavorA: string; flavorB: string; flavorC: string; bulk: string },
): Promise<number> {
  let count = 0;
  const varietyId = productIds.get("QA_TEST_VARIETY_3PK");
  if (!varietyId) return 0;
  const upsert = async (itemKey: string, role: string, qty: number) => {
    const itemId = itemIds.get(itemKey);
    if (!itemId) return;
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM product_component_requirements
      WHERE product_id = ${varietyId} AND component_item_id = ${itemId}
        AND component_role = ${role} AND is_active = true AND effective_to IS NULL
      LIMIT 1
    `);
    if ((existing as unknown as Array<unknown>).length > 0) {
      count++;
      return;
    }
    await db.execute(sql`
      INSERT INTO product_component_requirements
        (product_id, component_item_id, component_role, quantity_per_finished_unit, unit_of_measure, effective_from, is_active)
      VALUES (${varietyId}, ${itemId}, ${role}, ${qty}, 'tablets', CURRENT_DATE, true)
    `);
    count++;
  };
  await upsert("TT:QA_TEST_RAW_FLAVOR_A", "FLAVOR_A", 4);
  await upsert("TT:QA_TEST_RAW_FLAVOR_B", "FLAVOR_B", 4);
  await upsert("TT:QA_TEST_RAW_FLAVOR_C", "FLAVOR_C", 4);
  return count;
}

async function ensurePoChain(
  db: Db,
): Promise<{ poId: string; receiveId: string; smallBoxId: string }> {
  // PO
  let poId: string;
  const existingPo = await db.execute<{ id: string }>(sql`
    SELECT id::text FROM purchase_orders WHERE po_number = ${QA_PO_NUMBER} LIMIT 1
  `);
  const poList = existingPo as unknown as Array<{ id: string }>;
  if (poList[0]) {
    poId = poList[0].id;
  } else {
    const ins = await db.execute<{ id: string }>(sql`
      INSERT INTO purchase_orders (po_number, vendor_name, status, opened_at, notes)
      VALUES (${QA_PO_NUMBER}, ${QA_VENDOR}, 'OPEN', now(), 'QA_TEST staging validation seed.')
      RETURNING id::text
    `);
    poId = (ins as unknown as Array<{ id: string }>)[0]!.id;
  }

  // Receive
  let receiveId: string;
  const existingReceive = await db.execute<{ id: string }>(sql`
    SELECT id::text FROM receives WHERE receive_name = ${QA_PO_NUMBER + "-R1"} LIMIT 1
  `);
  const recList = existingReceive as unknown as Array<{ id: string }>;
  if (recList[0]) {
    receiveId = recList[0].id;
  } else {
    const ins = await db.execute<{ id: string }>(sql`
      INSERT INTO receives (po_id, receive_name, received_at, notes)
      VALUES (${poId}, ${QA_PO_NUMBER + "-R1"}, now(), 'QA_TEST seed.')
      RETURNING id::text
    `);
    receiveId = (ins as unknown as Array<{ id: string }>)[0]!.id;
  }

  // Small box
  let smallBoxId: string;
  const existingSb = await db.execute<{ id: string }>(sql`
    SELECT id::text FROM small_boxes WHERE receive_id = ${receiveId} AND box_number = 1 LIMIT 1
  `);
  const sbList = existingSb as unknown as Array<{ id: string }>;
  if (sbList[0]) {
    smallBoxId = sbList[0].id;
  } else {
    const ins = await db.execute<{ id: string }>(sql`
      INSERT INTO small_boxes (receive_id, box_number, total_bags)
      VALUES (${receiveId}, 1, 4)
      RETURNING id::text
    `);
    smallBoxId = (ins as unknown as Array<{ id: string }>)[0]!.id;
  }
  return { poId, receiveId, smallBoxId };
}

async function ensureInventoryBags(
  db: Db,
  smallBoxId: string,
  tabletTypeIds: { flavorA: string; flavorB: string; flavorC: string; bulk: string },
): Promise<number> {
  let count = 0;
  const seedBags = [
    { bagNo: 1, ttKey: "bulk" as const,    qrCode: "QA_TEST_VBC_BULK_001",     pillCount: 20000, weightGrams: 10000 },
    { bagNo: 2, ttKey: "flavorA" as const, qrCode: "QA_TEST_VBC_FLAVA_001",    pillCount: 10000, weightGrams: 5000 },
    { bagNo: 3, ttKey: "flavorB" as const, qrCode: "QA_TEST_VBC_FLAVB_001",    pillCount: 10000, weightGrams: 5000 },
    { bagNo: 4, ttKey: "flavorC" as const, qrCode: "QA_TEST_VBC_FLAVC_001",    pillCount: 10000, weightGrams: 5000 },
  ];
  for (const b of seedBags) {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM inventory_bags WHERE small_box_id = ${smallBoxId} AND bag_number = ${b.bagNo} LIMIT 1
    `);
    if ((existing as unknown as Array<unknown>).length > 0) {
      count++;
      continue;
    }
    await db.execute(sql`
      INSERT INTO inventory_bags
        (small_box_id, bag_number, tablet_type_id, pill_count, weight_grams, vendor_barcode, status)
      VALUES (
        ${smallBoxId}, ${b.bagNo}, ${tabletTypeIds[b.ttKey]},
        ${b.pillCount}, ${b.weightGrams}, ${b.qrCode}, 'AVAILABLE'
      )
    `);
    count++;
  }
  return count;
}

async function ensureRollLots(
  db: Db,
  materialIds: Map<string, string>,
  poId: string,
): Promise<number> {
  let count = 0;
  const insertRoll = async (
    sku: string,
    rollNumber: string,
    netGrams: number,
  ) => {
    const matId = materialIds.get(sku);
    if (!matId) return;
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM packaging_lots WHERE roll_number = ${rollNumber} LIMIT 1
    `);
    if ((existing as unknown as Array<unknown>).length > 0) {
      count++;
      return;
    }
    await db.execute(sql`
      INSERT INTO packaging_lots
        (packaging_material_id, po_id, qty_received, qty_on_hand,
         status, roll_number, gross_weight_grams, tare_weight_grams,
         net_weight_grams, current_weight_grams_estimate, weight_unit,
         supplier, location, confidence, notes)
      VALUES (
        ${matId}, ${poId}, 1, 1,
        'AVAILABLE', ${rollNumber}, ${netGrams + 500}, 500,
        ${netGrams}, ${netGrams}, 'g',
        ${QA_VENDOR}, 'QA_TEST_BAY_A', 'HIGH', 'QA_TEST seed.'
      )
    `);
    count++;
  };
  // VALIDATION-2C.1 — 4 lots so TEST C's mid-bag PVC and FOIL roll
  // changes are exercisable end-to-end. Net weights chosen to match
  // the worked example math: net 1500 g for PVC Roll 1 means
  // grams/blister = 1500 / 35562 ≈ 0.04218 once depleted.
  await insertRoll("QA_TEST_PVC_ROLL", "QA_TEST_PVC_ROLL_001", 1500);
  await insertRoll("QA_TEST_PVC_ROLL", "QA_TEST_PVC_ROLL_002", 1500);
  await insertRoll("QA_TEST_FOIL_ROLL", "QA_TEST_FOIL_ROLL_001", 1500);
  await insertRoll("QA_TEST_FOIL_ROLL", "QA_TEST_FOIL_ROLL_002", 1500);
  return count;
}

async function rotateQaStationTokens(db: Db): Promise<number> {
  // Rotate stations whose label starts with "QA_TEST_" or whose
  // current scan_token is in the legacy kind-prefixed-hex format.
  // We do NOT rotate any station whose token is already a UUID
  // (that's almost certainly a production-rotated station).
  const rows = await db.execute<{ id: string; label: string; scan_token: string }>(sql`
    SELECT id::text, label, scan_token FROM stations
    WHERE is_active = true
      AND scan_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  `);
  const list = rows as unknown as Array<{ id: string; label: string; scan_token: string }>;
  let rotated = 0;
  for (const s of list) {
    const fresh = crypto.randomUUID();
    await db.execute(sql`
      UPDATE stations SET scan_token = ${fresh} WHERE id = ${s.id}
    `);
    console.log(
      `[seed-staging-validation] rotated token: ${s.label.padEnd(28)} ${s.scan_token} → ${fresh}`,
    );
    rotated++;
  }
  return rotated;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
