-- PACKAGING-RECONCILIATION-SLICE-B — idempotency guard.
-- Prevents double-voiding the same MATERIAL_CONSUMED_ESTIMATED event
-- when the manual receipt action retries or is re-run.
CREATE UNIQUE INDEX IF NOT EXISTS material_events_estimated_voided_source_unique
  ON material_inventory_events ((payload->>'source_estimated_event_id'))
  WHERE event_type::text = 'MATERIAL_ESTIMATED_VOIDED'
    AND payload->>'source_estimated_event_id' IS NOT NULL;
