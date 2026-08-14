-- P5 supervisor separation.
--
-- Three additive changes:
--   1. employees: supervisor PIN hash + boolean flag.
--   2. station_supervisor_sessions: time-boxed unlock sessions with the
--      same one-OPEN-per-station partial unique used by
--      station_operator_sessions (migration 0023).
--   3. station_exception_reports: bagless machine / other reports with a
--      partial index on unacknowledged rows per station.
--
-- Additive only. No data touched. No ALTER TYPE.

-- 1. PIN columns on employees -------------------------------------------------

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "supervisor_pin_hash" text;

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "is_supervisor" boolean NOT NULL DEFAULT false;

-- 2. Supervisor sessions -------------------------------------------------------
--
-- One row per supervisor unlock at a station. The 15-minute TTL is
-- enforced by the engine layer (expires_at). Only one OPEN session per
-- station is allowed via the partial unique below — the same invariant
-- that station_operator_sessions holds for operators (migration 0023).

CREATE TABLE IF NOT EXISTS "station_supervisor_sessions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "station_id"  uuid NOT NULL REFERENCES "stations"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "opened_at"   timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  "closed_at"   timestamptz
);

-- Only one open session per station. Opening a new session requires the
-- existing one to be closed first (engine layer does this automatically).
CREATE UNIQUE INDEX IF NOT EXISTS "station_supervisor_sessions_active_unique"
  ON "station_supervisor_sessions" ("station_id")
  WHERE "closed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "station_supervisor_sessions_employee_idx"
  ON "station_supervisor_sessions" ("employee_id");

CREATE INDEX IF NOT EXISTS "station_supervisor_sessions_opened_idx"
  ON "station_supervisor_sessions" ("opened_at");

-- 3. Station exception reports -------------------------------------------------
--
-- Bagless machine-down / other reports that cannot be attached to a
-- workflow_bag (attaching a null bag_id on workflow_events would break
-- the events invariant). The active operator's identity is snapshotted
-- at report time so audit reads stay readable after employee renames.

CREATE TABLE IF NOT EXISTS "station_exception_reports" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "station_id"             uuid NOT NULL REFERENCES "stations"("id") ON DELETE CASCADE,
  "category"               text NOT NULL,
  "detail"                 text NOT NULL,
  "employee_id"            uuid REFERENCES "employees"("id"),
  "employee_name_snapshot" text,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "acknowledged_at"        timestamptz,
  "acknowledged_by"        uuid REFERENCES "users"("id")
);

-- Fast lookup of unacknowledged reports per station for the Act Now rail.
CREATE INDEX IF NOT EXISTS "station_exception_reports_unack_idx"
  ON "station_exception_reports" ("station_id")
  WHERE "acknowledged_at" IS NULL;

CREATE INDEX IF NOT EXISTS "station_exception_reports_created_idx"
  ON "station_exception_reports" ("created_at");
