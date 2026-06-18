-- PARTIAL-UNIQUE-LUMA-OP-v1.4.10 — replace the global UNIQUE index on
-- zoho_production_output_ops.luma_operation_id with a PARTIAL unique
-- index scoped to non-voided rows.
--
-- Why
-- ===
--
-- The previous index enforced global uniqueness on luma_operation_id.
-- Combined with the upsert function's "look for non-voided ops only"
-- existence check, that meant any lot with a previously-voided op
-- could no longer accept a fresh preview attempt — the new INSERT
-- collided with the voided row's luma_operation_id, even though the
-- old row is audit history and the upsert is correctly looking past
-- it. Surfaced as the BlueRaz #36 v1.4.6 persistence crash.
--
-- The correct contract (locked v1.4.10):
--
--   * One active (non-voided) row per luma_operation_id.
--   * Multiple voided rows for the same luma_operation_id are allowed
--     (audit history, never collides with a new preview).
--   * Upsert keeps targeting active rows only — unchanged.
--
-- Migration design
-- ================
--
-- DROP INDEX IF EXISTS first so the migration is re-runnable. CREATE
-- UNIQUE INDEX with the WHERE voided_at IS NULL predicate. Same name
-- so the schema mirror reference is preserved. No DROP COLUMN, no
-- DROP TABLE, no data touched.
--
-- The voided row 114778f7-b64e-4c50-9a57-aba5e2db7651 (the BlueRaz
-- debug artifact) is intentionally LEFT IN PLACE. After this
-- migration it no longer participates in the unique index, so a
-- fresh preview attempt for the same lot will INSERT cleanly.
--
-- This is a constraint swap, not a relaxation. New active rows still
-- can't collide. The relaxation is only over audit history.

DROP INDEX IF EXISTS "zoho_prod_output_ops_luma_op_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_prod_output_ops_luma_op_unique"
  ON "zoho_production_output_ops" ("luma_operation_id")
  WHERE "voided_at" IS NULL;
