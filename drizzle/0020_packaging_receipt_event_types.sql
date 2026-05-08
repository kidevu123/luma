-- PT-1: Five new material_event_type values for the PackTrack -> Luma
-- packaging-receipt contract.
--
-- ALTER TYPE ... ADD VALUE silently rolls back when bundled with
-- other DDL inside a single migration on populated DBs (drizzle/
-- postgres-js gotcha). This file therefore contains nothing else;
-- the per-table additions live in 0021.

ALTER TYPE "material_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_RECEIPT_IMPORTED';
ALTER TYPE "material_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_BOX_RECEIVED';
ALTER TYPE "material_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_BOX_COUNTED';
ALTER TYPE "material_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_RECEIPT_ADJUSTED';
ALTER TYPE "material_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_VARIANCE_RECORDED';
