-- PT-1: PackTrack-aware packaging-receipt columns + source-system enum.
--
-- Additive only. Existing rows keep qty_received as-is and get
-- accepted_quantity backfilled to the same value so reconciliation
-- continues to work during the transition.

CREATE TYPE "packaging_receipt_source" AS ENUM (
  'PACKTRACK',
  'MANUAL_LUMA',
  'ZOHO',
  'IMPORT'
);

ALTER TABLE "packaging_lots"
  ADD COLUMN IF NOT EXISTS "declared_quantity"     integer,
  ADD COLUMN IF NOT EXISTS "counted_quantity"      integer,
  ADD COLUMN IF NOT EXISTS "accepted_quantity"     integer,
  ADD COLUMN IF NOT EXISTS "box_number"            text,
  ADD COLUMN IF NOT EXISTS "supplier_lot_number"   text,
  ADD COLUMN IF NOT EXISTS "packtrack_po_id"       text,
  ADD COLUMN IF NOT EXISTS "packtrack_receipt_id"  text,
  ADD COLUMN IF NOT EXISTS "source_system"         "packaging_receipt_source",
  ADD COLUMN IF NOT EXISTS "received_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- Backfill accepted_quantity from existing qty_received so all existing
-- rows have a non-null value. New rows from this migration forward
-- always set accepted_quantity explicitly.
UPDATE "packaging_lots"
   SET "accepted_quantity" = "qty_received"
 WHERE "accepted_quantity" IS NULL;

-- Idempotency: a single PackTrack receipt + box pair must map to
-- exactly one packaging_lots row. Guarantees re-import (network retry,
-- duplicate webhook) does not double-count.
CREATE INDEX IF NOT EXISTS "packaging_lots_packtrack_receipt_idx"
  ON "packaging_lots" ("packtrack_receipt_id")
  WHERE "packtrack_receipt_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "packaging_lots_packtrack_box_unique"
  ON "packaging_lots" ("packtrack_receipt_id", "box_number")
  WHERE "packtrack_receipt_id" IS NOT NULL AND "box_number" IS NOT NULL;
