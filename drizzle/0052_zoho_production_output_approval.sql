-- ZOHO-PRODUCTION-OUTPUT-SLICE-B — Approval / void gate (preview-only).
-- No commit/apply/send or live Zoho write behavior.

ALTER TABLE "zoho_production_output_ops"
  DROP CONSTRAINT IF EXISTS "zoho_prod_output_ops_status_check";

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_status_check"
  CHECK ("status" IN ('DRAFT', 'PREVIEWED', 'APPROVED', 'VOIDED'));

ALTER TABLE "zoho_production_output_ops"
  DROP CONSTRAINT IF EXISTS "zoho_prod_output_ops_previewed_check";

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_previewed_check"
  CHECK (
    "status" NOT IN ('PREVIEWED', 'APPROVED')
    OR ("previewed_at" IS NOT NULL AND "preview_http_status" IS NOT NULL)
  );

ALTER TABLE "zoho_production_output_ops"
  ADD COLUMN IF NOT EXISTS "approved_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" uuid
    REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "approved_request_hash" text,
  ADD COLUMN IF NOT EXISTS "void_reason" text,
  ADD COLUMN IF NOT EXISTS "voided_by_user_id" uuid
    REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_approved_check"
  CHECK (
    "status" <> 'APPROVED'
    OR (
      "approved_at" IS NOT NULL
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_request_hash" IS NOT NULL
    )
  );

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_voided_check"
  CHECK (
    "voided_at" IS NULL
    OR (
      "voided_by_user_id" IS NOT NULL
      AND "void_reason" IS NOT NULL
      AND btrim("void_reason") <> ''
    )
  );

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_void_status_check"
  CHECK (
    "voided_at" IS NULL
    OR "status" = 'VOIDED'
  );
