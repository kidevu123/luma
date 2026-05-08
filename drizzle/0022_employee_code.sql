-- OP-1B: stable accountability identity for count submissions.
--
-- Adds a nullable employee_code on employees so operators can be
-- identified by a short, operator-friendly string in addition to
-- the surrogate UUID. Partial unique index makes the code unique
-- only among ACTIVE employees with a non-null code, so reusing a
-- code after termination is allowed without rewriting history.
--
-- Additive only. Zero rows touched. Existing call sites unaffected.

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "employee_code" text;

CREATE UNIQUE INDEX IF NOT EXISTS "employees_code_active_unique"
  ON "employees" ("employee_code")
  WHERE "status" = 'ACTIVE' AND "employee_code" IS NOT NULL;
