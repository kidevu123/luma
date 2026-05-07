-- Phase H.x0 — Route / Operation Compatibility Layer.
--
-- Adds 7 tables that lift the implicit "CARD vs BOTTLE" routing into
-- data, and seeds the two existing routes plus a STICKER_ONLY route
-- so future products can be configured without enum migrations.
--
-- This migration does NOT remove any existing enum, does NOT change
-- the projector, and does NOT alter floor behavior. It is purely
-- additive. Read-side code can begin reading from these tables; the
-- write side and the floor stay on legacy enums until a follow-up
-- phase migrates them.
--
-- See docs/PRODUCT_ONBOARDING_AND_EXTENSIBILITY.md.

-- ── 1. production_routes ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "production_routes" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "production_routes_code_unique" UNIQUE ("code")
);

-- ── 2. operation_types ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "operation_types" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"               text NOT NULL,
  "name"               text NOT NULL,
  "description"        text,
  "requires_timer"     boolean NOT NULL DEFAULT false,
  "requires_counter"   boolean NOT NULL DEFAULT false,
  "requires_machine"   boolean NOT NULL DEFAULT false,
  "requires_materials" boolean NOT NULL DEFAULT false,
  "output_unit"        text,
  "is_active"          boolean NOT NULL DEFAULT true,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "operation_types_code_unique" UNIQUE ("code")
);

-- ── 3. route_operations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "route_operations" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "route_id"             uuid NOT NULL REFERENCES "production_routes"("id") ON DELETE CASCADE,
  "operation_type_id"    uuid NOT NULL REFERENCES "operation_types"("id") ON DELETE RESTRICT,
  "sequence"             integer NOT NULL,
  "stage_key"            text NOT NULL,
  "next_stage_key"       text,
  "rework_stage_key"     text,
  "allowed_station_kind" text,
  "allowed_machine_kind" text,
  "requires_scan"        boolean NOT NULL DEFAULT true,
  "requires_counter"     boolean NOT NULL DEFAULT false,
  "requires_timer"       boolean NOT NULL DEFAULT false,
  "output_unit"          text,
  "is_active"            boolean NOT NULL DEFAULT true,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "route_operations_seq_unique" UNIQUE ("route_id", "sequence")
);
CREATE INDEX IF NOT EXISTS "route_operations_route_idx"      ON "route_operations" ("route_id", "sequence");
CREATE INDEX IF NOT EXISTS "route_operations_stage_idx"      ON "route_operations" ("route_id", "stage_key");
CREATE INDEX IF NOT EXISTS "route_operations_operation_idx"  ON "route_operations" ("operation_type_id");

-- ── 4. product_route_assignments ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "product_route_assignments" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"     uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "route_id"       uuid NOT NULL REFERENCES "production_routes"("id") ON DELETE RESTRICT,
  "is_default"     boolean NOT NULL DEFAULT true,
  "is_active"      boolean NOT NULL DEFAULT true,
  "effective_from" date NOT NULL DEFAULT CURRENT_DATE,
  "effective_to"   date,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "product_route_assignments_product_idx" ON "product_route_assignments" ("product_id", "is_active");
CREATE INDEX IF NOT EXISTS "product_route_assignments_route_idx"   ON "product_route_assignments" ("route_id");
-- Only one default-active per product at a time. Partial unique.
CREATE UNIQUE INDEX IF NOT EXISTS "product_route_assignments_default_unique"
  ON "product_route_assignments" ("product_id")
  WHERE "is_default" = true AND "is_active" = true;

-- ── 5. route_station_permissions ───────────────────────────────────
-- At least one of (station_id, machine_id, station_kind, machine_kind)
-- must be non-null. Enforced by check.
CREATE TABLE IF NOT EXISTS "route_station_permissions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "route_operation_id" uuid NOT NULL REFERENCES "route_operations"("id") ON DELETE CASCADE,
  "station_id"        uuid REFERENCES "stations"("id") ON DELETE CASCADE,
  "machine_id"        uuid REFERENCES "machines"("id") ON DELETE CASCADE,
  "station_kind"      text,
  "machine_kind"      text,
  "is_active"         boolean NOT NULL DEFAULT true,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "route_station_permissions_target_required" CHECK (
    "station_id"   IS NOT NULL
    OR "machine_id"   IS NOT NULL
    OR "station_kind" IS NOT NULL
    OR "machine_kind" IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS "route_station_permissions_op_idx"
  ON "route_station_permissions" ("route_operation_id", "is_active");

-- ── 6. quality_checks ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quality_checks" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "check_type"  text NOT NULL,
  "is_required" boolean NOT NULL DEFAULT false,
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "quality_checks_code_unique" UNIQUE ("code")
);

-- ── 7. route_quality_checks ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "route_quality_checks" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "route_operation_id" uuid NOT NULL REFERENCES "route_operations"("id") ON DELETE CASCADE,
  "quality_check_id"   uuid NOT NULL REFERENCES "quality_checks"("id") ON DELETE RESTRICT,
  "is_required"        boolean NOT NULL DEFAULT false,
  "sequence"           integer NOT NULL DEFAULT 1,
  "is_active"          boolean NOT NULL DEFAULT true,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "route_quality_checks_unique"
    UNIQUE ("route_operation_id", "quality_check_id")
);
CREATE INDEX IF NOT EXISTS "route_quality_checks_op_idx"
  ON "route_quality_checks" ("route_operation_id", "sequence");

-- ─────────────────────────────────────────────────────────────────────
-- Seed: routes, operation types, route operations.
-- Idempotent (ON CONFLICT). Re-running this migration after a manual
-- INSERT does not duplicate or overwrite.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO "production_routes" ("code","name","description") VALUES
  ('CARD_BLISTER',   'Card / blister', 'Tablets blistered, sealed onto card, packaged into displays/cases.'),
  ('BOTTLE',         'Bottle',         'Tablets hand-packed into bottles, capped, sticker-labeled, induction-sealed.'),
  ('STICKER_ONLY',   'Sticker-only',   'Pre-filled bottles or pouches that only need sticker application.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "operation_types"
  ("code","name","description","requires_timer","requires_counter","requires_machine","requires_materials","output_unit") VALUES
  ('RECEIVING',            'Receiving',             'Bag intake / vendor verification at run-start.',          false, false, false, false, NULL),
  ('BLISTER',              'Blistering',            'Form blister cards and seal lid foil.',                   true,  true,  true,  true,  'cards'),
  ('POST_BLISTER_STAGING', 'Post-blister staging',  'Hold for sealing; ages at this stage are a backup signal.', false, false, false, false, NULL),
  ('HEAT_SEAL',            'Heat seal',             'Seal blister card to backer.',                            true,  true,  true,  true,  'cards'),
  ('POST_SEAL_STAGING',    'Post-seal staging',     'Hold for packaging.',                                     false, false, false, false, NULL),
  ('PACKAGING',            'Packaging',             'Pack finished units into displays / cases.',              true,  true,  false, true,  'cases'),
  ('BOTTLE_FILL',          'Bottle fill',           'Hand-pack tablets into bottles.',                         true,  true,  true,  true,  'bottles'),
  ('STICKERING',           'Stickering',            'Apply finished-good sticker to bottle.',                  false, true,  true,  true,  'bottles'),
  ('INDUCTION_SEAL',       'Induction seal',        'Apply induction seal to bottle.',                         false, true,  true,  true,  'bottles'),
  ('QA_HOLD',              'QA hold',               'Quarantine pending QA release.',                          false, false, false, false, NULL),
  ('FINISHED_GOODS',       'Finished goods',        'Released to inventory.',                                  false, false, false, false, 'lots')
ON CONFLICT ("code") DO NOTHING;

-- Seed CARD_BLISTER route operations.
INSERT INTO "route_operations"
  ("route_id","operation_type_id","sequence","stage_key","next_stage_key","allowed_station_kind","allowed_machine_kind","requires_scan","requires_counter","requires_timer","output_unit")
SELECT r.id, o.id, seq, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit
FROM "production_routes" r
CROSS JOIN LATERAL (VALUES
  (1, 'RECEIVING',            'RECEIVING_QUEUE',          'BLISTER_QUEUE',           NULL,             NULL,             true,  false, false, NULL::text),
  (2, 'BLISTER',               'BLISTER_QUEUE',            'POST_BLISTER_STAGING',    'BLISTER',        'BLISTER',        true,  true,  true,  'cards'),
  (3, 'POST_BLISTER_STAGING',  'POST_BLISTER_STAGING',     'SEALING_QUEUE',           NULL,             NULL,             false, false, false, NULL::text),
  (4, 'HEAT_SEAL',             'SEALING_QUEUE',            'POST_SEAL_STAGING',       'SEALING',        'SEALING',        true,  true,  true,  'cards'),
  (5, 'POST_SEAL_STAGING',     'POST_SEAL_STAGING',        'PACKAGING_QUEUE',         NULL,             NULL,             false, false, false, NULL::text),
  (6, 'PACKAGING',             'PACKAGING_QUEUE',          'FINISHED_GOODS_QUEUE',    'PACKAGING',      'PACKAGING',      true,  true,  true,  'cases'),
  (7, 'FINISHED_GOODS',        'FINISHED_GOODS_QUEUE',     NULL,                       NULL,             NULL,             false, false, false, 'lots')
) AS d(seq, op_code, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit)
JOIN "operation_types" o ON o.code = d.op_code
WHERE r.code = 'CARD_BLISTER'
ON CONFLICT ("route_id","sequence") DO NOTHING;

-- Seed BOTTLE route operations.
INSERT INTO "route_operations"
  ("route_id","operation_type_id","sequence","stage_key","next_stage_key","allowed_station_kind","allowed_machine_kind","requires_scan","requires_counter","requires_timer","output_unit")
SELECT r.id, o.id, seq, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit
FROM "production_routes" r
CROSS JOIN LATERAL (VALUES
  (1, 'RECEIVING',       'RECEIVING_QUEUE',          'BOTTLE_FILL_QUEUE',        NULL,                NULL,              true,  false, false, NULL::text),
  (2, 'BOTTLE_FILL',     'BOTTLE_FILL_QUEUE',        'BOTTLE_STICKER_QUEUE',     'BOTTLE_HANDPACK',   'BOTTLE_HANDPACK', true,  true,  true,  'bottles'),
  (3, 'STICKERING',      'BOTTLE_STICKER_QUEUE',     'BOTTLE_INDUCTION_QUEUE',   'BOTTLE_STICKER',    'BOTTLE_STICKER',  true,  true,  false, 'bottles'),
  (4, 'INDUCTION_SEAL',  'BOTTLE_INDUCTION_QUEUE',   'PACKAGING_QUEUE',          'BOTTLE_CAP_SEAL',   'BOTTLE_CAP_SEAL', true,  true,  false, 'bottles'),
  (5, 'PACKAGING',       'PACKAGING_QUEUE',          'FINISHED_GOODS_QUEUE',     'PACKAGING',         'PACKAGING',       true,  true,  true,  'cases'),
  (6, 'FINISHED_GOODS',  'FINISHED_GOODS_QUEUE',     NULL,                        NULL,                NULL,              false, false, false, 'lots')
) AS d(seq, op_code, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit)
JOIN "operation_types" o ON o.code = d.op_code
WHERE r.code = 'BOTTLE'
ON CONFLICT ("route_id","sequence") DO NOTHING;

-- Seed STICKER_ONLY route operations.
INSERT INTO "route_operations"
  ("route_id","operation_type_id","sequence","stage_key","next_stage_key","allowed_station_kind","allowed_machine_kind","requires_scan","requires_counter","requires_timer","output_unit")
SELECT r.id, o.id, seq, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit
FROM "production_routes" r
CROSS JOIN LATERAL (VALUES
  (1, 'RECEIVING',       'RECEIVING_QUEUE',         'BOTTLE_STICKER_QUEUE',  NULL,               NULL,             true,  false, false, NULL::text),
  (2, 'STICKERING',      'BOTTLE_STICKER_QUEUE',    'PACKAGING_QUEUE',       'BOTTLE_STICKER',   'BOTTLE_STICKER', true,  true,  false, 'bottles'),
  (3, 'PACKAGING',       'PACKAGING_QUEUE',         'FINISHED_GOODS_QUEUE',  'PACKAGING',        'PACKAGING',      true,  true,  true,  'cases'),
  (4, 'FINISHED_GOODS',  'FINISHED_GOODS_QUEUE',    NULL,                     NULL,               NULL,             false, false, false, 'lots')
) AS d(seq, op_code, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit)
JOIN "operation_types" o ON o.code = d.op_code
WHERE r.code = 'STICKER_ONLY'
ON CONFLICT ("route_id","sequence") DO NOTHING;
