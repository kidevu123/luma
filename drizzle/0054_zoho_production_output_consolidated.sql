-- ZOHO-PRODUCTION-OUTPUT-CONSOLIDATED-1 — consolidated shared-service path statuses
-- and nullable PO mapping columns for NEEDS_MAPPING ops.

ALTER TABLE "zoho_production_output_ops"
  DROP CONSTRAINT IF EXISTS "zoho_prod_output_ops_status_check";

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_status_check"
  CHECK (
    "status" IN (
      'DRAFT',
      'PREVIEWED',
      'APPROVED',
      'VOIDED',
      'READY',
      'NEEDS_MAPPING',
      'QUEUED',
      'COMMITTING',
      'COMMITTED',
      'FAILED'
    )
  );

ALTER TABLE "zoho_production_output_ops"
  ALTER COLUMN "zoho_purchaseorder_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "mapping_blockers" jsonb,
  ADD COLUMN IF NOT EXISTS "payload_kind" text NOT NULL DEFAULT 'preview';
