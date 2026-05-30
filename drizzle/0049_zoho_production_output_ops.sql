-- ZOHO-PRODUCTION-OUTPUT-SLICE-A — Durable preview snapshots only.
--
-- Adds local persistence for the consolidated Zoho production-output preview
-- request/response. This migration does not add approval, commit/apply, or any
-- live Zoho write behavior.

CREATE TABLE IF NOT EXISTS "zoho_production_output_ops" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "luma_operation_id" text NOT NULL,
  "finished_lot_id" uuid NOT NULL
    REFERENCES "finished_lots"("id") ON DELETE RESTRICT,
  "workflow_bag_id" uuid
    REFERENCES "workflow_bags"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'DRAFT',

  "zoho_purchaseorder_id" text NOT NULL,
  "zoho_purchaseorder_line_item_id" text NOT NULL,
  "zoho_warehouse_id" text,
  "zoho_composite_item_id" text,
  "zoho_display_composite_item_id" text,
  "zoho_case_composite_item_id" text,

  "quantity_good" integer NOT NULL,
  "unit_assembly_quantity" integer NOT NULL,
  "display_assembly_quantity" integer NOT NULL DEFAULT 0,
  "case_assembly_quantity" integer NOT NULL DEFAULT 0,
  "quantity_damaged" integer,
  "quantity_ripped" integer,
  "quantity_loose" integer,
  "quantity_basis" jsonb NOT NULL DEFAULT '{}'::jsonb,

  "metrics_state" text NOT NULL DEFAULT 'MISSING',
  "genealogy_state" text NOT NULL DEFAULT 'MISSING',
  "request_payload" jsonb NOT NULL,
  "request_hash" text NOT NULL,
  "preview_idempotency_key" text,
  "preview_http_status" integer,
  "preview_response" jsonb,
  "previewed_by_user_id" uuid
    REFERENCES "users"("id") ON DELETE SET NULL,
  "previewed_at" timestamptz,
  "selected_by_user_id" uuid
    REFERENCES "users"("id") ON DELETE SET NULL,
  "selected_at" timestamptz,
  "voided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "zoho_prod_output_ops_status_check"
    CHECK ("status" IN ('DRAFT', 'PREVIEWED')),
  CONSTRAINT "zoho_prod_output_ops_metrics_state_check"
    CHECK ("metrics_state" IN ('HIGH', 'LOW', 'MISSING')),
  CONSTRAINT "zoho_prod_output_ops_genealogy_state_check"
    CHECK ("genealogy_state" IN ('HIGH', 'LOW', 'MISSING')),
  CONSTRAINT "zoho_prod_output_ops_quantity_check"
    CHECK (
      "quantity_good" >= 0
      AND "unit_assembly_quantity" >= 0
      AND "display_assembly_quantity" >= 0
      AND "case_assembly_quantity" >= 0
      AND ("quantity_damaged" IS NULL OR "quantity_damaged" >= 0)
      AND ("quantity_ripped" IS NULL OR "quantity_ripped" >= 0)
      AND ("quantity_loose" IS NULL OR "quantity_loose" >= 0)
    ),
  CONSTRAINT "zoho_prod_output_ops_display_item_check"
    CHECK (
      "display_assembly_quantity" = 0
      OR "zoho_display_composite_item_id" IS NOT NULL
    ),
  CONSTRAINT "zoho_prod_output_ops_case_item_check"
    CHECK (
      "case_assembly_quantity" = 0
      OR "zoho_case_composite_item_id" IS NOT NULL
    ),
  CONSTRAINT "zoho_prod_output_ops_previewed_check"
    CHECK (
      "status" <> 'PREVIEWED'
      OR ("previewed_at" IS NOT NULL AND "preview_http_status" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_prod_output_ops_luma_op_unique"
  ON "zoho_production_output_ops"("luma_operation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_prod_output_ops_active_lot_unique"
  ON "zoho_production_output_ops"("finished_lot_id")
  WHERE "voided_at" IS NULL;

CREATE INDEX IF NOT EXISTS "zoho_prod_output_ops_lot_idx"
  ON "zoho_production_output_ops"("finished_lot_id");

CREATE INDEX IF NOT EXISTS "zoho_prod_output_ops_status_idx"
  ON "zoho_production_output_ops"("status");

CREATE INDEX IF NOT EXISTS "zoho_prod_output_ops_request_hash_idx"
  ON "zoho_production_output_ops"("request_hash");
