-- Workflow metrics schema. Splits cleanly from 0002 (enum-add) so
-- both deploys stay atomic per the drizzle-alter-type-gotcha.

-- ── read_bag_state: pause/operator tracking ─────────────────────────────────
ALTER TABLE "read_bag_state"
  ADD COLUMN IF NOT EXISTS "is_paused" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "paused_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "paused_seconds_accum" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "current_operator_code" text;

-- ── inventory_bags: vendor barcode (already-printed manufacturer label) ────
ALTER TABLE "inventory_bags"
  ADD COLUMN IF NOT EXISTS "vendor_barcode" text;
CREATE INDEX IF NOT EXISTS "inventory_bags_vendor_barcode_idx"
  ON "inventory_bags"("vendor_barcode")
  WHERE "vendor_barcode" IS NOT NULL;

-- ── read_bag_metrics: one row per finalized bag, every stat snapshotted ────
-- Computed at BAG_FINALIZED time by the projector walking the bag's
-- workflow_events. All seconds, all counts. Reports / analytics page
-- query straight off this table — no on-the-fly aggregation over
-- workflow_events.
CREATE TABLE IF NOT EXISTS "read_bag_metrics" (
  "workflow_bag_id" uuid PRIMARY KEY REFERENCES "workflow_bags"("id") ON DELETE CASCADE,
  "product_id" uuid REFERENCES "products"("id"),
  "started_at" timestamptz NOT NULL,
  "finalized_at" timestamptz NOT NULL,
  "total_seconds" integer NOT NULL,
  "paused_seconds" integer NOT NULL DEFAULT 0,
  "active_seconds" integer NOT NULL,
  "blister_seconds" integer,
  "sealing_seconds" integer,
  "packaging_seconds" integer,
  "bottle_handpack_seconds" integer,
  "bottle_cap_seal_seconds" integer,
  "bottle_sticker_seconds" integer,
  "staging_1_seconds" integer,
  "staging_2_seconds" integer,
  "master_cases" integer NOT NULL DEFAULT 0,
  "displays_made" integer NOT NULL DEFAULT 0,
  "loose_cards" integer NOT NULL DEFAULT 0,
  "damaged_packaging" integer NOT NULL DEFAULT 0,
  "ripped_cards" integer NOT NULL DEFAULT 0,
  "input_pill_count" integer,
  "units_yielded" integer NOT NULL DEFAULT 0,
  "yield_pct" numeric(6,3),
  "operator_codes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "machine_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[]
);
CREATE INDEX IF NOT EXISTS "read_bag_metrics_finalized_idx"
  ON "read_bag_metrics"("finalized_at" DESC);
CREATE INDEX IF NOT EXISTS "read_bag_metrics_product_idx"
  ON "read_bag_metrics"("product_id");

-- ── read_operator_daily: per-(day, operator) throughput rollup ─────────────
CREATE TABLE IF NOT EXISTS "read_operator_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "day" date NOT NULL,
  "operator_code" text NOT NULL,
  "bags_finalized" integer NOT NULL DEFAULT 0,
  "active_seconds_total" integer NOT NULL DEFAULT 0,
  "damage_count_total" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "read_operator_daily_day_operator_unique"
  ON "read_operator_daily"("day", "operator_code");
CREATE INDEX IF NOT EXISTS "read_operator_daily_day_idx"
  ON "read_operator_daily"("day" DESC);
