-- Add the new workflow_event types. Isolated from other DDL because
-- ALTER TYPE ADD VALUE silently rolls back inside a larger
-- transaction. Verify after deploy via:
--   SELECT enumlabel FROM pg_enum
--   WHERE enumtypid = 'workflow_event_type'::regtype;
ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'BAG_PAUSED';
ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'BAG_RESUMED';
ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_COMPLETE';
ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'PACKAGING_DAMAGE_RETURN';
ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'BAG_VERIFIED';
