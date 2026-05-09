-- OP-1E: stable-identity operator productivity rollups.
--
-- read_operator_daily previously keyed only on free-text operator_code
-- which lets misspellings produce phantom operators on the leaderboard.
-- This migration:
--
--   1. Adds employee_id (FK employees) — stable identity.
--   2. Drops the operator_code NOT NULL so new accountable bags can
--      land in the table without a typed code.
--   3. Replaces the (day, operator_code) unique with two PARTIAL
--      uniques so employee_id-keyed rows and legacy code-only rows
--      stay separated:
--        a. (day, employee_id) WHERE employee_id IS NOT NULL
--        b. (day, operator_code) WHERE employee_id IS NULL
--           AND operator_code IS NOT NULL
--   4. Adds an "at least one identity" CHECK so a row can never be
--      orphaned (both null is forbidden).
--   5. Adds an employee_id index.
--
-- Backwards-compatible: existing rows have operator_code populated
-- and employee_id null, so they fall under the legacy partial unique
-- and continue to be readable.

ALTER TABLE "read_operator_daily"
  ADD COLUMN IF NOT EXISTS "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL;

ALTER TABLE "read_operator_daily"
  ALTER COLUMN "operator_code" DROP NOT NULL;

DROP INDEX IF EXISTS "read_operator_daily_day_operator_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "read_operator_daily_day_employee_unique"
  ON "read_operator_daily" ("day", "employee_id")
  WHERE "employee_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "read_operator_daily_day_code_legacy_unique"
  ON "read_operator_daily" ("day", "operator_code")
  WHERE "employee_id" IS NULL AND "operator_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "read_operator_daily_employee_idx"
  ON "read_operator_daily" ("employee_id")
  WHERE "employee_id" IS NOT NULL;

ALTER TABLE "read_operator_daily"
  DROP CONSTRAINT IF EXISTS "read_operator_daily_identity_chk";

ALTER TABLE "read_operator_daily"
  ADD CONSTRAINT "read_operator_daily_identity_chk"
  CHECK ("employee_id" IS NOT NULL OR "operator_code" IS NOT NULL);
