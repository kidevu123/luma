-- PT-6C — 8-bucket reconciliation read model.
--
-- Additive table built on top of the PT-6B pure helpers. Coexists
-- with the legacy `read_material_reconciliation` (per-bag, single-
-- bucket) until PT-6D switches the UI; v1 is NOT touched here.
--
-- Each row captures one (scope_type, scope_id) reconciliation
-- snapshot — typically per packaging_lot, occasionally per roll
-- (lots whose material_kind is a roll), per raw bag (tablet line),
-- per material item (rolled up), or per PO.
--
-- All bucket values are stored both as their typed columns AND as
-- a JSONB blob (`source_snapshot`) so the UI can render the full
-- per-bucket detail (source / explanation / missingInputs) without
-- fanning out the column count past readability. The typed columns
-- support indexed filtering and confidence-banded queries.

CREATE TABLE IF NOT EXISTS "read_material_reconciliation_v2" (
  "id"                                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope_type"                            text NOT NULL,
  "scope_id"                              uuid NOT NULL,
  "material_item_id"                      uuid REFERENCES "packaging_materials"("id") ON DELETE CASCADE,
  "packaging_lot_id"                      uuid REFERENCES "packaging_lots"("id") ON DELETE CASCADE,
  "raw_bag_id"                            uuid REFERENCES "inventory_bags"("id") ON DELETE CASCADE,
  "po_id"                                 uuid REFERENCES "purchase_orders"("id") ON DELETE SET NULL,
  "product_id"                            uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "unit_of_measure"                       text NOT NULL,

  "declared_value"                        numeric(20, 6),
  "declared_confidence"                   text NOT NULL,
  "declared_source"                       text,
  "declared_missing_inputs"               jsonb NOT NULL DEFAULT '[]'::jsonb,

  "counted_value"                         numeric(20, 6),
  "counted_confidence"                    text NOT NULL,
  "counted_source"                        text,
  "counted_missing_inputs"                jsonb NOT NULL DEFAULT '[]'::jsonb,

  "accepted_value"                        numeric(20, 6),
  "accepted_confidence"                   text NOT NULL,
  "accepted_source"                       text,
  "accepted_missing_inputs"               jsonb NOT NULL DEFAULT '[]'::jsonb,

  "consumed_estimated_value"              numeric(20, 6),
  "consumed_estimated_confidence"         text NOT NULL,
  "consumed_estimated_source"             text,
  "consumed_estimated_missing_inputs"     jsonb NOT NULL DEFAULT '[]'::jsonb,

  "consumed_actual_value"                 numeric(20, 6),
  "consumed_actual_confidence"            text NOT NULL,
  "consumed_actual_source"                text,
  "consumed_actual_missing_inputs"        jsonb NOT NULL DEFAULT '[]'::jsonb,

  "scrapped_or_damaged_value"             numeric(20, 6),
  "scrapped_or_damaged_confidence"        text NOT NULL,
  "scrapped_or_damaged_source"            text,
  "scrapped_or_damaged_missing_inputs"    jsonb NOT NULL DEFAULT '[]'::jsonb,

  "on_hand_value"                         numeric(20, 6),
  "on_hand_confidence"                    text NOT NULL,
  "on_hand_source"                        text,
  "on_hand_missing_inputs"                jsonb NOT NULL DEFAULT '[]'::jsonb,

  "receipt_variance_value"                numeric(20, 6),
  "receipt_variance_confidence"           text NOT NULL,
  "receipt_variance_severity"             text NOT NULL,

  "cycle_count_variance_value"            numeric(20, 6),
  "cycle_count_variance_confidence"       text NOT NULL,
  "cycle_count_variance_severity"         text NOT NULL,

  "consumption_variance_value"            numeric(20, 6),
  "consumption_variance_confidence"       text NOT NULL,
  "consumption_variance_severity"         text NOT NULL,

  "unknown_variance_value"                numeric(20, 6),
  "unknown_variance_confidence"           text NOT NULL,
  "unknown_variance_severity"             text NOT NULL,

  "overall_confidence"                    text NOT NULL,
  "warnings"                              jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_snapshot"                       jsonb NOT NULL DEFAULT '{}'::jsonb,

  "calculated_at"                         timestamptz NOT NULL DEFAULT now(),
  "created_at"                            timestamptz NOT NULL DEFAULT now(),
  "updated_at"                            timestamptz NOT NULL DEFAULT now(),

  -- Allowed scope_type values mirror the input-assembler's discriminators.
  CONSTRAINT "read_material_reconciliation_v2_scope_type_chk"
    CHECK ("scope_type" IN ('PACKAGING_LOT','RAW_BAG','ROLL','MATERIAL_ITEM','PO')),
  -- Confidence bands match lib/production/types' confidence ladder.
  CONSTRAINT "read_material_reconciliation_v2_overall_chk"
    CHECK ("overall_confidence" IN ('HIGH','MEDIUM','LOW','MISSING'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "read_material_reconciliation_v2_scope_unique"
  ON "read_material_reconciliation_v2" ("scope_type", "scope_id");

CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_material_idx"
  ON "read_material_reconciliation_v2" ("material_item_id")
  WHERE "material_item_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_packaging_lot_idx"
  ON "read_material_reconciliation_v2" ("packaging_lot_id")
  WHERE "packaging_lot_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_raw_bag_idx"
  ON "read_material_reconciliation_v2" ("raw_bag_id")
  WHERE "raw_bag_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_po_idx"
  ON "read_material_reconciliation_v2" ("po_id")
  WHERE "po_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_overall_idx"
  ON "read_material_reconciliation_v2" ("overall_confidence");
