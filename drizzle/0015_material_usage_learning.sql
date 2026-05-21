-- Phase H.x3 — Learned material usage standards.
--
-- Adds read_material_usage_learning: an aggregate read model the
-- material-learning helper writes per (product, material, role,
-- machine) bucket. Source samples are PVC/foil rolls that have been
-- weighed back, joined to the BLISTER_COMPLETE counter deltas during
-- the mount window.
--
-- Configured standards (blister_material_standards) remain
-- authoritative; the learned standard is consulted only when no
-- configured standard exists.
--
-- Append-only is NOT used — the rebuilder TRUNCATEs and re-INSERTs
-- the table the same way other read models do.

CREATE TABLE IF NOT EXISTS "read_material_usage_learning" (
  "id"                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- product_id is nullable: when we have multiple samples across
  -- products on the same material+machine, a NULL row aggregates
  -- the cross-product fallback that callers can use as last resort.
  "product_id"                      uuid REFERENCES "products"("id") ON DELETE CASCADE,
  "route_id"                        uuid REFERENCES "production_routes"("id") ON DELETE SET NULL,
  "packaging_material_id"           uuid NOT NULL REFERENCES "packaging_materials"("id") ON DELETE CASCADE,
  -- "PVC" | "FOIL". Free-text so a future role doesn't need a migration.
  "material_role"                   text NOT NULL,
  -- machine_id is nullable: per-machine learning when present, or
  -- cross-machine fallback when null.
  "machine_id"                      uuid REFERENCES "machines"("id") ON DELETE SET NULL,
  "sample_count"                    integer NOT NULL DEFAULT 0,
  "total_blisters_produced"         bigint,
  "total_actual_weight_used_grams"  integer,
  "avg_weight_per_blister"          numeric(10, 4),
  "median_weight_per_blister"       numeric(10, 4),
  "p90_weight_per_blister"          numeric(10, 4),
  "last_sample_at"                  timestamptz,
  -- HIGH ≥ 5 weighed-back samples; MEDIUM 2–4; LOW = 1; MISSING = 0.
  "confidence"                      text NOT NULL DEFAULT 'MISSING',
  "missing_inputs"                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source"                          text NOT NULL DEFAULT 'LEARNED',
  "updated_at"                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "read_material_usage_learning_lookup_idx"
  ON "read_material_usage_learning"
  ("packaging_material_id", "material_role", "product_id", "machine_id");

CREATE INDEX IF NOT EXISTS "read_material_usage_learning_product_idx"
  ON "read_material_usage_learning" ("product_id", "material_role");
