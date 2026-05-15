-- COMMERCIAL-TRACE-2 (a) — extend zoho_sync_kind enum with INVOICES.
--
-- Standalone migration. Drizzle's pg migrator runs each .sql in its own
-- transaction; Postgres requires ALTER TYPE ADD VALUE to commit before
-- the new value is usable by other statements. Splitting this enum-add
-- into its own file is the only safe way to introduce a new enum value
-- alongside tables that reference it.
--
-- Once this migration is applied, future zoho_sync_runs rows can use
-- sync_type = 'INVOICES'. This phase does NOT trigger any sync runs —
-- the value is added in preparation for COMMERCIAL-TRACE-3.

ALTER TYPE "zoho_sync_kind" ADD VALUE IF NOT EXISTS 'INVOICES';
