-- LOT-1B — Finished Lot / Recall Passport schema + receiving bridge.
--
-- Additive only. Six new tables + three small column extensions.
-- See docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md (LOT-1A) for the
-- motivation behind every choice in this migration.
--
-- Naming carries the same conventions as the rest of the codebase:
--   - snake_case columns
--   - uuid primary keys defaulted to gen_random_uuid()
--   - timestamptz timestamps (kept distinct from "date" columns)
--   - IF NOT EXISTS on everything so a replay is a no-op
--
-- Backwards-compat rules (per LOT-1A §2 and the LOT-1B prompt):
--   - inventory_bags new columns are nullable. Legacy bags stay valid.
--     bag_qr_code is the Luma-issued raw-bag identifier, distinct
--     from the manufacturer's printed vendor_barcode and distinct
--     from qr_cards.scan_token (which is a production badge, not a
--     raw-bag identifier).
--   - finished_lots.trace_code is the customer-facing printed code.
--     trace_code is unique system-wide. finished_lot_code_alias is
--     an optional secondary code for customer-specific labelling.
--   - All new finished_lot_* tables are projection-friendly:
--     finished_lot_raw_bags is source of truth; the others can be
--     rebuilt by LOT-1C without losing history (no ON DELETE CASCADE
--     from the finished_lots side for finished_lot_raw_bags — we
--     keep the bag link if a finished lot is somehow deleted... or
--     do we? The plan calls for CASCADE: a finished lot's children
--     don't outlive it. We follow the plan).

-- ── 1. customers ───────────────────────────────────────────────────
--
-- Intentionally minimal. Full customer master (addresses, terms, etc.)
-- belongs in Nexus; Luma stores only what's needed to answer "which
-- customer received this finished lot?" and to route Nexus-bound
-- payloads.
--
-- supplier_lot_visible controls whether outbound payloads (LOT-1F)
-- include the manufacturer's supplier_lot_number — default off, can
-- be flipped per-customer when a customer explicitly requires it.

CREATE TABLE IF NOT EXISTS "customers" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_code"         text NOT NULL UNIQUE,
  "name"                  text NOT NULL,
  "zoho_customer_id"      text,
  "nexus_customer_id"     text,
  "supplier_lot_visible"  boolean NOT NULL DEFAULT false,
  "active"                boolean NOT NULL DEFAULT true,
  "notes"                 text,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "customers_zoho_idx"
  ON "customers" ("zoho_customer_id")
  WHERE "zoho_customer_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "customers_nexus_idx"
  ON "customers" ("nexus_customer_id")
  WHERE "nexus_customer_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "customers_active_idx"
  ON "customers" ("active")
  WHERE "active" = true;

-- ── 2. inventory_bags extensions ───────────────────────────────────

ALTER TABLE "inventory_bags"
  ADD COLUMN IF NOT EXISTS "bag_qr_code"             text,
  ADD COLUMN IF NOT EXISTS "internal_receipt_number" text,
  ADD COLUMN IF NOT EXISTS "declared_pill_count"     integer;

-- bag_qr_code is the Luma-issued QR string printed at intake. Unique
-- when set; nullable so legacy / pre-LOT-1B rows stay valid.
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_bags_bag_qr_code_unique"
  ON "inventory_bags" ("bag_qr_code")
  WHERE "bag_qr_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inventory_bags_internal_receipt_idx"
  ON "inventory_bags" ("internal_receipt_number")
  WHERE "internal_receipt_number" IS NOT NULL;

-- ── 3. finished_lots extensions ────────────────────────────────────

ALTER TABLE "finished_lots"
  ADD COLUMN IF NOT EXISTS "trace_code"               text,
  ADD COLUMN IF NOT EXISTS "packed_at"                timestamptz,
  ADD COLUMN IF NOT EXISTS "expires_at"               timestamptz,
  ADD COLUMN IF NOT EXISTS "finished_lot_code_alias"  text;

-- trace_code is the customer-facing printed code. Unique when set.
-- For lots produced before LOT-1B, trace_code is null until LOT-1C's
-- projector backfills.
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lots_trace_code_unique"
  ON "finished_lots" ("trace_code")
  WHERE "trace_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "finished_lots_alias_idx"
  ON "finished_lots" ("finished_lot_code_alias")
  WHERE "finished_lot_code_alias" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "finished_lots_packed_at_idx"
  ON "finished_lots" ("packed_at")
  WHERE "packed_at" IS NOT NULL;

-- ── 4. finished_lot_raw_bags ───────────────────────────────────────
--
-- Bag-level M:N. The existing finished_lot_inputs links to a batch;
-- this resolves one level deeper to the individual inventory_bag.
-- That matters when a batch contained N raw bags and only some of
-- them went into a particular finished lot.
--
-- (finished_lot_id, inventory_bag_id, workflow_bag_id) is the
-- intended unique key. workflow_bag_id is nullable for legacy /
-- inferred rows; the unique constraint uses NULLS NOT DISTINCT so a
-- (lot, bag, null) duplicate is still caught.

CREATE TABLE IF NOT EXISTS "finished_lot_raw_bags" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "finished_lot_id"          uuid NOT NULL REFERENCES "finished_lots"("id") ON DELETE CASCADE,
  "inventory_bag_id"         uuid NOT NULL REFERENCES "inventory_bags"("id") ON DELETE RESTRICT,
  "workflow_bag_id"          uuid REFERENCES "workflow_bags"("id") ON DELETE SET NULL,
  -- Quantity reconciliation. NULL when only existence is known.
  "quantity_consumed_pills"  integer,
  "quantity_consumed_weight" numeric(20, 6),
  "weight_unit"              text, -- 'g' typically
  -- Confidence ladder consistent with PT-6 / PT-7 / PBOM:
  --   HIGH    direct RAW_CONSUMED-style event link
  --   MEDIUM  inferred from workflow_bag → finished_lot chain
  --   LOW     legacy / batch-level inference downgraded one notch
  --   MISSING no chain — flagged for operator review
  "confidence"               text NOT NULL CHECK ("confidence" IN ('HIGH','MEDIUM','LOW','MISSING')),
  -- Provenance — which projector / process emitted this link.
  --   'PROJECTOR'       — LOT-1C event-driven projector
  --   'BACKFILL'        — LOT-1C historical replay
  --   'MANUAL'          — operator-entered correction
  --   'LEGACY_IMPORT'   — synthesized from finished_lot_inputs at batch level
  "source"                   text NOT NULL CHECK ("source" IN ('PROJECTOR','BACKFILL','MANUAL','LEGACY_IMPORT')),
  "derived_from_event_id"    uuid REFERENCES "workflow_events"("id") ON DELETE SET NULL,
  "notes"                    text,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);

-- Catch (lot, bag) duplicates even when workflow_bag_id varies — we
-- never want two PROJECTOR-emitted rows for the same triple, but a
-- (lot, bag, A) and (lot, bag, B) pair IS legitimate when a bag is
-- split across workflow bags. So the unique covers all three.
-- NULLS NOT DISTINCT (Postgres 15+) makes a (lot, bag, NULL) row
-- collide with another (lot, bag, NULL) — preventing duplicate
-- legacy inferences for the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_raw_bags_triple_unique"
  ON "finished_lot_raw_bags" ("finished_lot_id", "inventory_bag_id", "workflow_bag_id")
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_lot_idx"
  ON "finished_lot_raw_bags" ("finished_lot_id");
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_bag_idx"
  ON "finished_lot_raw_bags" ("inventory_bag_id");
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_workflow_idx"
  ON "finished_lot_raw_bags" ("workflow_bag_id")
  WHERE "workflow_bag_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_confidence_idx"
  ON "finished_lot_raw_bags" ("confidence");

-- ── 5. finished_lot_outputs ────────────────────────────────────────
--
-- Per physical output (display / master case / pallet / loose unit /
-- other). finished_lots already carries display_count + cases_produced
-- totals; this table is one row per *output instance* with the
-- print payload that was actually placed on the carton.

CREATE TABLE IF NOT EXISTS "finished_lot_outputs" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "finished_lot_id"       uuid NOT NULL REFERENCES "finished_lots"("id") ON DELETE CASCADE,
  "output_type"           text NOT NULL CHECK ("output_type" IN ('DISPLAY','MASTER_CASE','LOOSE_UNIT','PALLET','OTHER')),
  "quantity"              integer NOT NULL,
  "unit"                  text NOT NULL DEFAULT 'each',
  -- The literal code printed on the carton — typically equals the
  -- finished_lot.trace_code but may differ when a customer alias is
  -- printed instead. Stored so an investigator can reconstruct what
  -- the customer would have seen.
  "trace_code_printed"    text,
  -- Snapshot of everything stamped onto the carton (product, packed
  -- date, expires, count, customer-alias overrides, etc.) so the
  -- recall passport can answer "what did the label say" without
  -- depending on the carton being available.
  "print_payload"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "finished_lot_outputs_lot_idx"
  ON "finished_lot_outputs" ("finished_lot_id");
CREATE INDEX IF NOT EXISTS "finished_lot_outputs_type_idx"
  ON "finished_lot_outputs" ("output_type");
CREATE INDEX IF NOT EXISTS "finished_lot_outputs_trace_printed_idx"
  ON "finished_lot_outputs" ("trace_code_printed")
  WHERE "trace_code_printed" IS NOT NULL;

-- ── 6. finished_lot_packaging_lots ─────────────────────────────────
--
-- Projection. Source of truth for packaging consumption is
-- material_inventory_events; LOT-1C will replay those events scoped
-- to contributing workflow_bags and aggregate here for fast recall.

CREATE TABLE IF NOT EXISTS "finished_lot_packaging_lots" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "finished_lot_id"     uuid NOT NULL REFERENCES "finished_lots"("id") ON DELETE CASCADE,
  "packaging_lot_id"    uuid NOT NULL REFERENCES "packaging_lots"("id") ON DELETE RESTRICT,
  "material_id"         uuid REFERENCES "packaging_materials"("id") ON DELETE SET NULL,
  "quantity_used"       numeric(20, 6),
  "unit"                text, -- 'each' or 'g'
  "confidence"          text NOT NULL CHECK ("confidence" IN ('HIGH','MEDIUM','LOW','MISSING')),
  "source"              text NOT NULL CHECK ("source" IN ('PROJECTOR','BACKFILL','MANUAL','LEGACY_IMPORT')),
  "first_used_at"       timestamptz,
  "last_used_at"        timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "finished_lot_packaging_lots_lot_idx"
  ON "finished_lot_packaging_lots" ("finished_lot_id");
CREATE INDEX IF NOT EXISTS "finished_lot_packaging_lots_lot_pkg_idx"
  ON "finished_lot_packaging_lots" ("packaging_lot_id");
CREATE INDEX IF NOT EXISTS "finished_lot_packaging_lots_material_idx"
  ON "finished_lot_packaging_lots" ("material_id")
  WHERE "material_id" IS NOT NULL;
-- At most one row per (finished_lot, packaging_lot). The projector
-- upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_packaging_lots_unique"
  ON "finished_lot_packaging_lots" ("finished_lot_id", "packaging_lot_id");

-- ── 7. finished_lot_qc_events ──────────────────────────────────────
--
-- Projection of the five QC event types (PACKAGING_DAMAGE_RETURN /
-- REWORK_SENT / REWORK_RECEIVED / SCRAP_RECORDED / SUBMISSION_CORRECTED)
-- pinned to the finished lot they end up affecting. LOT-1C's
-- BAG_FINALIZED projector populates this; the audit trail can also
-- be reconstructed by replaying workflow_events filtered to the
-- contributing workflow_bag_ids.

CREATE TABLE IF NOT EXISTS "finished_lot_qc_events" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "finished_lot_id"     uuid NOT NULL REFERENCES "finished_lots"("id") ON DELETE CASCADE,
  "workflow_event_id"   uuid NOT NULL REFERENCES "workflow_events"("id") ON DELETE CASCADE,
  "event_type"          text NOT NULL,
  "occurred_at"         timestamptz NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now()
);

-- At most one row per workflow_event per finished_lot. A workflow
-- event can in theory project into multiple finished lots (rare but
-- possible if a bag's output is split), so we key on the pair.
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_qc_events_pair_unique"
  ON "finished_lot_qc_events" ("finished_lot_id", "workflow_event_id");
CREATE INDEX IF NOT EXISTS "finished_lot_qc_events_lot_idx"
  ON "finished_lot_qc_events" ("finished_lot_id");
CREATE INDEX IF NOT EXISTS "finished_lot_qc_events_type_idx"
  ON "finished_lot_qc_events" ("event_type");
CREATE INDEX IF NOT EXISTS "finished_lot_qc_events_occurred_idx"
  ON "finished_lot_qc_events" ("occurred_at");

-- ── 8. shipments extension + shipment_finished_lots ────────────────

ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "shipments_customer_idx"
  ON "shipments" ("customer_id")
  WHERE "customer_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "shipment_finished_lots" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shipment_id"         uuid NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "finished_lot_id"     uuid NOT NULL REFERENCES "finished_lots"("id") ON DELETE RESTRICT,
  -- Denormalised customer_id for fast filtering — kept in sync with
  -- shipments.customer_id at insert time. Nullable for legacy /
  -- unrouted shipments.
  "customer_id"         uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "quantity"            integer,
  "unit"                text, -- 'displays' / 'cases' / 'loose' / 'pallets'
  "shipped_at"          timestamptz,
  "notes"               text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "shipment_finished_lots_shipment_idx"
  ON "shipment_finished_lots" ("shipment_id");
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_lot_idx"
  ON "shipment_finished_lots" ("finished_lot_id");
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_customer_idx"
  ON "shipment_finished_lots" ("customer_id")
  WHERE "customer_id" IS NOT NULL;
-- One shipment can carry one finished lot only once; the quantity
-- captures the split.
CREATE UNIQUE INDEX IF NOT EXISTS "shipment_finished_lots_pair_unique"
  ON "shipment_finished_lots" ("shipment_id", "finished_lot_id");
