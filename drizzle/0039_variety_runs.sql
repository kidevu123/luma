-- VARIETY-RUNS-1 — Parent variety run entity.
--
-- Motivation: variety-pack production uses reusable physical QR cards
-- ("variety cards") to identify a production run at a station.  Without
-- a parent run entity, a card's identity is conflated with a single bag
-- and cannot be reused.  This migration adds "variety_runs" so that each
-- physical variety card can be assigned to one OPEN run at a time.
--
-- When the run closes (all raw-bag allocation sessions settled), the card
-- is freed and can be opened again for a new run.  The partial unique index
-- "variety_runs_one_open_per_token_idx" enforces the invariant: at most one
-- OPEN row per parent_scan_token at any moment, while allowing unlimited
-- CLOSED/VOID rows for history.
--
-- raw_bag_allocation_sessions gains a nullable FK to variety_runs so that
-- every allocation session can be traced back to the variety run that
-- originated it.

CREATE TYPE "variety_run_status" AS ENUM ('OPEN', 'CLOSED', 'VOID');

CREATE TABLE "variety_runs" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_scan_token"   TEXT NOT NULL,
  "product_id"          UUID REFERENCES "products"("id") ON DELETE SET NULL,
  "status"              "variety_run_status" NOT NULL DEFAULT 'OPEN',
  "opened_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "closed_at"           TIMESTAMPTZ,
  "created_by_user_id"  UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "notes"               TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "variety_runs_token_status_idx"
  ON "variety_runs"("parent_scan_token", "status");

CREATE INDEX "variety_runs_product_status_idx"
  ON "variety_runs"("product_id", "status");

-- One OPEN run per token at a time. Same card can be reused after
-- the run closes (partial unique: only OPEN rows are constrained).
CREATE UNIQUE INDEX "variety_runs_one_open_per_token_idx"
  ON "variety_runs"("parent_scan_token")
  WHERE "status" = 'OPEN';

ALTER TABLE "raw_bag_allocation_sessions"
  ADD COLUMN IF NOT EXISTS "variety_run_id" UUID
    REFERENCES "variety_runs"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "rba_sessions_variety_run_idx"
  ON "raw_bag_allocation_sessions"("variety_run_id")
  WHERE "variety_run_id" IS NOT NULL;
