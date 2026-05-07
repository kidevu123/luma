-- Phase H: packaging-material inventory + PVC/foil roll tracking.
-- Builds on existing packaging_materials / packaging_lots /
-- product_packaging_specs. Adds:
--   • new enums: material_lot_status, material_event_type
--   • roll-tracking columns on packaging_lots
--   • waste-allowance column on product_packaging_specs
--   • blister_material_standards (PVC/foil consumption standards)
--   • material_inventory_events (event log for material movements)
--   • 3 read-model tables for projection state
--
-- All additive. NO data backfill. Empty until the admin UI populates
-- material standards + receiving creates lots.

-- ─── New enums ───────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='material_lot_status') THEN
    CREATE TYPE material_lot_status AS ENUM (
      'AVAILABLE','IN_USE','DEPLETED','HELD','SCRAPPED','ADJUSTED'
    );
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='material_event_type') THEN
    CREATE TYPE material_event_type AS ENUM (
      'MATERIAL_RECEIVED',
      'MATERIAL_ISSUED',
      'MATERIAL_RETURNED',
      'MATERIAL_CONSUMED_ESTIMATED',
      'MATERIAL_CONSUMED_ACTUAL',
      'MATERIAL_ADJUSTED',
      'ROLL_MOUNTED',
      'ROLL_UNMOUNTED',
      'ROLL_WEIGHED',
      'ROLL_DEPLETED',
      'MATERIAL_SCRAPPED'
    );
  END IF;
END $$;
--> statement-breakpoint

-- ─── packaging_lots roll fields ──────────────────────────────────

ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS status material_lot_status NOT NULL DEFAULT 'AVAILABLE';
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS roll_number text;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS gross_weight_grams integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS tare_weight_grams integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS net_weight_grams integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS current_weight_grams_estimate integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS weight_unit text DEFAULT 'g';
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS width_mm integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS thickness_microns integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS material_spec text;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS core_weight_grams integer;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS supplier text;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS location text;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS scan_token text;
--> statement-breakpoint
ALTER TABLE packaging_lots ADD COLUMN IF NOT EXISTS confidence text DEFAULT 'HIGH';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS packaging_lots_roll_number_unique
  ON packaging_lots (roll_number) WHERE roll_number IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS packaging_lots_status_idx ON packaging_lots (status);
--> statement-breakpoint

-- ─── product_packaging_specs waste allowance ─────────────────────

ALTER TABLE product_packaging_specs ADD COLUMN IF NOT EXISTS waste_allowance_percent numeric(5,2) DEFAULT 0;
--> statement-breakpoint

-- ─── blister_material_standards ──────────────────────────────────

CREATE TABLE IF NOT EXISTS blister_material_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  packaging_material_id uuid NOT NULL REFERENCES packaging_materials(id) ON DELETE CASCADE,
  material_role text NOT NULL,           -- 'PVC' | 'FOIL'
  expected_grams_per_blister numeric(10,4),
  expected_blisters_per_kg numeric(10,3),
  setup_waste_grams integer NOT NULL DEFAULT 0,
  changeover_waste_grams integer NOT NULL DEFAULT 0,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE blister_material_standards
  ADD CONSTRAINT blister_material_standards_role_check
  CHECK (material_role IN ('PVC','FOIL'));
--> statement-breakpoint
ALTER TABLE blister_material_standards
  ADD CONSTRAINT blister_material_standards_metric_check
  CHECK (expected_grams_per_blister IS NOT NULL OR expected_blisters_per_kg IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS blister_material_standards_product_idx
  ON blister_material_standards (product_id, material_role);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS blister_material_standards_active_idx
  ON blister_material_standards (is_active);
--> statement-breakpoint

-- ─── material_inventory_events ───────────────────────────────────

CREATE TABLE IF NOT EXISTS material_inventory_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type material_event_type NOT NULL,
  packaging_material_id uuid NOT NULL REFERENCES packaging_materials(id) ON DELETE CASCADE,
  packaging_lot_id uuid REFERENCES packaging_lots(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  workflow_bag_id uuid REFERENCES workflow_bags(id) ON DELETE SET NULL,
  machine_id uuid REFERENCES machines(id) ON DELETE SET NULL,
  station_id uuid REFERENCES stations(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- quantity_units = count for count-based items; quantity_grams =
  -- weight delta for roll-based events. Either may be null when the
  -- event is, for example, ROLL_MOUNTED (no qty change yet).
  quantity_units integer,
  quantity_grams integer,
  unit_of_measure text,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'system',
  client_event_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS material_events_lot_idx ON material_inventory_events (packaging_lot_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS material_events_material_idx ON material_inventory_events (packaging_material_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS material_events_bag_idx ON material_inventory_events (workflow_bag_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS material_events_machine_idx ON material_inventory_events (machine_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS material_events_type_occurred_idx ON material_inventory_events (event_type, occurred_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS material_events_idempotency
  ON material_inventory_events (packaging_lot_id, event_type, client_event_id)
  WHERE client_event_id IS NOT NULL;
--> statement-breakpoint

-- ─── Read models ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS read_material_lot_state (
  packaging_lot_id uuid PRIMARY KEY REFERENCES packaging_lots(id) ON DELETE CASCADE,
  packaging_material_id uuid NOT NULL,
  material_kind text NOT NULL,
  lot_number text,
  roll_number text,
  status material_lot_status NOT NULL,
  initial_quantity integer,
  current_quantity_estimate integer,
  initial_weight_grams integer,
  current_weight_grams_estimate integer,
  unit_of_measure text NOT NULL,
  consumed_estimated integer NOT NULL DEFAULT 0,
  consumed_actual integer,
  adjusted_quantity integer NOT NULL DEFAULT 0,
  last_event_at timestamp with time zone,
  confidence text NOT NULL DEFAULT 'HIGH',
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS read_material_lot_state_status_idx
  ON read_material_lot_state (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS read_material_lot_state_material_idx
  ON read_material_lot_state (packaging_material_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS read_material_consumption_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL,
  packaging_material_id uuid NOT NULL REFERENCES packaging_materials(id) ON DELETE CASCADE,
  packaging_lot_id uuid REFERENCES packaging_lots(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  machine_id uuid REFERENCES machines(id) ON DELETE SET NULL,
  station_id uuid REFERENCES stations(id) ON DELETE SET NULL,
  estimated_consumed_units integer NOT NULL DEFAULT 0,
  actual_consumed_units integer,
  estimated_consumed_grams integer NOT NULL DEFAULT 0,
  actual_consumed_grams integer,
  unit_of_measure text NOT NULL,
  variance_qty integer,
  variance_pct numeric(7,3),
  confidence text NOT NULL DEFAULT 'MEDIUM',
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS read_material_consumption_daily_unique
  ON read_material_consumption_daily (day, packaging_material_id, packaging_lot_id, product_id, machine_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS read_material_consumption_daily_day_idx
  ON read_material_consumption_daily (day);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS read_roll_usage (
  packaging_lot_id uuid PRIMARY KEY REFERENCES packaging_lots(id) ON DELETE CASCADE,
  roll_number text,
  material_kind text NOT NULL,
  material_role text,                    -- 'PVC' | 'FOIL' | NULL
  machine_id uuid REFERENCES machines(id) ON DELETE SET NULL,
  mounted_at timestamp with time zone,
  unmounted_at timestamp with time zone,
  starting_weight_grams integer,
  ending_weight_grams integer,
  expected_used_grams integer,
  actual_used_grams integer,
  variance_grams integer,
  variance_pct numeric(7,3),
  blisters_produced integer,
  projected_remaining_grams integer,
  projected_blisters_remaining integer,
  confidence text NOT NULL DEFAULT 'MEDIUM',
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS read_roll_usage_machine_idx
  ON read_roll_usage (machine_id);
