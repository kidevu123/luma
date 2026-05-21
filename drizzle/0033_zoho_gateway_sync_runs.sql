-- ZOHO-1 — Zoho gateway connectivity + future sync run / state tables.
--
-- Owner decision: live Zoho sync routes through the LXC integration
-- gateway (env: ZOHO_INTEGRATION_URL, default http://192.168.1.190:9503).
-- Luma never holds Zoho OAuth refresh/access tokens; the gateway owns
-- them. This migration adds the audit + state tables future sync phases
-- will write to. ZOHO-1 itself only writes CONNECTIVITY_CHECK rows.
--
-- Two new enums, two new tables. Additive only — no destructive changes,
-- no rename, no drop. The pre-existing zoho_credentials + zoho_pushes
-- tables stay in place (legacy direct-OAuth path; not used for new sync
-- per the gateway decision, but kept for the existing /settings/zoho
-- credentials test button).

DO $$ BEGIN
  CREATE TYPE "zoho_sync_kind" AS ENUM (
    'CONNECTIVITY_CHECK',
    'ITEMS',
    'CUSTOMERS',
    'SALES_ORDERS',
    'PURCHASE_ORDERS',
    'FINISHED_LOT_PUSH'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "zoho_sync_run_status" AS ENUM (
    'STARTED',
    'SUCCESS',
    'PARTIAL',
    'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "zoho_sync_runs" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_type"            zoho_sync_kind        NOT NULL,
  "status"               zoho_sync_run_status  NOT NULL DEFAULT 'STARTED',
  "started_at"           timestamptz           NOT NULL DEFAULT now(),
  "finished_at"          timestamptz,
  -- 'manual' for admin-button triggered runs; 'pg_boss' for future
  -- scheduled handlers. Free-text; no enum so future sources land
  -- without an ALTER TYPE.
  "source"               text                  NOT NULL DEFAULT 'manual',
  -- Every run defaults to dry-run. Live writes flip this to false only
  -- in later phases.
  "dry_run"              boolean               NOT NULL DEFAULT true,
  -- Structured outcome: rows_seen / rows_written / unmatched / per-kind
  -- payload. Kept as jsonb so the schema doesn't ossify per-sync-kind.
  "summary"              jsonb                 NOT NULL DEFAULT '{}'::jsonb,
  "error"                text,
  "created_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "zoho_sync_runs_type_started_idx"
  ON "zoho_sync_runs" ("sync_type", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "zoho_sync_runs_status_idx"
  ON "zoho_sync_runs" ("status");

-- Per-object sync state. Keyed on (object_type, external_id). object_type
-- is free-text (ITEM / CUSTOMER / SALES_ORDER / PURCHASE_ORDER) so
-- future sync kinds don't force an enum change. ZOHO-1 does not write
-- here; the table is created in preparation for ZOHO-2/ZOHO-3.
CREATE TABLE IF NOT EXISTS "zoho_sync_state" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "object_type"     text       NOT NULL,
  "external_id"     text       NOT NULL,
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  "last_synced_at"  timestamptz,
  -- SHA256 of the verbatim Zoho payload (or a stable subset) so future
  -- syncs can detect "no change since last seen" without diffing every
  -- field.
  "source_hash"     text,
  "status"          text       NOT NULL DEFAULT 'SEEN',
  "metadata"        jsonb      NOT NULL DEFAULT '{}'::jsonb,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_sync_state_object_external_unique"
  ON "zoho_sync_state" ("object_type", "external_id");

CREATE INDEX IF NOT EXISTS "zoho_sync_state_last_seen_idx"
  ON "zoho_sync_state" ("last_seen_at" DESC);

CREATE INDEX IF NOT EXISTS "zoho_sync_state_status_idx"
  ON "zoho_sync_state" ("status");
