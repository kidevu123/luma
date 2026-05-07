-- Phase H.x3.6 — Raw bag allocation ledger + variety-pack components.
--
-- Adds three tables that turn an inventory_bag from a single-shot
-- "consumed" into a balance ledger:
--
--   • raw_bag_allocation_sessions  — one production use of a bag.
--     A single inventory_bag can have many sessions over its life
--     (card production for a few hours, returned, reopened later
--     for a different product). Each session has open/close lifecycle.
--
--   • raw_bag_allocation_events    — append-only ledger. Every
--     OPENED / ALLOCATED / RETURNED / DEPLETED / REWEIGHED /
--     ADJUSTED / VOIDED action is one row. The bag's current
--     balance is computed from the event stream.
--
--   • product_component_requirements — variety-pack BOM at the raw
--     component level. Says "this product needs 5 of flavor A and
--     5 of flavor B per finished unit." Reuses the items registry
--     from H.x0.5 so future raw kinds work without a migration.
--
-- No materialized read models in this phase. The data scale is small
-- (dozens of bags per PO, hundreds of events per bag at most), so the
-- derive helpers compute balance on demand from the event log. A
-- future phase can materialize if performance becomes a concern.

-- ── 1. raw_bag_allocation_sessions ────────────────────────────────
CREATE TABLE IF NOT EXISTS "raw_bag_allocation_sessions" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "inventory_bag_id"         uuid NOT NULL REFERENCES "inventory_bags"("id") ON DELETE CASCADE,
  "po_id"                    uuid REFERENCES "purchase_orders"("id") ON DELETE SET NULL,
  "workflow_bag_id"          uuid REFERENCES "workflow_bags"("id") ON DELETE SET NULL,
  "product_id"               uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "route_id"                 uuid REFERENCES "production_routes"("id") ON DELETE SET NULL,
  "finished_lot_id"          uuid REFERENCES "finished_lots"("id") ON DELETE SET NULL,
  -- For variety packs: which slot is this bag filling?
  --   PRIMARY | FLAVOR_A | FLAVOR_B | FLAVOR_C | COMPONENT | SECONDARY
  "component_role"           text,
  "allocation_status"        text NOT NULL,
  "opened_at"                timestamptz NOT NULL DEFAULT now(),
  "closed_at"                timestamptz,
  "opened_by_user_id"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "closed_by_user_id"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "starting_balance_qty"     integer,
  "starting_balance_source"  text,
  "ending_balance_qty"       integer,
  "ending_balance_source"    text,
  "consumed_qty"             integer,
  "consumed_qty_source"      text,
  "unit_of_measure"          text NOT NULL DEFAULT 'tablets',
  "confidence"               text NOT NULL DEFAULT 'LOW',
  "notes"                    text,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rba_sessions_status_check" CHECK (
    "allocation_status" IN ('OPEN','CLOSED','RETURNED_TO_STOCK','DEPLETED','VOIDED')
  ),
  CONSTRAINT "rba_sessions_qty_signs" CHECK (
    ("starting_balance_qty" IS NULL OR "starting_balance_qty" >= 0)
    AND ("ending_balance_qty" IS NULL OR "ending_balance_qty" >= 0)
    AND ("consumed_qty" IS NULL OR "consumed_qty" >= 0)
  )
);

CREATE INDEX IF NOT EXISTS "rba_sessions_bag_idx"
  ON "raw_bag_allocation_sessions" ("inventory_bag_id", "opened_at");
CREATE INDEX IF NOT EXISTS "rba_sessions_po_idx"
  ON "raw_bag_allocation_sessions" ("po_id");
CREATE INDEX IF NOT EXISTS "rba_sessions_product_idx"
  ON "raw_bag_allocation_sessions" ("product_id", "allocation_status");
CREATE INDEX IF NOT EXISTS "rba_sessions_workflow_idx"
  ON "raw_bag_allocation_sessions" ("workflow_bag_id");
-- Refuse to have two simultaneously OPEN sessions on the same bag —
-- a bag at any moment has one open allocation. Closing the prior is
-- the precondition for opening a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "rba_sessions_one_open_per_bag"
  ON "raw_bag_allocation_sessions" ("inventory_bag_id")
  WHERE "allocation_status" = 'OPEN';

-- ── 2. raw_bag_allocation_events ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "raw_bag_allocation_events" (
  "id"                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "allocation_session_id"    uuid REFERENCES "raw_bag_allocation_sessions"("id") ON DELETE CASCADE,
  "inventory_bag_id"         uuid NOT NULL REFERENCES "inventory_bags"("id") ON DELETE CASCADE,
  "workflow_bag_id"          uuid REFERENCES "workflow_bags"("id") ON DELETE SET NULL,
  "po_id"                    uuid REFERENCES "purchase_orders"("id") ON DELETE SET NULL,
  "product_id"               uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "route_id"                 uuid REFERENCES "production_routes"("id") ON DELETE SET NULL,
  "finished_lot_id"          uuid REFERENCES "finished_lots"("id") ON DELETE SET NULL,
  "event_type"               text NOT NULL,
  "quantity"                 numeric(20, 6),
  "unit_of_measure"          text NOT NULL DEFAULT 'tablets',
  -- VENDOR_DECLARED | RECEIVED_WEIGHT_ESTIMATE | MACHINE_COUNTER
  -- | FINISHED_LOT_INPUT | MANUAL_ENTRY | WEIGH_BACK | ESTIMATED | UNKNOWN
  "quantity_source"          text,
  "actor_user_id"            uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "occurred_at"              timestamptz NOT NULL DEFAULT now(),
  "payload"                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "confidence"               text NOT NULL DEFAULT 'MEDIUM',
  "missing_inputs"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  "client_event_id"          uuid,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rba_events_type_check" CHECK (
    "event_type" IN (
      'RAW_BAG_OPENED',
      'RAW_BAG_ALLOCATED',
      'RAW_BAG_RETURNED_TO_STOCK',
      'RAW_BAG_PARTIAL_CONSUMED',
      'RAW_BAG_DEPLETED',
      'RAW_BAG_REWEIGHED',
      'RAW_BAG_ADJUSTED',
      'RAW_BAG_VOIDED'
    )
  )
);

CREATE INDEX IF NOT EXISTS "rba_events_bag_idx"
  ON "raw_bag_allocation_events" ("inventory_bag_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "rba_events_session_idx"
  ON "raw_bag_allocation_events" ("allocation_session_id");
CREATE INDEX IF NOT EXISTS "rba_events_po_idx"
  ON "raw_bag_allocation_events" ("po_id");
CREATE INDEX IF NOT EXISTS "rba_events_product_idx"
  ON "raw_bag_allocation_events" ("product_id");
CREATE INDEX IF NOT EXISTS "rba_events_finished_lot_idx"
  ON "raw_bag_allocation_events" ("finished_lot_id");
CREATE INDEX IF NOT EXISTS "rba_events_type_idx"
  ON "raw_bag_allocation_events" ("event_type", "occurred_at");
-- Idempotency: floor PWA generates a UUID before fire-and-retry.
CREATE UNIQUE INDEX IF NOT EXISTS "rba_events_client_event_id_unique"
  ON "raw_bag_allocation_events" ("inventory_bag_id", "event_type", "client_event_id")
  WHERE "client_event_id" IS NOT NULL;

-- ── 3. product_component_requirements ─────────────────────────────
CREATE TABLE IF NOT EXISTS "product_component_requirements" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"                  uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "route_id"                    uuid REFERENCES "production_routes"("id") ON DELETE SET NULL,
  "component_item_id"           uuid NOT NULL REFERENCES "items"("id") ON DELETE RESTRICT,
  -- Slot label: PRIMARY | FLAVOR_A | FLAVOR_B | FLAVOR_C | COMPONENT | SECONDARY
  -- Free-text so the variety pack model isn't locked to today's labels.
  "component_role"              text NOT NULL,
  "quantity_per_finished_unit"  numeric(20, 6) NOT NULL,
  "unit_of_measure"             text NOT NULL,
  "effective_from"              date NOT NULL DEFAULT CURRENT_DATE,
  "effective_to"                date,
  "is_active"                   boolean NOT NULL DEFAULT true,
  "notes"                       text,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pcr_qty_positive" CHECK ("quantity_per_finished_unit" > 0),
  CONSTRAINT "pcr_effective_window" CHECK (
    "effective_to" IS NULL OR "effective_to" >= "effective_from"
  )
);

CREATE INDEX IF NOT EXISTS "pcr_product_idx"
  ON "product_component_requirements" ("product_id", "is_active");
CREATE INDEX IF NOT EXISTS "pcr_component_idx"
  ON "product_component_requirements" ("component_item_id");
-- Only one active row per (product, route, component, role).
CREATE UNIQUE INDEX IF NOT EXISTS "pcr_active_unique"
  ON "product_component_requirements" ("product_id", "route_id", "component_item_id", "component_role")
  WHERE "is_active" = true AND "effective_to" IS NULL;
