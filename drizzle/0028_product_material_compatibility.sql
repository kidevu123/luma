-- PBOM-2 — Product ↔ packaging-material compatibility matrix.
--
-- Records which packaging materials are APPROVED for a given product
-- (+ optional route + scope + role). PBOM-1 filters dropdowns by
-- material KIND; PBOM-2 narrows further by product so Mango Peach
-- only ever sees Mango Peach-approved cards / displays / cases.
--
-- This table is the gating layer in front of product_packaging_specs:
-- savePackagingBomLineAction refuses to persist a BOM line whose
-- material isn't in the compatibility matrix for the chosen product /
-- route / scope.
--
-- No data is written by this migration. Admins author rows via the
-- new /settings/product-material-compatibility page; empty matrix =
-- empty dropdowns (we surface a "Compatibility missing" message
-- rather than silently fall back to "all materials").

CREATE TABLE IF NOT EXISTS "product_material_compatibility" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"           uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "route_id"             uuid REFERENCES "production_routes"("id") ON DELETE SET NULL,
  "material_id"          uuid NOT NULL REFERENCES "packaging_materials"("id") ON DELETE CASCADE,
  "scope"                text NOT NULL CHECK ("scope" IN ('UNIT','DISPLAY','CASE')),
  "compatibility_role"   text NOT NULL CHECK ("compatibility_role" IN (
    'CARD_MATERIAL','DISPLAY_BOX','MASTER_CASE',
    'BOTTLE','CAP','LABEL','INDUCTION_SEAL',
    'INSERT','SHRINK_BAND','OTHER'
  )),
  "required"             boolean NOT NULL DEFAULT false,
  "default_for_product"  boolean NOT NULL DEFAULT false,
  "active"               boolean NOT NULL DEFAULT true,
  "effective_from"       timestamptz NOT NULL DEFAULT now(),
  "effective_to"         timestamptz,
  "notes"                text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

-- Hot lookup path: BOM page queries "what materials are compatible
-- with product X at scope Y, active right now". Partial index keeps
-- the table cheap when most rows go inactive over time.
CREATE INDEX IF NOT EXISTS "product_material_compatibility_lookup_idx"
  ON "product_material_compatibility" ("product_id", "scope", "active")
  WHERE "active" = true;

-- One ACTIVE default per (product, route, scope, role) — used by the
-- BOM page to pre-select the dropdown. The partial-unique is keyed
-- on the columns that vary; a route_id of NULL is treated by
-- Postgres as distinct from any other NULL, so multiple
-- (product, NULL-route, scope, role) defaults are technically
-- possible — the server action enforces single-active-default at
-- the app layer for that case.
CREATE UNIQUE INDEX IF NOT EXISTS "product_material_compatibility_default_unique"
  ON "product_material_compatibility" ("product_id", "route_id", "scope", "compatibility_role")
  WHERE "default_for_product" = true AND "active" = true;

-- Prevent duplicate active rows for the same (product, route,
-- material, scope) — an admin shouldn't accidentally add the same
-- material twice for the same product/scope. Inactive rows are
-- allowed to coexist (audit / re-activation path).
CREATE UNIQUE INDEX IF NOT EXISTS "product_material_compatibility_no_dupe"
  ON "product_material_compatibility" ("product_id", "route_id", "material_id", "scope")
  WHERE "active" = true;

-- Fast filter by role at admin UI grouping time.
CREATE INDEX IF NOT EXISTS "product_material_compatibility_role_idx"
  ON "product_material_compatibility" ("compatibility_role");
