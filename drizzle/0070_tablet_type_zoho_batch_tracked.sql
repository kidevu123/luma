-- ZOHO-BATCH-TRACKING-v1.29.9 — opt-in flag for tablet types that
-- are batch-tracked in Zoho Inventory (item.track_batch_number=true).
-- When true, the production-output builder will resolve a Zoho batch
-- for this tablet's supplier lot and include it in component_batches.
-- Default false preserves the existing NOT_BATCH_TRACKED behaviour for
-- all existing tablet types; set true only for items confirmed
-- batch-tracked in Zoho.
ALTER TABLE "tablet_types" ADD COLUMN IF NOT EXISTS "zoho_batch_tracked" boolean NOT NULL DEFAULT false;

-- Set zoho_batch_tracked=true for Hyroxi MIT A tablet types.
-- These items have track_batch_number=true in Zoho Inventory
-- (confirmed via gateway batch_resolution.py / commit_preflight.py).
-- Zoho item IDs are stable identifiers; safe to reference directly.
UPDATE "tablet_types"
SET "zoho_batch_tracked" = true
WHERE "zoho_item_id" IN (
    '5254962000003150096',  -- Hyroxi Mit A - Pineapple
    '5254962000003150110'   -- Hyroxi Mit A - Pink Rosé
);
