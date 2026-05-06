-- Legacy-import fetcher schema. Singleton config per company holds the
-- PythonAnywhere API token; legacy_import_paths is 1:N for file specs;
-- legacy_import_runs is the audit history of fetch attempts.

CREATE TABLE IF NOT EXISTS legacy_import_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pa_username     text NOT NULL,
  pa_api_token    text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  last_sync_at    timestamptz,
  last_sync_ok    boolean,
  last_sync_error text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_id   uuid REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_import_config_company_unique
  ON legacy_import_config (company_id);

CREATE TABLE IF NOT EXISTS legacy_import_paths (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id         uuid NOT NULL REFERENCES legacy_import_config(id) ON DELETE CASCADE,
  remote_path       text NOT NULL,
  label             text NOT NULL,
  kind              text NOT NULL DEFAULT 'OTHER'
                       CHECK (kind IN ('DB_DUMP','ZOHO_CONFIG','OTHER')),
  enabled           boolean NOT NULL DEFAULT true,
  last_fetched_at   timestamptz,
  last_bytes        integer,
  last_status_code  integer,
  last_error        text,
  last_local_path   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_import_paths_remote_unique
  ON legacy_import_paths (config_id, remote_path);

CREATE INDEX IF NOT EXISTS legacy_import_paths_enabled_idx
  ON legacy_import_paths (config_id, enabled);

CREATE TABLE IF NOT EXISTS legacy_import_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id         uuid NOT NULL REFERENCES legacy_import_config(id) ON DELETE CASCADE,
  triggered_by      text NOT NULL CHECK (triggered_by IN ('MANUAL','SCHEDULED')),
  triggered_by_id   uuid REFERENCES users(id),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  ok                boolean,
  files_attempted   integer NOT NULL DEFAULT 0,
  files_succeeded   integer NOT NULL DEFAULT 0,
  summary           text
);

CREATE INDEX IF NOT EXISTS legacy_import_runs_started_idx
  ON legacy_import_runs (started_at);
