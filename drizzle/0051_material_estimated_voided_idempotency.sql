-- Predicate uses payload keys only (no enum literal) so 0050 enum ADD VALUE
-- and this index can apply in the same migrator session safely.
CREATE UNIQUE INDEX IF NOT EXISTS material_events_estimated_voided_source_unique
  ON material_inventory_events ((payload->>'source_estimated_event_id'))
  WHERE payload->>'source_estimated_event_id' IS NOT NULL
    AND payload->>'voided_qty' IS NOT NULL;
