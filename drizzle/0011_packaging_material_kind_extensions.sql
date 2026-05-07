-- Phase H: extend packaging_material_kind for PVC + foil rolls + shrink
-- bands. Isolated migration — no other DDL — so the additive enum
-- values land cleanly without Drizzle's "rolls back when used in
-- the same migration" gotcha.
--
-- Existing values stay intact: BLISTER_FOIL is the historical
-- catch-all; FOIL_ROLL is the new canonical for tracked rolls.
-- The metric layer treats both as foil for consumption math; the
-- distinction matters for inventory + roll-tracking only.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='packaging_material_kind' AND e.enumlabel='PVC_ROLL') THEN
    ALTER TYPE packaging_material_kind ADD VALUE 'PVC_ROLL';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='packaging_material_kind' AND e.enumlabel='FOIL_ROLL') THEN
    ALTER TYPE packaging_material_kind ADD VALUE 'FOIL_ROLL';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='packaging_material_kind' AND e.enumlabel='SHRINK_BAND') THEN
    ALTER TYPE packaging_material_kind ADD VALUE 'SHRINK_BAND';
  END IF;
END $$;
