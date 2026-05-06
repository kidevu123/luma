-- Floor-event idempotency + read_bag_state index fix.
--
-- Idempotency: workflow_events grows a client_event_id column +
-- partial unique index (workflow_bag_id, event_type, client_event_id)
-- WHERE client_event_id IS NOT NULL. Floor PWA generates a UUID per
-- click; if the network retries the action the second insert hits
-- the constraint and we no-op gracefully instead of double-firing
-- BLISTER_COMPLETE.
--
-- Index fix: read_bag_state_paused_idx was declared in schema.ts
-- but never made it into a migration (queries on is_paused did seq
-- scans). Drop+recreate in case a partial dev DB picked up the
-- prior shape, then create properly.

ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS client_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_client_event_unique
  ON workflow_events (workflow_bag_id, event_type, client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS read_bag_state_paused_idx
  ON read_bag_state (is_paused);
