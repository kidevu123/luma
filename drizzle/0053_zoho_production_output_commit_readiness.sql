-- ZOHO-PRODUCTION-OUTPUT-SLICE-C1 — Future commit readiness metadata only.
-- Adds commit-state vocabulary and nullable metadata columns for readiness UI.
-- No queue action, worker, commit/apply/send endpoint, outbox enqueue, or live Zoho write behavior.

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
      'QUEUED',
      'COMMITTING',
      'COMMITTED',
      'FAILED'
    )
  );

ALTER TABLE "zoho_production_output_ops"
  ADD COLUMN IF NOT EXISTS "commit_idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "commit_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "commit_requested_by_user_id" uuid
    REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "commit_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "committed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "commit_finished_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "commit_attempt_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_commit_attempt_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "commit_response" jsonb,
  ADD COLUMN IF NOT EXISTS "commit_error" text,
  ADD COLUMN IF NOT EXISTS "external_reference_id" text;

ALTER TABLE "zoho_production_output_ops"
  ADD CONSTRAINT "zoho_prod_output_ops_commit_attempt_check"
  CHECK ("commit_attempt_count" >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_prod_output_ops_commit_idem_unique"
  ON "zoho_production_output_ops"("commit_idempotency_key")
  WHERE "commit_idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_prod_output_ops_committed_lot_unique"
  ON "zoho_production_output_ops"("finished_lot_id")
  WHERE "status" = 'COMMITTED';
