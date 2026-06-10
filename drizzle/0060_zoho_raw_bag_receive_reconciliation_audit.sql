-- ZOHO-RAW-BAG-RECEIVE-2 — reconciliation audit fields + Zoho PR lookup index.

ALTER TABLE zoho_raw_bag_receives
  ADD COLUMN IF NOT EXISTS zoho_receive_number text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_by uuid,
  ADD COLUMN IF NOT EXISTS reconciliation_note text;

CREATE INDEX IF NOT EXISTS zoho_raw_bag_receives_zoho_pr_idx
  ON zoho_raw_bag_receives(zoho_purchase_receive_id);

CREATE UNIQUE INDEX IF NOT EXISTS zoho_raw_bag_receives_zoho_pr_unique
  ON zoho_raw_bag_receives(zoho_purchase_receive_id)
  WHERE zoho_purchase_receive_id IS NOT NULL;
