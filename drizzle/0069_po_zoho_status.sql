-- PO-ZOHO-STATUS — additive columns to purchase_orders for raw Zoho PO
-- status storage. zoho_status stores the verbatim Zoho string (e.g.
-- "issued", "closed", "billed", "cancelled"); null means never synced.
-- zoho_status_synced_at records when the value was last fetched.
-- The existing mapped `status` enum keeps its own semantics.

ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "zoho_status" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "zoho_status_synced_at" timestamp with time zone;
