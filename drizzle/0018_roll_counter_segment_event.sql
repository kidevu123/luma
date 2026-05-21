-- Phase VALIDATION-2C — Add ROLL_COUNTER_SEGMENT_RECORDED to
-- material_event_type enum.
--
-- ISOLATED migration — only the ALTER TYPE statement here, per the
-- drizzle silent-rollback gotcha for ALTER TYPE in multi-statement
-- migrations. Adding a new enum value cannot be rolled back inside
-- a transaction, so it must run alone.
--
-- Rationale: counter segments are a different concept from weight
-- consumption. A segment captures "the operator entered N blisters
-- on the counter; allocate that count to the active PVC roll, the
-- active foil roll, and the active workflow bag." Weight consumption
-- (MATERIAL_CONSUMED_ESTIMATED / _ACTUAL) is derived later from the
-- segment ledger × the configured/learned standard, OR from a roll
-- weigh-back at depletion time.

ALTER TYPE "material_event_type" ADD VALUE IF NOT EXISTS 'ROLL_COUNTER_SEGMENT_RECORDED';
