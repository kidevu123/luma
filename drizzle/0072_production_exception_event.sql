-- P4b Task 2 — the single exception workflow's one new event type.
--
-- ISOLATED migration: enum ALTER only. ALTER TYPE ... ADD VALUE silently
-- rolls back when bundled with other DDL inside a single migration on
-- populated DBs (see 0002/0019/0020/0035 for the same note); this repo's
-- migrator (scripts/migrate.ts -> drizzle-orm's postgres-js migrator)
-- wraps every pending migration in one outer transaction, so on Postgres
-- 16 the ADD VALUE itself is fine inside that transaction — it just must
-- not share a migration file with DDL that USES the new value, which is
-- exactly the failure mode these prior isolated migrations already
-- worked around. Same precedent, same isolation.
--
-- Projector: PRODUCTION_EXCEPTION_RAISED is deliberately absent from
-- STAGE_FOR_EVENT, THROUGHPUT_COLUMN, and bag-queue.ts's FLOW_EVENTS —
-- it records an exception without advancing stage, throughput, or queue
-- state. See lib/projector/index.test.ts's non-progression pin.

ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'PRODUCTION_EXCEPTION_RAISED';
