-- ZOHO-PRODUCTION-OUTPUT-V1206 — persisted op metadata + source allocation linkage.

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS product_family text;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS finished_sku text;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS variety_run_id uuid REFERENCES variety_runs(id) ON DELETE SET NULL;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS zoho_receive_id text;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS zoho_bundle_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS human_review_required boolean NOT NULL DEFAULT false;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS partial_failure boolean NOT NULL DEFAULT false;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS preview_status text;

ALTER TABLE zoho_production_output_ops
  ADD COLUMN IF NOT EXISTS commit_status text;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_family text;

ALTER TABLE tablet_types
  ADD COLUMN IF NOT EXISTS product_family text;

CREATE TABLE IF NOT EXISTS zoho_production_output_source_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_production_output_op_id uuid NOT NULL
    REFERENCES zoho_production_output_ops(id) ON DELETE CASCADE,
  zoho_component_item_id text NOT NULL,
  luma_inventory_bag_id uuid NOT NULL
    REFERENCES inventory_bags(id) ON DELETE RESTRICT,
  human_lot_number text NOT NULL,
  component_role text,
  quantity_allocated numeric(20, 6) NOT NULL,
  allocation_session_id uuid
    REFERENCES raw_bag_allocation_sessions(id) ON DELETE SET NULL,
  workflow_bag_id uuid
    REFERENCES workflow_bags(id) ON DELETE SET NULL,
  variety_run_id uuid
    REFERENCES variety_runs(id) ON DELETE SET NULL,
  parent_scan_token text,
  manufacture_date date,
  expiry_date date,
  zoho_batch_id text,
  batch_resolution_status text NOT NULL DEFAULT 'UNRESOLVED',
  out_quantity integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zoho_prod_output_source_op_idx
  ON zoho_production_output_source_allocations(zoho_production_output_op_id);

CREATE INDEX IF NOT EXISTS zoho_prod_output_source_bag_idx
  ON zoho_production_output_source_allocations(luma_inventory_bag_id);

CREATE INDEX IF NOT EXISTS zoho_prod_output_source_session_idx
  ON zoho_production_output_source_allocations(allocation_session_id)
  WHERE allocation_session_id IS NOT NULL;
