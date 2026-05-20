-- ZOHO-ASSY-1 — Schema foundation for tablet receiving + composite-item
-- assembly operations.  Phase 1: mapping columns + operation-tracking table.
-- No live Zoho writes are wired in this migration.
--
-- Changes:
--   A. Three nullable Zoho composite-item ID columns on products.
--      Existing zoho_item_id kept for compatibility (not removed).
--   B. Two new enums: zoho_assembly_op_kind, zoho_assembly_op_status.
--   C. New table zoho_assembly_ops — one row per atomic Zoho operation
--      per finished lot.  Idempotency is enforced by the unique index on
--      idempotency_key ("{finished_lot_id}:{op_kind}").

-- ─────────────────────────────────────────────────────────────────────────────
-- A) Products — Zoho composite-item ID columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "zoho_item_id_unit"    text,
  ADD COLUMN IF NOT EXISTS "zoho_item_id_display" text,
  ADD COLUMN IF NOT EXISTS "zoho_item_id_case"    text;

-- ─────────────────────────────────────────────────────────────────────────────
-- B) Enums
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "public"."zoho_assembly_op_kind" AS ENUM (
    'TABLET_RECEIVE',
    'UNIT_ASSEMBLE',
    'DISPLAY_ASSEMBLE',
    'CASE_ASSEMBLE'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."zoho_assembly_op_status" AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'SUCCEEDED',
    'FAILED',
    'NEEDS_MAPPING',
    'SKIPPED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- C) zoho_assembly_ops
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "zoho_assembly_ops" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "finished_lot_id"      uuid        NOT NULL
                           REFERENCES "finished_lots"("id") ON DELETE RESTRICT,
  "op_kind"              "public"."zoho_assembly_op_kind"   NOT NULL,
  "zoho_item_id"         text,
  "quantity"             integer     NOT NULL,
  "status"               "public"."zoho_assembly_op_status" NOT NULL DEFAULT 'PENDING',
  "idempotency_key"      text        NOT NULL,
  "zoho_reference_id"    text,
  "request_payload"      jsonb,
  "response_payload"     jsonb,
  "last_error"           text,
  "retry_count"          integer     NOT NULL DEFAULT 0,
  "enqueued_at"          timestamptz NOT NULL DEFAULT now(),
  "started_at"           timestamptz,
  "succeeded_at"         timestamptz,
  "failed_at"            timestamptz,
  "resolved_manually"    boolean     NOT NULL DEFAULT false,
  "resolved_note"        text,
  "resolved_by_user_id"  uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_assembly_ops_idem_unique"
  ON "zoho_assembly_ops"("idempotency_key");

CREATE INDEX IF NOT EXISTS "zoho_assembly_ops_lot_idx"
  ON "zoho_assembly_ops"("finished_lot_id");

CREATE INDEX IF NOT EXISTS "zoho_assembly_ops_status_idx"
  ON "zoho_assembly_ops"("status");
