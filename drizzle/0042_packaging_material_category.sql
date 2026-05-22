-- 0042 — packaging_materials.category field.
--
-- The packaging_item_category enum and the category column were added to the
-- live DB via direct SQL before this migration was formalised. Both statements
-- are guarded so this migration is idempotent on the live DB and correct for
-- fresh installs.
--
-- Default 'PACKAGING'; rows already re-categorised via direct SQL (BOTTLE, CAP,
-- INDUCTION_SEAL, PVC_ROLL, FOIL_ROLL set to MATERIAL). Admins can change the
-- category per item via the Packaging & Materials settings page.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'packaging_item_category') THEN
    CREATE TYPE "packaging_item_category" AS ENUM ('MATERIAL', 'PACKAGING');
  END IF;
END $$;

ALTER TABLE "packaging_materials"
  ADD COLUMN IF NOT EXISTS "category" "packaging_item_category" NOT NULL DEFAULT 'PACKAGING';
