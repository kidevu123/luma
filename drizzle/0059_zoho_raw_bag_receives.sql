-- ZOHO-RAW-BAG-RECEIVE-1 — durable per-bag Zoho purchase receive linkage.

CREATE TABLE IF NOT EXISTS zoho_raw_bag_receives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_bag_id uuid NOT NULL REFERENCES inventory_bags(id) ON DELETE RESTRICT,
  receive_id uuid NOT NULL REFERENCES receives(id) ON DELETE RESTRICT,
  zoho_purchaseorder_id text,
  zoho_purchaseorder_line_item_id text,
  zoho_purchase_receive_id text,
  zoho_received_quantity integer,
  zoho_receive_status zoho_raw_bag_receive_status NOT NULL DEFAULT 'PENDING',
  zoho_receive_error text,
  zoho_received_at timestamptz,
  zoho_receive_idempotency_key text NOT NULL,
  reconciliation_status zoho_raw_bag_reconciliation_status NOT NULL DEFAULT 'UNCONFIRMED',
  preview_http_status integer,
  preview_response jsonb,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS zoho_raw_bag_receives_bag_unique
  ON zoho_raw_bag_receives(inventory_bag_id);

CREATE UNIQUE INDEX IF NOT EXISTS zoho_raw_bag_receives_idem_unique
  ON zoho_raw_bag_receives(zoho_receive_idempotency_key);

CREATE INDEX IF NOT EXISTS zoho_raw_bag_receives_receive_idx
  ON zoho_raw_bag_receives(receive_id);

CREATE INDEX IF NOT EXISTS zoho_raw_bag_receives_status_idx
  ON zoho_raw_bag_receives(zoho_receive_status);

CREATE INDEX IF NOT EXISTS zoho_raw_bag_receives_reconciliation_idx
  ON zoho_raw_bag_receives(reconciliation_status);
