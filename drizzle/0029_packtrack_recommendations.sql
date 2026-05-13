-- PT-7C — PackTrack shortage recommendation read model.
--
-- Persists rows derived by lib/projector/packtrack-recommendations.ts
-- using the pure helpers from lib/production/packtrack-shortage.ts
-- (PT-7B). One row per (material × product-or-shared) — when a
-- material is shared across multiple compatible products the
-- projector emits a single material-wide row with product_id = NULL
-- and per-product context inside source_signals (per PT-7A §11.3).
--
-- No PackTrack API contact happens here. PT-7E adds the outbound
-- client; PT-7D adds the operator UI on /material-alerts.
--
-- Three new columns on packaging_materials supply the quantity-
-- formula knobs (min order quantity, safety buffer %, order
-- multiple). All nullable so existing rows stay valid; the PT-7B
-- helper applies sensible defaults when null.

ALTER TABLE "packaging_materials"
  ADD COLUMN IF NOT EXISTS "min_order_quantity"     numeric(20, 6),
  ADD COLUMN IF NOT EXISTS "safety_buffer_percent"  numeric(6, 2),
  ADD COLUMN IF NOT EXISTS "order_multiple"         numeric(20, 6);

CREATE TABLE IF NOT EXISTS "read_material_recommendations" (
  "id"                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable external identifier — once written this stays the same
  -- across rebuilds so PackTrack (PT-7E) can use it as the
  -- idempotency key without double-creating POs.
  "recommendation_id"             uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  "material_id"                   uuid NOT NULL REFERENCES "packaging_materials"("id") ON DELETE CASCADE,
  -- Denormalised so PackTrack-bound payloads don't need a join and
  -- /material-alerts can render with one query.
  "material_code"                 text NOT NULL,
  "material_name"                 text NOT NULL,

  "product_id"                    uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "product_name"                  text,
  "product_sku"                   text,
  "compatibility_role"            text,

  "current_on_hand"               numeric(20, 6),
  "accepted_inventory"            numeric(20, 6),
  "projected_demand"              numeric(20, 6),
  "projected_shortage_quantity"   numeric(20, 6),
  "recommended_order_quantity"    numeric(20, 6),

  "needed_by_date"                date,

  "confidence"                    text NOT NULL CHECK ("confidence" IN ('HIGH','MEDIUM','LOW','MISSING')),
  "severity"                      text NOT NULL CHECK ("severity"   IN ('CRITICAL','HIGH','MEDIUM','WATCH')),
  "reason"                        text NOT NULL,
  -- Typed signals exactly as PT-7B's deriveShortageSignals returns.
  -- jsonb (not json) so PostgreSQL keeps a single normalised form.
  "source_signals"                jsonb NOT NULL DEFAULT '[]'::jsonb,
  "missing_inputs"                jsonb NOT NULL DEFAULT '[]'::jsonb,
  "warnings"                      jsonb NOT NULL DEFAULT '[]'::jsonb,

  "sendable_to_packtrack"         boolean NOT NULL DEFAULT false,

  "generated_at"                  timestamptz NOT NULL,
  "expires_at"                    timestamptz,

  -- Operator state (preserved across rebuilds when present).
  "acknowledged_at"               timestamptz,
  "dismissed_at"                  timestamptz,
  -- PT-7E populates this if PackTrack rejects the payload.
  "last_send_error"               text,
  -- Audit link to the row this one replaced (rebuild-time supersede).
  "superseded_by"                 uuid REFERENCES "read_material_recommendations"("id") ON DELETE SET NULL,

  "recommended_supplier_hint"     text,

  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now()
);

-- Dedup: at most one ACTIVE recommendation per (material, product)
-- combination at a time. Acknowledged/dismissed rows are exempt so
-- audit history can pile up cleanly.
--
-- Two partial uniques are needed because Postgres treats every NULL
-- in a UNIQUE INDEX as distinct, so a single (material_id, product_id)
-- index would NOT enforce uniqueness across material-wide rows.
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_recommendations_active_product_unique"
  ON "read_material_recommendations" ("material_id", "product_id")
  WHERE "product_id" IS NOT NULL
    AND "acknowledged_at" IS NULL
    AND "dismissed_at" IS NULL
    AND "superseded_by" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "read_material_recommendations_active_material_unique"
  ON "read_material_recommendations" ("material_id")
  WHERE "product_id" IS NULL
    AND "acknowledged_at" IS NULL
    AND "dismissed_at" IS NULL
    AND "superseded_by" IS NULL;

-- Hot read paths.
CREATE INDEX IF NOT EXISTS "read_material_recommendations_material_idx"
  ON "read_material_recommendations" ("material_id");
CREATE INDEX IF NOT EXISTS "read_material_recommendations_product_idx"
  ON "read_material_recommendations" ("product_id")
  WHERE "product_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "read_material_recommendations_material_code_idx"
  ON "read_material_recommendations" ("material_code");
CREATE INDEX IF NOT EXISTS "read_material_recommendations_confidence_idx"
  ON "read_material_recommendations" ("confidence");
CREATE INDEX IF NOT EXISTS "read_material_recommendations_severity_idx"
  ON "read_material_recommendations" ("severity");
CREATE INDEX IF NOT EXISTS "read_material_recommendations_sendable_idx"
  ON "read_material_recommendations" ("sendable_to_packtrack")
  WHERE "sendable_to_packtrack" = true;
CREATE INDEX IF NOT EXISTS "read_material_recommendations_generated_idx"
  ON "read_material_recommendations" ("generated_at");
CREATE INDEX IF NOT EXISTS "read_material_recommendations_expires_idx"
  ON "read_material_recommendations" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
