-- WAREHOUSE-RESOLUTION-v1.3.0 — per-product Zoho warehouse override.
--
-- Adds one additive column on products: an optional Zoho warehouse_id
-- that takes precedence over the app-level default in zoho_credentials
-- but yields to an explicit operator pick on the production-output
-- preview form.
--
-- Resolution order at preview time (see lib/zoho/warehouse-resolution.ts):
--   1. operator explicit pick on the preview form
--   2. products.zoho_default_warehouse_id          (this column)
--   3. zoho_credentials.warehouse_id               (app-level default)
--   4. ZOHO_WAREHOUSE_ID env var                   (fallback only)
--   5. block with a clear operator-actionable message
--
-- Additive only. NULL on every existing row — products without an
-- override fall through to the app-level default. Plain text; no
-- length cap because Zoho warehouse_ids are short numeric strings
-- (~12 chars) and we do not want to silently truncate operator input.

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "zoho_default_warehouse_id" text;
