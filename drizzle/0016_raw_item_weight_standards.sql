-- Phase H.x3.5 — Raw-item unit-weight standards.
--
-- Per-tablet-type expected unit weight in grams. Used to compute an
-- internal "our_estimated_count" from received_net_weight when the
-- vendor declared count is missing or suspect.
--
-- Empty by default. Production code that needs the standard but
-- finds none must surface "Unit weight standard missing" — it must
-- never invent a unit weight.
--
-- Effective-from / to mirrors the standards model used by
-- station_standards and blister_material_standards. Multiple rows
-- for the same tablet_type are allowed (history); the metric layer
-- picks the row whose effective window covers the receipt date.

CREATE TABLE IF NOT EXISTS "raw_item_weight_standards" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tablet_type_id"        uuid NOT NULL REFERENCES "tablet_types"("id") ON DELETE CASCADE,
  -- Free-text source label so the admin can record where the number
  -- came from: "vendor spec", "weighed from PO X", "calibrated from
  -- finished output of Product Y", etc. Empty string allowed.
  "sample_source"         text,
  "standard_unit_weight"  numeric(12, 6) NOT NULL,
  "weight_unit"           text NOT NULL DEFAULT 'g',
  "effective_from"        date NOT NULL DEFAULT CURRENT_DATE,
  "effective_to"          date,
  "is_active"             boolean NOT NULL DEFAULT true,
  -- HIGH ≥ 5 verified samples; MEDIUM 2–4; LOW = 1 vendor declaration;
  -- MISSING when set but later invalidated. Free text — the helper
  -- coerces to the canonical Confidence ladder.
  "confidence"            text NOT NULL DEFAULT 'MEDIUM',
  "notes"                 text,
  "created_by_id"         uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "raw_item_weight_standards_positive" CHECK ("standard_unit_weight" > 0)
);

CREATE INDEX IF NOT EXISTS "raw_item_weight_standards_lookup_idx"
  ON "raw_item_weight_standards" ("tablet_type_id", "effective_from", "is_active");
