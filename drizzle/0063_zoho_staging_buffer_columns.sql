-- ZOHO-STAGING-BUFFER-v1.1.0 — columns that back the staged-op review
-- window, hold/void operations, the shared idempotent commit path, and
-- the per-product live-commit toggle. Pairs with the enum extensions in
-- 0062 (HELD / NEEDS_MAPPING / COMMITTING / VOIDED).
--
-- All additive (ADD COLUMN IF NOT EXISTS). No drops, no renames, no
-- destructive type changes. Default values are conservative so existing
-- rows keep working (auto_commit_eligible_at NULL means "do not
-- auto-commit"; commit_attempt_count 0 is the natural zero state).

-- ─── zoho_raw_bag_receives ────────────────────────────────────────────
--
-- Buffer + hold/void columns. seedPendingRawBagReceiveRows will populate
-- auto_commit_eligible_at = now() + ZOHO_AUTO_COMMIT_BUFFER_HOURS at
-- intake; the cron route claims rows where the timestamp is in the past
-- and status = PENDING / NEEDS_MAPPING and no hold/void is set.
ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "auto_commit_eligible_at" timestamptz;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "held_at" timestamptz;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "held_reason" text;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "voided_at" timestamptz;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "void_reason" text;

-- Separate from zoho_receive_idempotency_key (which is the PREVIEW key)
-- so retries on commit can replay without colliding with a stale preview
-- key when the staged op was re-previewed earlier.
ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "commit_idempotency_key" text;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "commit_attempt_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "commit_started_at" timestamptz;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "committed_at" timestamptz;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "commit_request_payload" jsonb;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "commit_response_payload" jsonb;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "commit_error" text;

-- Gateway-returned blockers when status flips to NEEDS_MAPPING. Mirrors
-- the shape used by zoho_production_output_ops.mapping_blockers so the
-- admin chip code can share a render path.
ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "mapping_blockers" jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_raw_bag_receives_commit_idem_unique"
  ON "zoho_raw_bag_receives" ("commit_idempotency_key")
  WHERE "commit_idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "zoho_raw_bag_receives_auto_commit_idx"
  ON "zoho_raw_bag_receives" ("auto_commit_eligible_at")
  WHERE "auto_commit_eligible_at" IS NOT NULL;

-- ─── zoho_production_output_ops ───────────────────────────────────────
--
-- The production-output table already carries the full commit
-- contract (commit_idempotency_key, commit_attempt_count,
-- commit_started_at, committed_at, commit_error, voided_at,
-- mapping_blockers). Only the buffer + explicit-hold columns are new.
-- `status` is a free-text column on this table, so HELD does not need
-- an enum extension.
ALTER TABLE "zoho_production_output_ops"
  ADD COLUMN IF NOT EXISTS "auto_commit_eligible_at" timestamptz;

ALTER TABLE "zoho_production_output_ops"
  ADD COLUMN IF NOT EXISTS "held_at" timestamptz;

ALTER TABLE "zoho_production_output_ops"
  ADD COLUMN IF NOT EXISTS "held_reason" text;

CREATE INDEX IF NOT EXISTS "zoho_production_output_ops_auto_commit_idx"
  ON "zoho_production_output_ops" ("auto_commit_eligible_at")
  WHERE "auto_commit_eligible_at" IS NOT NULL;

-- ─── products ─────────────────────────────────────────────────────────
--
-- Operator-toggleable per-product gate. The live-commit eligibility
-- rule is the AND of:
--   product.zoho_live_commit_enabled = true
--   AND all required Zoho IDs present (data-driven readiness)
--   AND product structure valid (units_per_display / displays_per_case)
--   AND no mapping blockers
-- so flipping this flag on its own is not sufficient — readiness must
-- also pass. Default false so existing products do NOT silently get
-- promoted to live commit when this column lands on a populated DB.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "zoho_live_commit_enabled" boolean NOT NULL DEFAULT false;
