-- 0041 — Add BLISTER_CARD packaging material kind and reclassify existing items.
--
-- BLISTER_FOIL was incorrectly used for printed blister cards (product-specific
-- packaging items like "4ct Choco Drift Blister Card"). These are PACKAGING,
-- not raw material foil. Actual foil rolls should use PVC_ROLL or FOIL_ROLL.
--
-- All 11 existing BLISTER_FOIL rows are blister cards; this migration moves
-- them to the new BLISTER_CARD kind. BLISTER_FOIL stays in the enum for
-- legacy compat but will not appear in the admin create form.
--
-- NOTE: The DB already has BLISTER_CARD added and items reclassified via
-- direct SQL (before this migration was formalized). The ALTER and UPDATE
-- are idempotent with IF NOT EXISTS / WHERE guards.

ALTER TYPE "packaging_material_kind" ADD VALUE IF NOT EXISTS 'BLISTER_CARD';
