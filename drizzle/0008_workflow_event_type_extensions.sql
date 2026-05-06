-- Phase A: extend workflow_event_type with the 11 event types the
-- production-intelligence rebuild needs. Isolated migration — no
-- table changes, no projector changes — because Drizzle's
-- generator silently rolls back ALTER TYPE ADD VALUE when it lands
-- in the same migration as DDL that needs the new value (per the
-- payroll-rebuild memory note). Adding values one statement at a
-- time, idempotent, so a partial replay won't fail.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'DOWNTIME_STARTED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'DOWNTIME_STARTED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'DOWNTIME_ENDED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'DOWNTIME_ENDED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'MATERIAL_CHANGED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'MATERIAL_CHANGED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'QA_HOLD_STARTED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'QA_HOLD_STARTED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'QA_HOLD_RELEASED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'QA_HOLD_RELEASED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'REWORK_SENT') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'REWORK_SENT';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'REWORK_RECEIVED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'REWORK_RECEIVED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'SCRAP_RECORDED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'SCRAP_RECORDED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'PACKAGING_MATERIAL_ISSUED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'PACKAGING_MATERIAL_ISSUED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'PACKAGING_MATERIAL_RETURNED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'PACKAGING_MATERIAL_RETURNED';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'workflow_event_type' AND e.enumlabel = 'FINISHED_GOODS_RELEASED') THEN
    ALTER TYPE workflow_event_type ADD VALUE 'FINISHED_GOODS_RELEASED';
  END IF;
END $$;
