-- ZOHO-ASSY-1b — Source-tracking fields on zoho_assembly_ops.
--
-- Motivation: a single finished lot can require multiple TABLET_RECEIVE
-- operations (one per source inventory bag).  Variety packs always have
-- multiple tablet sources; standard products may also span bags.  Without
-- per-source anchors the idempotency key {finishedLotId}:{opKind} is not
-- unique for TABLET_RECEIVE and the Zoho PO receive call cannot be
-- constructed at execution time.
--
-- All columns nullable.  No backfill: zoho_assembly_ops has zero rows in
-- production (Phase 1 added the table but never enqueues ops).
--
-- Updated idempotency key formats (enforced by application, not DB):
--   TABLET_RECEIVE:   luma:tablet_receive:{finishedLotId}:{inventoryBagId}
--   UNIT_ASSEMBLE:    luma:unit_assemble:{finishedLotId}
--   DISPLAY_ASSEMBLE: luma:display_assemble:{finishedLotId}
--   CASE_ASSEMBLE:    luma:case_assemble:{finishedLotId}

ALTER TABLE "zoho_assembly_ops"
  ADD COLUMN IF NOT EXISTS "source_inventory_bag_id" uuid
    REFERENCES "inventory_bags"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "source_po_line_id"       uuid
    REFERENCES "po_lines"("id")       ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "source_tablet_type_id"   uuid
    REFERENCES "tablet_types"("id")   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "component_role"           text,
  ADD COLUMN IF NOT EXISTS "op_sequence"              integer;

-- Partial index: only TABLET_RECEIVE rows will populate this column.
CREATE INDEX IF NOT EXISTS "zoho_assembly_ops_inv_bag_idx"
  ON "zoho_assembly_ops"("source_inventory_bag_id")
  WHERE "source_inventory_bag_id" IS NOT NULL;
