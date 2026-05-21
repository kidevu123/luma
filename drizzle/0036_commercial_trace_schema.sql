-- COMMERCIAL-TRACE-2 (b) — schema for Zoho invoice ingest + finished-lot
-- allocation. Additive only. No engine, no live Zoho calls, no UI.
--
-- The hinge this migration establishes:
--   invoice number → invoice line → product/SKU/Zoho item → finished lot(s)
--   → shipment_finished_lot → recall passport
--
-- Three new tables and two new columns on shipment_finished_lots. The
-- shape mirrors docs/COMMERCIAL_TRACEABILITY_PLAN.md §10.1.
--
-- Visibility note (owner decision 2026-05-15): supplier_lot, internal
-- receipt number, raw bag QR, operator names, and machine/station
-- accountability detail are CSR-only. Customer-scope queries built on
-- top of these tables MUST filter those fields out at the API edge.
-- See lib/production/commercial-trace.ts for the policy helpers.

-- ─────────────────────────────────────────────────────────────────────
-- 1) zoho_invoices — invoice header.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "zoho_invoices" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- External Zoho identifier (text), unique. Source of truth for "this is
  -- the same invoice across sync runs".
  "zoho_invoice_id"     text        NOT NULL,
  "invoice_number"      text        NOT NULL,
  "zoho_customer_id"    text,
  "customer_id"         uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "invoice_date"        date,
  "status"              text,
  "currency"            text,
  "subtotal"            numeric(20, 4),
  "total"               numeric(20, 4),
  "balance"             numeric(20, 4),
  -- Verbatim Zoho payload — kept for replay + audit. Defaults to '{}' so
  -- legacy inserts without a payload still satisfy NOT NULL.
  "raw_payload"         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "last_seen_at"        timestamptz,
  "last_synced_at"      timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_invoices_zoho_invoice_id_unique"
  ON "zoho_invoices" ("zoho_invoice_id");

CREATE INDEX IF NOT EXISTS "zoho_invoices_invoice_number_idx"
  ON "zoho_invoices" ("invoice_number");

CREATE INDEX IF NOT EXISTS "zoho_invoices_zoho_customer_id_idx"
  ON "zoho_invoices" ("zoho_customer_id")
  WHERE "zoho_customer_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "zoho_invoices_customer_id_idx"
  ON "zoho_invoices" ("customer_id")
  WHERE "customer_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "zoho_invoices_invoice_date_idx"
  ON "zoho_invoices" ("invoice_date" DESC)
  WHERE "invoice_date" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "zoho_invoices_status_idx"
  ON "zoho_invoices" ("status")
  WHERE "status" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2) zoho_invoice_lines — invoice line items.
-- ─────────────────────────────────────────────────────────────────────
-- Note: column name `zoho_invoice_id` here is a UUID FK to
-- zoho_invoices(id), distinct from zoho_invoices.zoho_invoice_id which
-- is the text external Zoho identifier. Following the user spec
-- verbatim; future readers should JOIN to the parent for the text id.
CREATE TABLE IF NOT EXISTS "zoho_invoice_lines" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "zoho_invoice_id"       uuid NOT NULL REFERENCES "zoho_invoices"("id") ON DELETE CASCADE,
  -- Zoho's line-item identifier. Nullable for legacy/manually-imported
  -- invoices that pre-date the line-id field.
  "zoho_invoice_line_id"  text,
  "zoho_item_id"          text,
  "sku"                   text,
  "item_name"             text NOT NULL,
  "description"           text,
  "quantity"              numeric(20, 6) NOT NULL,
  "unit"                  text,
  "rate"                  numeric(20, 6),
  "amount"                numeric(20, 4),
  "raw_payload"           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_invoice_idx"
  ON "zoho_invoice_lines" ("zoho_invoice_id");

CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_line_id_idx"
  ON "zoho_invoice_lines" ("zoho_invoice_line_id")
  WHERE "zoho_invoice_line_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_item_id_idx"
  ON "zoho_invoice_lines" ("zoho_item_id")
  WHERE "zoho_item_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_sku_idx"
  ON "zoho_invoice_lines" ("sku")
  WHERE "sku" IS NOT NULL;

-- Idempotency for sync upserts: when Zoho returns a line-id, the pair
-- (parent invoice, line-id) is unique. Partial unique index so legacy
-- rows without a line-id are tolerated.
CREATE UNIQUE INDEX IF NOT EXISTS "zoho_invoice_lines_invoice_line_id_unique"
  ON "zoho_invoice_lines" ("zoho_invoice_id", "zoho_invoice_line_id")
  WHERE "zoho_invoice_line_id" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 3) finished_lot_invoice_allocations — many-to-many between invoice
--    lines and finished lots.
-- ─────────────────────────────────────────────────────────────────────
-- One invoice line can allocate across multiple finished lots; one
-- finished lot can allocate to multiple invoice lines. quantity_allocated
-- is enforced positive via a CHECK constraint; sum-equals-line-quantity
-- is a soft engine-side check (Zoho-side quantity changes happen).
--
-- confidence: HIGH / MEDIUM / LOW / MISSING (free-text in DB so the
-- vocabulary can extend without a migration; see commercial-trace.ts).
-- status:     SUGGESTED / CONFIRMED / REJECTED / NEEDS_REVIEW.
-- source:     free-text — 'PACK_OUT_SCAN', 'ENGINE_SHIPMENT', 'MANUAL',
--             'ZOHO_IMPORT', etc.
CREATE TABLE IF NOT EXISTS "finished_lot_invoice_allocations" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoice_line_id"             uuid NOT NULL REFERENCES "zoho_invoice_lines"("id") ON DELETE CASCADE,
  "finished_lot_id"             uuid NOT NULL REFERENCES "finished_lots"("id") ON DELETE CASCADE,
  "shipment_finished_lot_id"    uuid REFERENCES "shipment_finished_lots"("id") ON DELETE SET NULL,
  "quantity_allocated"          numeric(20, 6) NOT NULL,
  "unit"                        text,
  "confidence"                  text NOT NULL,
  "source"                      text NOT NULL,
  "status"                      text NOT NULL DEFAULT 'SUGGESTED',
  "confirmed"                   boolean NOT NULL DEFAULT false,
  "confirmed_by_user_id"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "confirmed_at"                timestamptz,
  "notes"                       text,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "finished_lot_invoice_allocations_quantity_positive"
    CHECK ("quantity_allocated" > 0)
);

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_line_idx"
  ON "finished_lot_invoice_allocations" ("invoice_line_id");

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_lot_idx"
  ON "finished_lot_invoice_allocations" ("finished_lot_id");

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_shipment_lot_idx"
  ON "finished_lot_invoice_allocations" ("shipment_finished_lot_id")
  WHERE "shipment_finished_lot_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_confidence_idx"
  ON "finished_lot_invoice_allocations" ("confidence");

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_source_idx"
  ON "finished_lot_invoice_allocations" ("source");

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_status_idx"
  ON "finished_lot_invoice_allocations" ("status");

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_confirmed_idx"
  ON "finished_lot_invoice_allocations" ("confirmed");

CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_confirmed_at_idx"
  ON "finished_lot_invoice_allocations" ("confirmed_at" DESC)
  WHERE "confirmed_at" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4) shipment_finished_lots — allocation-status columns.
-- ─────────────────────────────────────────────────────────────────────
-- ALTER … ADD COLUMN IF NOT EXISTS is the only safe pattern for this
-- migration to remain idempotent across reruns.
ALTER TABLE "shipment_finished_lots"
  ADD COLUMN IF NOT EXISTS "invoice_allocation_status" text NOT NULL DEFAULT 'UNALLOCATED';

ALTER TABLE "shipment_finished_lots"
  ADD COLUMN IF NOT EXISTS "last_invoice_allocation_at" timestamptz;

CREATE INDEX IF NOT EXISTS "shipment_finished_lots_invoice_allocation_status_idx"
  ON "shipment_finished_lots" ("invoice_allocation_status");

CREATE INDEX IF NOT EXISTS "shipment_finished_lots_last_invoice_allocation_at_idx"
  ON "shipment_finished_lots" ("last_invoice_allocation_at" DESC)
  WHERE "last_invoice_allocation_at" IS NOT NULL;
