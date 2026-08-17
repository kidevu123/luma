-- Migration 0074 — HANDPACK_BLISTER as a real route operation.
--
-- Before this migration, HANDPACK_BLISTER was handled by an alias in
-- resolve-operation.ts (STATION_KIND_ALIAS: HANDPACK_BLISTER -> BLISTER).
-- That alias was uncorroborated: no route_operations row had
-- allowed_station_kind = 'HANDPACK_BLISTER', so the downstream event
-- override in intentToEventType was the only thing keeping the engine
-- from firing BLISTER_COMPLETE (which ALLOWED_EVENTS_BY_KIND.HANDPACK_BLISTER
-- rejects). This migration gives HANDPACK_BLISTER its own real operation row,
-- closing the gap documented in resolve-operation.ts.
--
-- Additive only. Idempotent (ON CONFLICT DO NOTHING).

-- Insert the HANDPACK_BLISTER operation type if absent.
-- mirrors the operation_types insert style from 0013_route_operation_compat.sql.
INSERT INTO "operation_types"
  ("code","name","description","requires_timer","requires_counter","requires_machine","requires_materials","output_unit") VALUES
  ('HANDPACK_BLISTER', 'Handpack blister', 'Hand-pack tablets into blister cards and seal lid foil.', true, true, false, true, 'cards')
ON CONFLICT ("code") DO NOTHING;

-- Insert the HANDPACK_BLISTER route_operations row on CARD_BLISTER.
--
-- Same stage/next-stage keys as the BLISTER operation (BLISTER_QUEUE ->
-- POST_BLISTER_STAGING): both are entry operations for the blister phase.
-- Sequence 8 is the next free value after the 0013 seed (sequences 1-7).
-- Entry operations are rank-equivalent via stage keys, not sequence — the
-- QUEUE_RANK table keys on queue stage names, and both BLISTER and
-- HANDPACK_BLISTER land bags at SEALING_QUEUE after completion.
INSERT INTO "route_operations"
  ("route_id","operation_type_id","sequence","stage_key","next_stage_key","allowed_station_kind","allowed_machine_kind","requires_scan","requires_counter","requires_timer","output_unit")
SELECT r.id, o.id, 8, 'BLISTER_QUEUE', 'POST_BLISTER_STAGING', 'HANDPACK_BLISTER', NULL, true, true, true, 'cards'
FROM "production_routes" r
JOIN "operation_types" o ON o.code = 'HANDPACK_BLISTER'
WHERE r.code = 'CARD_BLISTER'
ON CONFLICT ("route_id","sequence") DO NOTHING;
