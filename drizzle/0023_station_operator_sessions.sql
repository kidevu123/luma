-- OP-1C: per-station operator session.
--
-- One row per "operator at this station for this shift" assignment.
-- Floor actions read the active row (closed_at IS NULL) at the station
-- to default `workflow_events.employee_id` for every count submission
-- without forcing the operator to type their code per click. Closing
-- the row ends the shift; the partial unique below makes "only one
-- open session per station" a hard invariant at the DB layer.
--
-- accountability_source records HOW the operator was identified when
-- the session was opened (LOGGED_IN_USER / EMPLOYEE_PICKER /
-- EMPLOYEE_CODE / BADGE_SCAN / SUPERVISOR_OVERRIDE / LEGACY_TEXT /
-- MANUAL_TEXT). Mirrors the union exported from lib/projector and the
-- accountability helper.
--
-- Additive only. No data touched.

CREATE TABLE IF NOT EXISTS "station_operator_sessions" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "station_id"               uuid NOT NULL REFERENCES "stations"("id") ON DELETE CASCADE,
  "employee_id"              uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "employee_name_snapshot"   text NOT NULL,
  "accountability_source"    text NOT NULL,
  "opened_at"                timestamptz NOT NULL DEFAULT now(),
  "closed_at"                timestamptz,
  "opened_by_user_id"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "closed_by_user_id"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "notes"                    text
);

-- Only one open session per station. Reopening requires the existing
-- one to close first. Avoids the "two operators both think they're
-- the active one" race.
CREATE UNIQUE INDEX IF NOT EXISTS "station_operator_sessions_active_unique"
  ON "station_operator_sessions" ("station_id")
  WHERE "closed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "station_operator_sessions_employee_idx"
  ON "station_operator_sessions" ("employee_id")
  WHERE "employee_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "station_operator_sessions_opened_idx"
  ON "station_operator_sessions" ("opened_at");
