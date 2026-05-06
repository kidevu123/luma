-- TabletTracker → Luma import support tables.
--
-- legacy_tt_id_map: integer-PK → UUID translation. Every row the
-- importer creates in a Luma table also gets a row here keyed by
-- (tt_table, tt_id) → (luma_table, luma_id). Lets us walk legacy FKs
-- and rewrite them as we go, AND makes the importer idempotent: a
-- re-run skips any (tt_table, tt_id) pair that already exists.
--
-- legacy_*: stash tables for legacy rows that don't have a clean Luma
-- target yet. We preserve them verbatim so historical reporting
-- queries still work and so a Phase 2 synthesizer (which converts
-- warehouse_submissions / machine_counts into Luma workflow_events)
-- has the source data to draw from.
--
-- legacy_import_runs already tracks fetch attempts; we extend its
-- semantics to also record import attempts via the new column
-- triggered_by enum value 'IMPORT' (CHECK relaxation).

-- ── ID translation ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legacy_tt_id_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_table    text NOT NULL,
  tt_id       integer NOT NULL,
  luma_table  text NOT NULL,
  luma_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_tt_id_map_source_unique
  ON legacy_tt_id_map (tt_table, tt_id);

CREATE INDEX IF NOT EXISTS legacy_tt_id_map_luma_idx
  ON legacy_tt_id_map (luma_table, luma_id);

-- ── Stash tables (legacy rows preserved verbatim) ──────────────────

CREATE TABLE IF NOT EXISTS legacy_warehouse_submissions (
  -- Surrogate UUID PK. legacy_tt_id_map maps the TT id → this id.
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id             integer NOT NULL UNIQUE,
  -- Wide row preserved as JSON to avoid schema drift hell — TT's
  -- warehouse_submissions has 30+ nullable columns most of which
  -- only matter for one of the five submission_types. JSON keeps
  -- everything readable without 30 NULL columns on Luma side.
  payload           jsonb NOT NULL,
  submission_type   text,
  bag_id            uuid REFERENCES inventory_bags(id),
  workflow_bag_id   uuid REFERENCES workflow_bags(id),
  employee_name     text,
  created_at        timestamptz
);

CREATE INDEX IF NOT EXISTS legacy_ws_bag_idx
  ON legacy_warehouse_submissions (bag_id);
CREATE INDEX IF NOT EXISTS legacy_ws_wfb_idx
  ON legacy_warehouse_submissions (workflow_bag_id);
CREATE INDEX IF NOT EXISTS legacy_ws_type_idx
  ON legacy_warehouse_submissions (submission_type);

CREATE TABLE IF NOT EXISTS legacy_machine_counts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id           integer NOT NULL UNIQUE,
  payload         jsonb NOT NULL,
  tablet_type_id  uuid REFERENCES tablet_types(id),
  machine_id      uuid REFERENCES machines(id),
  employee_name   text,
  count_date      date,
  created_at      timestamptz
);

CREATE INDEX IF NOT EXISTS legacy_mc_tt_idx
  ON legacy_machine_counts (tablet_type_id);
CREATE INDEX IF NOT EXISTS legacy_mc_machine_idx
  ON legacy_machine_counts (machine_id);
CREATE INDEX IF NOT EXISTS legacy_mc_date_idx
  ON legacy_machine_counts (count_date);

CREATE TABLE IF NOT EXISTS legacy_submission_bag_deductions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id                       integer NOT NULL UNIQUE,
  legacy_submission_id        uuid NOT NULL
                                  REFERENCES legacy_warehouse_submissions(id) ON DELETE CASCADE,
  bag_id                      uuid REFERENCES inventory_bags(id),
  tablets_deducted            integer NOT NULL,
  created_at                  timestamptz
);

CREATE INDEX IF NOT EXISTS legacy_sbd_submission_idx
  ON legacy_submission_bag_deductions (legacy_submission_id);
CREATE INDEX IF NOT EXISTS legacy_sbd_bag_idx
  ON legacy_submission_bag_deductions (bag_id);

CREATE TABLE IF NOT EXISTS legacy_blister_rolls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id               integer NOT NULL UNIQUE,
  machine_id          uuid REFERENCES machines(id),
  material_type       text NOT NULL,
  roll_code           text NOT NULL,
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  start_press_count   double precision NOT NULL DEFAULT 0,
  end_press_count     double precision,
  blisters_per_press  integer NOT NULL DEFAULT 1,
  total_blisters      double precision,
  status              text NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS legacy_blister_rolls_machine_idx
  ON legacy_blister_rolls (machine_id);
CREATE INDEX IF NOT EXISTS legacy_blister_rolls_status_idx
  ON legacy_blister_rolls (status);

CREATE TABLE IF NOT EXISTS legacy_compressors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id           integer NOT NULL UNIQUE,
  compressor_name text NOT NULL,
  status          text NOT NULL DEFAULT 'working',
  machine_id      uuid REFERENCES machines(id),
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  cost            double precision,
  tank_size       text,
  created_at      timestamptz,
  updated_at      timestamptz
);

CREATE INDEX IF NOT EXISTS legacy_compressors_machine_idx
  ON legacy_compressors (machine_id);

CREATE TABLE IF NOT EXISTS legacy_po_damage_closeout (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id                         integer NOT NULL UNIQUE,
  po_id                         uuid REFERENCES purchase_orders(id),
  po_line_id                    uuid REFERENCES po_lines(id),
  inventory_item_id             text,
  damage_weight_kg              double precision,
  estimated_damaged_tablets     integer,
  grams_per_tablet              double precision,
  weight_missing                boolean NOT NULL DEFAULT false,
  weight_source                 text,
  updated_by                    text,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_po_damage_po_idx
  ON legacy_po_damage_closeout (po_id);

CREATE TABLE IF NOT EXISTS legacy_app_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tt_id           integer NOT NULL UNIQUE,
  setting_key     text NOT NULL,
  setting_value   text NOT NULL,
  description     text,
  updated_at      timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_app_settings_key_unique
  ON legacy_app_settings (setting_key);
