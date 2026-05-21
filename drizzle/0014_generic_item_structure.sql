-- Phase H.x0.5 — Generic item identity + product structure + Zoho foundation.
--
-- Adds:
--   • items                          — generic identity layer over tablet_types,
--                                       products, packaging_materials, plus
--                                       standalone intermediates (e.g. "blister
--                                       card before sealing").
--   • item_conversions               — generic "1 X contains N Y" relationship.
--                                       Replaces ad-hoc tablets_per_unit /
--                                       units_per_display / displays_per_case
--                                       with a configurable model that works
--                                       for any product type.
--   • external_systems               — registry of upstream systems (Zoho today,
--                                       PackTrack/Nexus/QIP later).
--   • external_item_mappings         — mapping table for SKUs → Luma items.
--   • external_inventory_snapshots   — append-only snapshots for visibility;
--                                       does NOT mutate Luma genealogy.
--
-- Backfills items from tablet_types, packaging_materials, and products.
-- Idempotent (ON CONFLICT DO NOTHING).
--
-- Does NOT remove any legacy column. The legacy products.tablets_per_unit /
-- units_per_display / displays_per_case columns remain authoritative until
-- the helper layer reads exclusively from item_conversions in a follow-up
-- phase.
--
-- See docs/PRODUCT_STRUCTURE_AND_ZOHO_ITEMS.md.

-- ── 1. items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "items" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_code"                text NOT NULL,
  "name"                     text NOT NULL,
  "description"              text,
  "item_category"            text NOT NULL,
  "default_unit_of_measure"  text NOT NULL,
  -- Polymorphic source pointer. Source rows live in tablet_types,
  -- packaging_materials, products, OR are standalone "virtual"
  -- intermediates (a blister-card-not-yet-sealed). FK is enforced
  -- at the application layer due to the polymorphism.
  "source_kind"              text,
  "source_id"                uuid,
  "is_active"                boolean NOT NULL DEFAULT true,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "items_item_code_unique" UNIQUE ("item_code"),
  CONSTRAINT "items_source_unique" UNIQUE ("source_kind", "source_id"),
  CONSTRAINT "items_category_check" CHECK (
    "item_category" IN (
      'RAW_MATERIAL', 'PACKAGING_MATERIAL', 'COMPONENT',
      'INTERMEDIATE_GOOD', 'FINISHED_GOOD', 'SELLABLE_SKU',
      'SERVICE', 'OTHER'
    )
  ),
  CONSTRAINT "items_source_kind_check" CHECK (
    "source_kind" IS NULL
    OR "source_kind" IN ('TABLET_TYPE','PACKAGING_MATERIAL','PRODUCT','STANDALONE')
  )
);
CREATE INDEX IF NOT EXISTS "items_category_idx"   ON "items" ("item_category", "is_active");
CREATE INDEX IF NOT EXISTS "items_source_idx"     ON "items" ("source_kind", "source_id");

-- ── 2. item_conversions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "item_conversions" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"               uuid REFERENCES "products"("id") ON DELETE CASCADE,
  "route_id"                 uuid REFERENCES "production_routes"("id") ON DELETE SET NULL,
  -- Direction is fixed: parent (output) contains child (input).
  -- 1 blister card contains 20 tablets:
  --   parent_item    = blister card item
  --   parent_qty     = 1
  --   child_item     = tablet item
  --   child_qty      = 20
  "parent_item_id"           uuid NOT NULL REFERENCES "items"("id") ON DELETE RESTRICT,
  "child_item_id"            uuid NOT NULL REFERENCES "items"("id") ON DELETE RESTRICT,
  "parent_quantity"          numeric(20,6) NOT NULL,
  "parent_unit_of_measure"   text NOT NULL,
  "parent_pack_level"        text NOT NULL,
  "child_quantity"           numeric(20,6) NOT NULL,
  "child_unit_of_measure"    text NOT NULL,
  "child_pack_level"         text NOT NULL,
  "effective_from"           date NOT NULL DEFAULT CURRENT_DATE,
  "effective_to"             date,
  "is_active"                boolean NOT NULL DEFAULT true,
  "notes"                    text,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "item_conversions_qty_positive" CHECK (
    "parent_quantity" > 0 AND "child_quantity" > 0
  ),
  CONSTRAINT "item_conversions_pack_levels_check" CHECK (
    "parent_pack_level" IN (
      'RAW','COMPONENT','INTERMEDIATE','UNIT','INNER_PACK',
      'DISPLAY','CASE','PALLET','FINISHED_GOOD','SELLABLE'
    ) AND "child_pack_level" IN (
      'RAW','COMPONENT','INTERMEDIATE','UNIT','INNER_PACK',
      'DISPLAY','CASE','PALLET','FINISHED_GOOD','SELLABLE'
    )
  ),
  CONSTRAINT "item_conversions_distinct_items" CHECK ("parent_item_id" <> "child_item_id"),
  CONSTRAINT "item_conversions_effective_window" CHECK (
    "effective_to" IS NULL OR "effective_to" >= "effective_from"
  )
);
CREATE INDEX IF NOT EXISTS "item_conversions_product_idx" ON "item_conversions" ("product_id", "is_active");
CREATE INDEX IF NOT EXISTS "item_conversions_route_idx"   ON "item_conversions" ("route_id");
CREATE INDEX IF NOT EXISTS "item_conversions_parent_idx"  ON "item_conversions" ("parent_item_id", "is_active");
CREATE INDEX IF NOT EXISTS "item_conversions_child_idx"   ON "item_conversions" ("child_item_id", "is_active");

-- Prevent overlapping ACTIVE conversions for the same (product, route,
-- parent, child) tuple. Partial unique index — allows historical
-- inactive rows to remain.
-- Note: the "no overlap on effective windows" rule is too rich for
-- a single B-tree unique. Application-level validation enforces the
-- date-window check on insert; this index catches the most common
-- mistake — duplicate active rows with no end date.
CREATE UNIQUE INDEX IF NOT EXISTS "item_conversions_active_unique"
  ON "item_conversions" ("product_id", "route_id", "parent_item_id", "child_item_id")
  WHERE "is_active" = true AND "effective_to" IS NULL;

-- ── 3. external_systems ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "external_systems" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "external_systems_code_unique" UNIQUE ("code")
);

-- Seed the systems Luma will eventually read from.
INSERT INTO "external_systems" ("code","name","description") VALUES
  ('ZOHO',      'Zoho Inventory', 'Demand, item catalog, inventory snapshots, sales orders.'),
  ('PACKTRACK', 'PackTrack',      'Material-pull / packing-list system. Future read-only.'),
  ('NEXUS',     'Nexus QA',       'Quality / batch-release. Future read-only.'),
  ('QIP',       'QIP',            'Quality information portal. Future read-only.')
ON CONFLICT ("code") DO NOTHING;

-- ── 4. external_item_mappings ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "external_item_mappings" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "external_system_id"  uuid NOT NULL REFERENCES "external_systems"("id") ON DELETE CASCADE,
  "external_item_id"    text NOT NULL,
  "external_item_code"  text,
  "external_item_name"  text,
  "luma_item_id"        uuid REFERENCES "items"("id") ON DELETE SET NULL,
  "luma_product_id"     uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "material_item_id"    uuid REFERENCES "packaging_materials"("id") ON DELETE SET NULL,
  -- Hint about how the upstream item should be classified once mapped.
  -- UNKNOWN means "we have not yet decided." Production code that needs
  -- the mapping must surface a "Mapping missing" missing-state until
  -- the type is set explicitly.
  "mapping_type"        text NOT NULL DEFAULT 'UNKNOWN',
  "is_active"           boolean NOT NULL DEFAULT true,
  "last_synced_at"      timestamptz,
  "payload"             jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "external_item_mappings_unique"
    UNIQUE ("external_system_id", "external_item_id"),
  CONSTRAINT "external_item_mappings_type_check" CHECK (
    "mapping_type" IN (
      'RAW_MATERIAL','PACKAGING_MATERIAL','COMPONENT',
      'INTERMEDIATE_GOOD','FINISHED_GOOD','SELLABLE_SKU','UNKNOWN'
    )
  )
);
CREATE INDEX IF NOT EXISTS "external_item_mappings_system_idx"
  ON "external_item_mappings" ("external_system_id", "is_active");
CREATE INDEX IF NOT EXISTS "external_item_mappings_luma_item_idx"
  ON "external_item_mappings" ("luma_item_id");
CREATE INDEX IF NOT EXISTS "external_item_mappings_product_idx"
  ON "external_item_mappings" ("luma_product_id");

-- ── 5. external_inventory_snapshots ───────────────────────────────
CREATE TABLE IF NOT EXISTS "external_inventory_snapshots" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "external_system_id"   uuid NOT NULL REFERENCES "external_systems"("id") ON DELETE CASCADE,
  "external_item_id"     text NOT NULL,
  "item_code"            text,
  "item_name"            text,
  "quantity_on_hand"     numeric(20,6),
  "quantity_available"   numeric(20,6),
  "unit_of_measure"      text,
  "warehouse_name"       text,
  "snapshot_at"          timestamptz NOT NULL DEFAULT now(),
  "payload"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "external_inventory_snapshots_system_item_idx"
  ON "external_inventory_snapshots" ("external_system_id", "external_item_id", "snapshot_at");
CREATE INDEX IF NOT EXISTS "external_inventory_snapshots_at_idx"
  ON "external_inventory_snapshots" ("snapshot_at");

-- ─────────────────────────────────────────────────────────────────────
-- Backfill items from existing master tables.
-- Item codes are prefixed by source kind for global uniqueness
-- without colliding on shared SKUs across the three source tables.
--   TT:<sku|id>    → tablet_types
--   PM:<sku>       → packaging_materials
--   PROD:<sku>     → products
-- Idempotent — re-running a second time skips already-seeded rows
-- thanks to the UNIQUE (source_kind, source_id) constraint.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO "items"
  ("item_code","name","item_category","default_unit_of_measure","source_kind","source_id","is_active")
SELECT
  'TT:' || COALESCE(NULLIF(tt.sku,''), tt.id::text)            AS item_code,
  tt.name                                                       AS name,
  'RAW_MATERIAL'                                                AS item_category,
  'tablets'                                                     AS default_unit_of_measure,
  'TABLET_TYPE'                                                 AS source_kind,
  tt.id                                                         AS source_id,
  tt.is_active                                                  AS is_active
FROM "tablet_types" tt
ON CONFLICT ("source_kind","source_id") DO NOTHING;

INSERT INTO "items"
  ("item_code","name","item_category","default_unit_of_measure","source_kind","source_id","is_active")
SELECT
  'PM:' || COALESCE(NULLIF(pm.sku,''), pm.id::text)            AS item_code,
  pm.name                                                       AS name,
  'PACKAGING_MATERIAL'                                          AS item_category,
  pm.uom                                                        AS default_unit_of_measure,
  'PACKAGING_MATERIAL'                                          AS source_kind,
  pm.id                                                         AS source_id,
  pm.is_active                                                  AS is_active
FROM "packaging_materials" pm
ON CONFLICT ("source_kind","source_id") DO NOTHING;

-- For products, derive the default UOM from product.kind. This is
-- a backwards-compatibility convenience only; admins can override
-- per item in /settings/product-structure once H.x0.5 ships.
INSERT INTO "items"
  ("item_code","name","item_category","default_unit_of_measure","source_kind","source_id","is_active")
SELECT
  'PROD:' || COALESCE(NULLIF(p.sku,''), p.id::text)             AS item_code,
  p.name                                                        AS name,
  'FINISHED_GOOD'                                               AS item_category,
  CASE p.kind::text
    WHEN 'CARD'    THEN 'cards'
    WHEN 'BOTTLE'  THEN 'bottles'
    WHEN 'VARIETY' THEN 'units'
    ELSE 'units'
  END                                                            AS default_unit_of_measure,
  'PRODUCT'                                                      AS source_kind,
  p.id                                                           AS source_id,
  p.is_active                                                    AS is_active
FROM "products" p
ON CONFLICT ("source_kind","source_id") DO NOTHING;
