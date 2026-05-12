-- QC-1 — QC subsystem foundation.
--
-- Three additive changes, all backwards-compatible:
--
--   1. read_operator_daily gets five integer counter columns so the
--      operator-productivity rollup can break out QC events without
--      a second join. All NOT NULL DEFAULT 0 so legacy rows are
--      valid as soon as the column lands.
--
--   2. workflow_events gets an expression index on the
--      payload->>'linked_event_id' jsonb path. QC events fan out
--      from a source event (PACKAGING_DAMAGE_RETURN → SCRAP_RECORDED
--      or REWORK_SENT) and chasing the chain by jsonb extraction
--      would otherwise force a sequential scan over the entire
--      event log on every read.
--
--   3. workflow_events gets a PARTIAL UNIQUE index that prevents
--      converting the same source event (typically a damage return)
--      into more than one resolution of the same type — two
--      simultaneous SCRAP_RECORDED rows linked to the same damage
--      return would double-count loss. Only constrains the two
--      "resolves-a-source-event" types; corrections and other QC
--      events that reuse linked_event_id semantics (e.g.
--      SUBMISSION_CORRECTED) are intentionally outside this scope.
--
-- No workflow_event_type enum changes: PACKAGING_DAMAGE_RETURN,
-- REWORK_SENT, REWORK_RECEIVED, SCRAP_RECORDED, and
-- SUBMISSION_CORRECTED already live in the enum (see schema.ts:175).
--
-- No new tables.

-- 1. QC counter columns on read_operator_daily.
--    damage_count_total already exists from the original Phase A
--    schema; the new damage_events_total mirrors it under the
--    canonical QC naming and decouples future plans (event count
--    vs unit count) without breaking the existing column.
ALTER TABLE "read_operator_daily"
  ADD COLUMN IF NOT EXISTS "damage_events_total"   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rework_sent_total"     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rework_received_total" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scrap_units_total"     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "corrections_total"     integer NOT NULL DEFAULT 0;

-- 2. Fast lookup for the QC event chain.
CREATE INDEX IF NOT EXISTS "workflow_events_linked_event_idx"
  ON "workflow_events" (("payload"->>'linked_event_id'))
  WHERE "payload" ? 'linked_event_id';

-- 3. Prevent double-resolving a single source event into more than
--    one scrap row or more than one rework-sent row. Two scraps
--    against the same damage return = double-counted loss;
--    two rework-sent against the same return = bag travel diverges.
--    SUBMISSION_CORRECTED is intentionally NOT in this list — a
--    correction can itself be later corrected, which is legitimate.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_linked_event_resolution_unique"
  ON "workflow_events" (("payload"->>'linked_event_id'), "event_type")
  WHERE "event_type" IN ('SCRAP_RECORDED', 'REWORK_SENT')
    AND "payload" ? 'linked_event_id';
